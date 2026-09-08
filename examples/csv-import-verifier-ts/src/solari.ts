import { randomUUID } from "node:crypto"
import type { Browser, BrowserContext } from "./browser-types.js"
import type { FixtureBundle } from "./bundle.js"
import { Budget } from "./budget.js"
import { Secrets } from "./secrets.js"
import { RunError } from "./model.js"
import type { Dependencies } from "./runner.js"
import type { CleanupRecord, Report } from "./report.js"
import type { ResourceEvent } from "./recovery.js"

interface RemoteSandbox {
  connect(): Promise<void>
  close(): void
  write(path: string, bytes: Buffer): Promise<void>
  run(
    command: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  start(command: string, args: string[]): Promise<void>
}
export interface SolariDriver {
  evidence: "live" | "offline-test"
  request(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<unknown>
  sandbox(raw: unknown): RemoteSandbox
  browser(endpoint: string, timeout: number): Promise<Browser>
  preview(url: string, token: string): Promise<{ status: number; value: unknown }>
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new RunError("INVALID_SERVICE_RESPONSE")
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new RunError("INVALID_SERVICE_RESPONSE")
  return value
}
function status(error: unknown): number | undefined {
  const value =
    typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined
  return typeof value === "number" ? value : undefined
}
function endpoint(raw: unknown): string {
  const value = text(raw),
    url = new URL(value)
  if (
    url.protocol !== "wss:" ||
    url.hostname !== "api.getsolari.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new RunError("UNEXPECTED_CONTROL_ENDPOINT")
  }
  return value
}

export function solariDependencies(
  driver: SolariDriver,
  budget: Budget,
  bundle: FixtureBundle,
  secrets: Secrets,
  journal?: (event: ResourceEvent) => void,
): Omit<Dependencies, "adapter"> {
  let sandboxId: string | undefined, browserId: string | undefined
  let sandbox: RemoteSandbox | undefined, browser: Browser | undefined
  let sandboxAttempted = false,
    browserAttempted = false,
    sandboxRejected = false,
    browserRejected = false
  let previewOrigin = "",
    previewToken = ""
  const pending = new Set<Promise<unknown>>()
  const requestCounts = { sandbox: 0, browser: 0 }
  const own = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation)
    void operation.finally(() => pending.delete(operation)).catch(() => {})
    return operation
  }
  const metadata = (): NonNullable<Report["solari"]> => ({
    evidence: driver.evidence,
    browserClient: "patchright-core@1.62.2 (Playwright wire protocol)",
    sdk: "@solarisdk/core@0.1.3",
    fixtureBundleSha256: bundle.sha256,
    workDeadlineMs: budget.limits.workMs,
    totalDeadlineMs: budget.limits.totalMs,
    createRequests: { ...requestCounts },
    cleanupScope: "gateway API observations; no billing or physical teardown proof",
  })

  async function finish(): Promise<CleanupRecord[]> {
    const records: CleanupRecord[] = []
    const save = (event: ResourceEvent) => {
      try {
        journal?.(event)
      } catch {
        records.push({ resource: "private recovery journal", status: "UNCONFIRMED" })
      }
    }
    budget.beginCleanup()
    const close = async (
      resource: string,
      operation: () => Promise<unknown>,
      success: CleanupRecord["status"] = "CLOSED",
    ) => {
      try {
        await budget.run(operation, budget.limits.cleanupCallMs)
        records.push({ resource, status: success })
      } catch {
        records.push({ resource, status: "UNCONFIRMED" })
      }
    }
    // Aborted HTTP work normally settles immediately; give already-started acquisitions a bounded chance to expose their IDs.
    if (pending.size)
      await budget
        .run(() => Promise.allSettled([...pending]), budget.limits.cleanupCallMs)
        .catch(() => {})
    if (browser) await close("browser connection", () => browser!.close())
    if (sandbox) {
      try {
        sandbox.close()
        records.push({ resource: "sandbox control channel", status: "CLOSED" })
      } catch {
        records.push({ resource: "sandbox control channel", status: "UNCONFIRMED" })
      }
    }
    // Attempt both DELETEs before spending time observing either one. Never retry a DELETE or a create.
    const remote = [
      {
        kind: "browser" as const,
        name: "browser session",
        id: browserId,
        prefix: "/sessions/",
        field: "status",
        terminal: ["released", "expired"],
        attempted: browserAttempted,
        rejected: browserRejected,
      },
      {
        kind: "sandbox" as const,
        name: "sandbox",
        id: sandboxId,
        prefix: "/sandboxes/",
        field: "state",
        terminal: ["gone"],
        attempted: sandboxAttempted,
        rejected: sandboxRejected,
      },
    ]
    for (const resource of remote) {
      if (resource.id)
        await close(
          `${resource.name} DELETE`,
          async () => {
            save({ type: "delete-attempted", resource: resource.kind, id: resource.id! })
            const reply = await driver.request(
              "DELETE",
              resource.prefix + encodeURIComponent(resource.id!),
            )
            if (reply && typeof reply === "object" && Reflect.get(reply, "ok") === false)
              throw new RunError("DELETE_REJECTED")
            save({ type: "delete-acknowledged", resource: resource.kind, id: resource.id! })
          },
          "API_ACKNOWLEDGED",
        )
      else if (resource.attempted && !resource.rejected)
        records.push({ resource: `${resource.name} create outcome`, status: "UNCONFIRMED" })
    }
    for (const resource of remote) {
      if (!resource.id) continue
      let confirmed = false
      for (let poll = 0; poll < 4; poll++) {
        try {
          const view = object(
            await budget.run(
              () => driver.request("GET", resource.prefix + encodeURIComponent(resource.id!)),
              budget.limits.cleanupCallMs,
            ),
          )
          if (resource.terminal.includes(String(view[resource.field]))) {
            confirmed = true
            break
          }
        } catch (error) {
          if (resource.prefix === "/sandboxes/" && status(error) === 404) {
            confirmed = true
            break
          }
        }
        // New browser sessions can read active for ~10s while reservation state
        // propagates. Bounded 2/4/8s backoff stays inside the total cleanup budget.
        if (poll < 3) {
          const delay = Math.min(2_000, budget.limits.cleanupCallMs / 2) * 2 ** poll
          await budget
            .run(() => new Promise((resolve) => setTimeout(resolve, delay)), delay + 500)
            .catch(() => {})
        }
      }
      records.push({
        resource: `${resource.name} gateway observation`,
        status: confirmed ? "API_CONFIRMED" : "UNCONFIRMED",
      })
      if (confirmed) save({ type: "gateway-confirmed", resource: resource.kind, id: resource.id })
    }
    return records
  }

