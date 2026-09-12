import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, errors } from "playwright"
import type { Browser, BrowserContext, Page } from "./browser-types.js"
import { errors as remoteErrors } from "patchright-core"
import type { ImportAdapter } from "./spreadsheet-adapter.js"
import { compare } from "./compare.js"
import { decodeUtf8, parseExport, RunError } from "./model.js"
import { differenceCount, writeReport, type CleanupRecord, type Report } from "./report.js"
import { Budget } from "./budget.js"

export const packageRoot = fileURLToPath(new URL("../", import.meta.url))
export interface FixtureHandle {
  url: string
  close(): Promise<void>
}
export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  headed?: boolean
  outputRoot?: string
  input: { csv: Buffer; expected: Buffer }
}
export interface Dependencies {
  importer?: Report["importer"]
  fixture(): Promise<FixtureHandle>
  browser(options: { headed: boolean; timeoutMs: number }): Promise<Browser>
  adapter: ImportAdapter
  backend?: "solari"
  ownsResources?: boolean
  signal?: AbortSignal
  guard?<T>(operation: () => Promise<T>, maximumMs?: number): Promise<T>
  beginCleanup?(): void
  cleanupCall?(operation: () => Promise<void>): Promise<void>
  finish?(): Promise<CleanupRecord[]>
  dispose?(): void
  configureContext?(context: BrowserContext): Promise<void>
  validateArtifact?(bytes: Buffer | string): void
  metadata?(): NonNullable<Report["solari"]>
}

