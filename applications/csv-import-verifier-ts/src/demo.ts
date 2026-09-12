import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { Comparison, Difference } from "./compare.js"
import { RunError } from "./model.js"
import { packageRoot } from "./runner.js"
import type { Report } from "./report.js"
import { renderDemo } from "./demo-report.js"
import { readSpreadsheetInput, runSpreadsheet } from "./spreadsheet.js"
import { spreadsheetCommit, type SpreadsheetVariant } from "./spreadsheet-source.js"

// Frozen demo contract, authored independently of browser output. Changing the
// sample or either source patch requires reviewing these identities and values.
export const demoIdentity = {
  csv: "976d7581fc219a947337b836c388339107a9981af93a63e3526b360f795e2894",
  expected: "00a3ab2bdb0ed92f840b10a10bac9a0876695e2d05ac67ab7b6d3f77f74fba03",
  upstream: "46a578863f3042c3c897fd3b295d7095163e9ff21e6a0756fe7b5a601c44785c",
  patched: "f4fff8c822b688ec938cfab4fce2f18a720c2fff329bfeb0b33eb0a6c4f0dd49",
} as const
export const originalAfterReload: Difference[] = [
  {
    code: "FIELD_CHANGED",
    customerId: "0017",
    sourceRow: 2,
    field: "note",
    expected: "Condition=New & boxed",
    actual: "Condition=New &amp; boxed",
  },
  {
    code: "FIELD_CHANGED",
    customerId: "C-400",
    sourceRow: 3,
    field: "name",
    expected: "Jean\u00a0Dupont",
    actual: "Jean Dupont",
  },
  {
    code: "FIELD_CHANGED",
    customerId: "C-400",
    sourceRow: 3,
    field: "note",
    expected: "10\u00a0rue du Port",
    actual: "10 rue du Port",
  },
]
export function checkDemoCase(report: Report, variant: SpreadsheetVariant): string[] {
  const issues: string[] = []
  const check = (ok: boolean, reason: string) => {
    if (!ok) issues.push(reason)
  }
  check(
    report.outcome === (variant === "upstream" ? "FAIL" : "PASS") && report.error === null,
    "Run did not finish with the expected verdict.",
  )
  check(
    report.environment.backend === "local" &&
      report.importer?.revision === spreadsheetCommit &&
      report.importer.variant === variant &&
      report.importer.sourceSha256 === demoIdentity[variant],
    "Application source does not match the frozen demo.",
  )
  check(
    report.input?.sha256 === demoIdentity.csv &&
      report.input.expectedSha256 === demoIdentity.expected,
    "Input or expectation does not match the frozen demo.",
  )
  const expected = (differences: Difference[]): Comparison => ({
    expectedAccepted: 2,
    actualAccepted: 2,
    expectedRejected: 0,
    actualRejected: 0,
    differences,
  })
  check(
    isDeepStrictEqual(
      report.beforeReloadComparison,
      expected(variant === "upstream" ? originalAfterReload.slice(1) : []),
    ),
    "Before-reload values differ from the demo contract.",
  )
  check(
    isDeepStrictEqual(
      report.comparison,
      expected(variant === "upstream" ? originalAfterReload : []),
    ),
    "After-reload values differ from the demo contract.",
  )
  check(
    isDeepStrictEqual(
      report.cleanup.map(({ resource, status }) => ({ resource, status })),
      [
        { resource: "browser context", status: "CLOSED" },
        { resource: "browser", status: "CLOSED" },
        { resource: "fixture server", status: "CLOSED" },
      ],
    ),
    "Resource cleanup is incomplete.",
  )
  return issues
}
export interface DemoCase {
  variant: SpreadsheetVariant
  reportPath: string
  report: Report
  issues: string[]
}
export interface DemoSummary {
  schemaVersion: 1
  runId: string
  startedAt: string
  durationMs: number
  outcome: "VERIFIED" | "UNEXPECTED_RESULT" | "INCOMPLETE"
  inputsCaptured: boolean
  cases: DemoCase[]
  error: { code: string; stage: string } | null
}
export interface DemoOptions {
  headed?: boolean
  outputRoot?: string
  signal?: AbortSignal
}

export async function runDemo(options: DemoOptions = {}, execute = runSpreadsheet) {
  const started = Date.now()
  const summary: DemoSummary = {
    schemaVersion: 1,
    runId: randomUUID(),
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    outcome: "INCOMPLETE",
    inputsCaptured: false,
    cases: [],
    error: null,
  }
  const directory = join(options.outputRoot ?? join(packageRoot, "output", "demo"), summary.runId)
  try {
    await mkdir(directory, { recursive: true })
  } catch {
    throw new RunError("OUTPUT_DIRECTORY_FAILED")
  }
  const interrupted = () => {
    if (options.signal?.aborted) throw new RunError("DEMO_INTERRUPTED")
  }
  let stage = "preflight"
  try {
    interrupted()
    const input = await readSpreadsheetInput({
      csv: join(packageRoot, "demo", "customers.csv"),
      expected: join(packageRoot, "demo", "expected.json"),
    })
    for (const key of ["csv", "expected"] as const)
      if (createHash("sha256").update(input[key]).digest("hex") !== demoIdentity[key])
        throw new RunError("DEMO_INPUT_CHANGED")
    const files = { csv: join(directory, "input.csv"), expected: join(directory, "expected.json") }
    try {
      await writeFile(files.csv, input.csv, { flag: "wx" })
      await writeFile(files.expected, input.expected, { flag: "wx" })
    } catch {
      throw new RunError("OUTPUT_WRITE_FAILED")
    }
    summary.inputsCaptured = true
    for (const variant of ["upstream", "patched"] as const) {
      interrupted()
      stage = variant
      const result = await execute({
        headed: options.headed,
        input: files,
        variant,
        outputRoot: join(directory, variant),
        signal: options.signal,
      })
      const reportPath = relative(directory, join(result.directory, "report.html"))
      if (isAbsolute(reportPath) || reportPath.startsWith(`..${sep}`))
        throw new RunError("DEMO_RUN_FAILED")
      const issues = checkDemoCase(result.report, variant)
      summary.cases.push({
        variant,
        reportPath: reportPath.split(sep).join("/"),
        report: result.report,
        issues,
      })
      interrupted()
      if (result.report.outcome === "INFRA_ERROR") {
        summary.error = result.report.error ?? { code: "DEMO_RUN_FAILED", stage }
        break
      }
      if (issues.length) {
        summary.outcome = "UNEXPECTED_RESULT"
        summary.error = { code: "DEMO_UNEXPECTED_RESULT", stage }
        break
      }
    }
    if (summary.cases.length === 2 && summary.cases.every((item) => item.issues.length === 0))
      summary.outcome = "VERIFIED"
  } catch (error) {
    summary.error = { code: error instanceof RunError ? error.code : "DEMO_RUN_FAILED", stage }
  }
  summary.durationMs = Date.now() - started
  try {
    await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
      flag: "wx",
    })
    await writeFile(join(directory, "index.html"), renderDemo(summary), { flag: "wx" })
  } catch {
    throw new RunError("REPORT_WRITE_FAILED")
  }
  return { directory, summary }
}