  return {
    backend: "solari",
    ownsResources: true,
    signal: budget.work.signal,
    guard: (operation, timeout) => budget.run(operation, timeout),
    beginCleanup: () => budget.beginCleanup(),
    cleanupCall: (operation) => budget.run(operation, budget.limits.cleanupCallMs),
    finish,
    dispose: () => budget.dispose(),
    metadata,
    validateArtifact: (bytes) => secrets.check(bytes),
    configureContext: async (context: BrowserContext) => {
      // Clean URLs keep capabilities out of screenshots. The fixture's only download link is same-origin.
      await context.setExtraHTTPHeaders({ "x-pinetree-preview-token": previewToken })
    },
    fixture: async () => {
      await budget.run(() => {
        sandboxAttempted = true
        requestCounts.sandbox++
        return own(
          driver
            .request(
              "POST",
              "/sandboxes",
              {
                template: "base",
                kind: "sandbox",
                cpu: 1,
                memMb: 2048,
                timeoutMs: 120_000,
                lifecycle: { onTimeout: "kill" },
                metadata: { purpose: "csv-import-verifier" },
              },
              randomUUID(),
            )
            .then((raw) => {
              const data = object(raw)
              sandboxId = text(data.sandboxId)
              secrets.add(sandboxId)
              journal?.({ type: "acquired", resource: "sandbox", id: sandboxId })
              secrets.add(text(data.controlUrl))
              endpoint(data.controlUrl)
              sandbox = driver.sandbox(data)
            })
            .catch((error) => {
              sandboxRejected = [400, 401, 402, 403, 404, 413, 429].includes(status(error) ?? 0)
              throw error
            }),
        )
      })
      const handle = sandbox!
      await budget.run(() => own(handle.connect()))
      const version = await budget.run(() => handle.run("node", ["--version"]))
      if (version.exitCode !== 0 || !/^v(1[89]|[2-9]\d)\./.test(version.stdout.trim()))
        throw new RunError("GUEST_NODE_UNSUPPORTED")
      const mkdir = await budget.run(() =>
        handle.run("mkdir", ["-p", "/tmp/csv-import-verifier/dist"]),
      )
      if (mkdir.exitCode !== 0) throw new RunError("FIXTURE_SETUP_FAILED")
      for (const file of bundle.files) await budget.run(() => handle.write(file.path, file.bytes))
      const preview = object(
        await budget.run(() =>
          driver.request("GET", `/sandboxes/${encodeURIComponent(sandboxId!)}/ports/3000`),
        ),
      )
      const url = new URL(text(preview.url))
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".preview.getsolari.com") ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== "/"
      ) {
        throw new RunError("UNEXPECTED_PREVIEW_ENDPOINT")
      }
      previewOrigin = url.origin
      previewToken =
        typeof preview.token === "string" ? preview.token : (url.searchParams.get("pt_token") ?? "")
      if (!previewToken) throw new RunError("PREVIEW_TOKEN_REQUIRED")
      secrets.add(previewToken)
      secrets.add(url.href)
      secrets.add(previewOrigin)
      await budget.run(() =>
        handle.start("node", ["/tmp/csv-import-verifier/dist/server.mjs", previewOrigin]),
      )
      let ready = false
      for (let poll = 0; poll < 10; poll++) {
        const health = await budget.run(() =>
          driver.preview(previewOrigin + "/health", previewToken),
        )
        if (health.status === 200) {
          const data = object(health.value)
          ready =
            data.service === "csv-import-verifier" &&
            data.schemaVersion === 1 &&
            data.ready === true
          break
        }
        if (health.status !== 425) throw new RunError("PREVIEW_UNAVAILABLE")
        await budget.run(() => new Promise((resolve) => setTimeout(resolve, 500)))
      }
      if (!ready) throw new RunError("FIXTURE_NOT_READY")
      return { url: previewOrigin, close: async () => {} } // Ownership registered above, before connect/setup.
    },
    browser: async () => {
      let wireEndpoint = ""
      await budget.run(() => {
        browserAttempted = true
        requestCounts.browser++
        return own(
          driver
            .request("POST", "/sessions", {})
            .then((raw) => {
              const data = object(raw)
              browserId = text(data.sessionId)
              secrets.add(browserId)
              journal?.({ type: "acquired", resource: "browser", id: browserId })
              wireEndpoint = endpoint(data.wsEndpoint)
              secrets.add(wireEndpoint)
            })
            .catch((error) => {
              browserRejected = [400, 401, 402, 403, 404, 413, 429].includes(status(error) ?? 0)
              throw error
            }),
        )
      })
      return budget.run(() =>
        own(
          driver.browser(wireEndpoint, budget.limits.operationMs).then(async (connected) => {
            browser = connected
            if (budget.cleaning) await connected.close()
            return connected
          }),
        ),
      )
    },
  }
}