// Browser subprocesses do not inherit service keys, profile cookies, proxy credentials, or NODE_OPTIONS.
export function browserEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export async function localBrowser({
  headed,
  timeoutMs,
}: {
  headed: boolean
  timeoutMs: number
}): Promise<Browser> {
  try {
    await access(chromium.executablePath())
  } catch {
    throw new RunError("BROWSER_NOT_INSTALLED")
  }
  return chromium.launch({ headless: !headed, timeout: timeoutMs, env: browserEnvironment() })
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

export async function runVerification(
  options: RunOptions,
  dependencies: Dependencies,
): Promise<{ report: Report; directory: string }> {
  const started = Date.now()
  const runId = randomUUID()
  const directory = join(options.outputRoot ?? join(packageRoot, "output", "playwright"), runId)
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    throw error instanceof RunError ? error : new RunError("OUTPUT_DIRECTORY_FAILED")
  }
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const report: Report = {
    schemaVersion: 2,
    runId,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    outcome: "INFRA_ERROR",
    environment: {
      backend: dependencies.backend ?? "local",
      node: process.version,
      browser: null,
      playwright: manifest.dependencies.playwright,
    },
    input: null,
    comparison: null,
    successMessage: null,
    steps: [],
    cleanup: [],
    error: null,
    artifacts: [],
    importer: dependencies.importer,
  }
  let stage = "preflight"
  const step = (name: string) => {
    stage = name
    report.steps.push(name)
  }
  const resources: Array<{ name: string; rejected?: boolean; close(): Promise<void> }> = []
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 10_000
  const localWork = dependencies.guard
    ? undefined
    : new Budget({
        workMs: 120_000,
        totalMs: 120_000,
        operationMs: timeoutMs,
        cleanupCallMs: 6_000,
      })
  const signal = AbortSignal.any([
    controller.signal,
    ...[options.signal, dependencies.signal, localWork?.work.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    ),
  ])
  const checkActive = () => {
    if (signal.aborted)
      throw signal.reason instanceof RunError
        ? signal.reason
        : new RunError(options.signal?.aborted ? "INTERRUPTED" : "DEADLINE_EXCEEDED")
  }
  let browser: Browser | undefined
  let page: Page | undefined
  const guard = async <T>(operation: () => Promise<T>, maximumMs?: number): Promise<T> => {
    checkActive()
    let onAbort: (() => void) | undefined
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          try {
            checkActive()
          } catch (error) {
            reject(error)
          }
        }
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      const value = await Promise.race([
        dependencies.guard
          ? dependencies.guard(operation, maximumMs)
          : localWork!.run(operation, maximumMs),
        aborted,
      ])
      checkActive()
      return value
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }
  const acquire = <T extends { close(): Promise<void> }>(
    name: string,
    operation: () => Promise<T>,
    owned = true,
    maximumMs?: number,
  ): Promise<T> =>
    guard(() => {
      const pending = Promise.resolve().then(operation)
      if (owned) {
        // Register the acquisition before awaiting it. If it arrives after work times out,
        // cleanup still closes the handle, even when its own wait has already expired.
        const resource = {
          name,
          rejected: false,
          close: async () => {
            const value = await pending
            await value.close()
          },
        }
        resources.push(resource)
        void pending.catch(() => {
          resource.rejected = true
        })
      }
      return pending
    }, maximumMs)
  try {
    step("preflight")
    checkActive()
    const { csv, expected: expectedBytes } = options.input
    if (csv.length > 256_000 || expectedBytes.length > 256_000)
      throw new RunError("INPUT_TOO_LARGE")
    decodeUtf8(csv)
    const expected = parseExport(JSON.parse(decodeUtf8(expectedBytes)))
    dependencies.validateArtifact?.(csv)
    dependencies.validateArtifact?.(expectedBytes)
    report.input = { file: "input.csv", sha256: sha256(csv), expectedSha256: sha256(expectedBytes) }
    await guard(() => writeFile(join(directory, "input.csv"), csv, { flag: "wx", signal }))
    await guard(() => writeFile(join(directory, "expected.json"), expectedBytes, { flag: "wx", signal }))

    step("fixture")
    const fixture = await acquire(
      "fixture server",
      () => dependencies.fixture(),
      !dependencies.ownsResources,
      dependencies.guard ? 120_000 : timeoutMs,
    )
    step("browser")
    browser = await acquire(
      "browser",
      () => dependencies.browser({ headed: options.headed ?? false, timeoutMs }),
      !dependencies.ownsResources,
      dependencies.guard ? 120_000 : timeoutMs,
    )
    const ownedBrowser = browser
    report.environment.browser = browser.version()
    step("context")
    const context = await acquire<BrowserContext>("browser context", () =>
      ownedBrowser.newContext({
        acceptDownloads: true,
        viewport: { width: 1280, height: 960 },
        serviceWorkers: "block",
      }),
    )
    context.setDefaultTimeout(timeoutMs)
    context.setDefaultNavigationTimeout(timeoutMs)
    // Page requests may reach only this run's owned fixture origin.
    await guard(() =>
      context.route("**/*", (route) =>
        new URL(route.request().url()).origin === fixture.url
          ? route.continue()
          : route.abort("blockedbyclient"),
      ),
    )
    if (dependencies.configureContext) await guard(() => dependencies.configureContext!(context))
    step("page")
    page = await guard<Page>(() =>
      context.newPage().then((value) => {
        // A page belongs to its context; close a late protocol response as well.
        if (signal.aborted) void value.close().catch(() => {})
        return value
      }),
    )
    const activePage = page
    const compareExport = async (path: string) => {
      const bytes = await guard(() => readFile(path, { signal }))
      checkActive()
      return compare(expected, parseExport(JSON.parse(decodeUtf8(bytes))))
    }
    const observed = await guard(
      () =>
        dependencies.adapter(activePage, {
          url: fixture.url,
          inputPath: join(directory, "input.csv"),
          outputDirectory: directory,
          timeoutMs,
          signal,
          onStep: (name) => {
            checkActive()
            step(name)
          },
          onCheckpoint: async (phase, path, successMessage) => {
            const comparison = await compareExport(path)
            // A callback completing after cancellation must not change the saved verdict.
            checkActive()
            if (phase === "beforeReload") report.beforeReloadComparison = comparison
            else report.comparison = comparison
            report.successMessage = successMessage
          },
          validateArtifact: dependencies.validateArtifact,
        }),
      120_000,
    )
    checkActive()
    report.successMessage = observed.successMessage
    step("compare")
    // Adapters without incremental checkpoints still return their completed exports.
    report.beforeReloadComparison ??= await compareExport(observed.beforeReloadPath)
    report.comparison ??= await compareExport(observed.exportPath)
    checkActive()
    report.outcome = differenceCount(report) ? "FAIL" : "PASS"
  } catch (error) {
    report.outcome = "INFRA_ERROR"
    const httpStatus =
      typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined
    report.error = {
      stage,
      code:
        error instanceof RunError
          ? error.code
          : error instanceof errors.TimeoutError || error instanceof remoteErrors.TimeoutError
            ? "TIMEOUT"
            : typeof httpStatus === "number" &&
                Number.isInteger(httpStatus) &&
                httpStatus >= 400 &&
                httpStatus <= 599
              ? `HTTP_${httpStatus}`
              : browser && !browser.isConnected()
                ? "BROWSER_DISCONNECTED"
                : error instanceof SyntaxError
                  ? "INVALID_JSON"
                  : "EXECUTION_FAILED",
    }
    if (!dependencies.backend && page && !page.isClosed()) {
      const failurePage = page
      await guard(
        () => failurePage.screenshot({
          path: join(directory, "failure.png"), fullPage: true, timeout: 2_000,
        }),
        2_000,
      ).catch(() => {})
    }
  } finally {
    controller.abort(new RunError("RUN_ENDED"))
    localWork?.dispose()
    dependencies.beginCleanup?.()
    const localCleanup = dependencies.cleanupCall
      ? undefined
      : new Budget({
          // Process shutdown includes Playwright's 30-second close-or-kill path.
          // Context/server calls remain at 6 seconds; the remote budget is separate.
          workMs: 1,
          totalMs: 48_000,
          operationMs: 6_000,
          cleanupCallMs: 6_000,
        })
    localCleanup?.beginCleanup()
    for (const resource of resources.reverse()) {
      if (resource.rejected) continue
      const closeStarted = Date.now()
      try {
        await (dependencies.cleanupCall
          ? dependencies.cleanupCall(() => resource.close())
          : localCleanup!.run(
              () => resource.close(),
              resource.name === "browser" ? 35_000 : localCleanup!.limits.cleanupCallMs,
            ))
        const elapsedMs = Date.now() - closeStarted
        report.cleanup.push({
          resource: resource.name,
          status: "CLOSED",
          elapsedMs,
          ...(!dependencies.cleanupCall && resource.name === "browser" && elapsedMs >= 6_000
            ? { slow: true }
            : {}),
        })
      } catch (error) {
        if (resource.rejected) continue
        report.cleanup.push({
          resource: resource.name,
          status: "FAILED",
          elapsedMs: Date.now() - closeStarted,
          errorCode:
            error instanceof RunError && error.code === "DEADLINE_EXCEEDED"
              ? "DEADLINE_EXCEEDED"
              : "CLOSE_REJECTED",
        })
        report.outcome = "INFRA_ERROR"
        report.error ??= { stage: "cleanup", code: "CLEANUP_FAILED" }
      }
    }
    localCleanup?.dispose()
    if (dependencies.finish) {
      try {
        report.cleanup.push(...(await dependencies.finish()))
      } catch {
        report.cleanup.push({ resource: "remote cleanup", status: "UNCONFIRMED" })
      }
    }
    if (report.cleanup.some((item) => item.status === "FAILED" || item.status === "UNCONFIRMED")) {
      report.outcome = "INFRA_ERROR"
      report.error ??= { stage: "cleanup", code: "CLEANUP_UNCONFIRMED" }
    }
    dependencies.dispose?.()
  }
  if (options.signal?.aborted && report.outcome !== "INFRA_ERROR") {
    report.outcome = "INFRA_ERROR"
    report.error = {
      stage: "cleanup",
      code: options.signal.reason instanceof RunError ? options.signal.reason.code : "INTERRUPTED",
    }
  }
  report.durationMs = Date.now() - started
  try {
    report.artifacts = (await readdir(directory)).sort()
    if (dependencies.metadata) report.solari = dependencies.metadata()
    dependencies.validateArtifact?.(JSON.stringify(report))
    await writeReport(directory, report)
  } catch (error) {
    throw error instanceof RunError ? error : new RunError("REPORT_WRITE_FAILED")
  }
  return { report, directory }
}
