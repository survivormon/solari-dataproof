import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { checkDemoCase, demoIdentity, originalAfterReload, runDemo } from "../src/demo.js"
import { parseDemoArgs } from "../src/demo-cli.js"
import { renderDemo } from "../src/demo-report.js"
import { RunError } from "../src/model.js"
import type { Report } from "../src/report.js"
import { spreadsheetCommit, type SpreadsheetVariant } from "../src/spreadsheet-source.js"
import { removeTestDirectory } from "./temp.js"

function reportFor(variant: SpreadsheetVariant): Report {
  const comparison = {
    expectedAccepted: 2,
    actualAccepted: 2,
    expectedRejected: 0,
    actualRejected: 0,
    differences: variant === "upstream" ? structuredClone(originalAfterReload) : [],
  }
  return {
    schemaVersion: 2,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    durationMs: 100,
    outcome: variant === "upstream" ? "FAIL" : "PASS",
    environment: { backend: "local", node: process.version, browser: "test", playwright: "test" },
    importer: {
      name: "Spreadsheet Live",
      revision: spreadsheetCommit,
      variant,
      sourceSha256: demoIdentity[variant],
      policy: "test",
    },
    input: { file: "input.csv", sha256: demoIdentity.csv, expectedSha256: demoIdentity.expected },
    comparison,
    beforeReloadComparison: { ...comparison, differences: comparison.differences.slice(1) },
    successMessage: "Imported",
    steps: [],
    artifacts: [],
    error: null,
    cleanup: ["browser context", "browser", "fixture server"].map((resource) => ({
      resource,
      status: "CLOSED",
    })),
  }
}
test("demo contract checks exact values at both checkpoints, identity, counts, and cleanup", () => {
  for (const variant of ["upstream", "patched"] as const)
    assert.deepEqual(checkDemoCase(reportFor(variant), variant), [])
  const mutations: ((report: Report) => void)[] = [
    (report) => {
      report.beforeReloadComparison!.differences[0]!.actual = "different corruption"
    },
    (report) => {
      report.comparison!.actualAccepted = 3
    },
    (report) => {
      report.input!.expectedSha256 = "another expectation"
    },
    (report) => {
      report.importer!.sourceSha256 = "another source"
    },
    (report) => {
      report.cleanup = []
    },
    (report) => {
      report.cleanup[1]!.status = "FAILED"
    },
    (report) => {
      report.error = { code: "DEADLINE_EXCEEDED", stage: "cleanup" }
    },
  ]
  for (const mutate of mutations) {
    const report = reportFor("upstream")
    mutate(report)
    assert.notDeepEqual(checkDemoCase(report, "upstream"), [])
  }
})
test("paired demo uses identical frozen snapshots and retains a linked comparison report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "csv-demo-"))
  t.after(() => removeTestDirectory(root))
  const seen: string[] = []
  const result = await runDemo({ outputRoot: root }, async (options = {}) => {
    seen.push(options.variant!)
    const bytes = await readFile(options.input!.csv)
    assert.ok(bytes.includes(Buffer.from("Jean\u00a0Dupont")))
    assert.equal(options.signal, undefined)
    const report = reportFor(options.variant!)
    return { report, directory: join(options.outputRoot!, report.runId) }
  })
  assert.deepEqual(seen, ["upstream", "patched"])
  assert.equal(result.summary.outcome, "VERIFIED")
  const saved = JSON.parse(await readFile(join(result.directory, "summary.json"), "utf8"))
  assert.deepEqual(saved, result.summary)
  const html = await readFile(join(result.directory, "index.html"), "utf8")
  assert.match(html, /DEMO VERIFIED/)
  assert.match(html, /Jean\\u00a0Dupont/)
  for (const item of result.summary.cases) assert.ok(html.includes(`href="${item.reportPath}"`))
  assert.doesNotMatch(html, /<script\b/i)
})
test("unexpected corruption and infrastructure failures stop before the patched case", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "csv-demo-stop-"))
  t.after(() => removeTestDirectory(root))
  for (const failure of ["semantic", "infrastructure", "exception"] as const) {
    let calls = 0
    const { summary, directory } = await runDemo({ outputRoot: root }, async (options = {}) => {
      calls++
      if (failure === "exception") throw new Error("private diagnostic not suitable for output")
      const report = reportFor("upstream")
      if (failure === "semantic") report.comparison!.differences[0]!.actual = "unexpected"
      else {
        report.outcome = "INFRA_ERROR"
        report.error = { stage: "cleanup", code: "CLEANUP_FAILED" }
      }
      return { report, directory: join(options.outputRoot!, report.runId) }
    })
    assert.equal(calls, 1)
    assert.equal(summary.outcome, failure === "semantic" ? "UNEXPECTED_RESULT" : "INCOMPLETE")
    assert.ok(summary.error)
    const html = await readFile(join(directory, "index.html"), "utf8")
    assert.doesNotMatch(html, /private diagnostic/)
    assert.doesNotMatch(html, /DEMO VERIFIED/)
  }
})
test("cancellation before and during the original case preserves an incomplete summary and launches no subsequent case", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "csv-demo-cancel-"))
  t.after(() => removeTestDirectory(root))
  for (const before of [true, false]) {
    const controller = new AbortController()
    if (before) controller.abort()
    let calls = 0
    const { summary, directory } = await runDemo(
      { outputRoot: root, signal: controller.signal },
      async (options = {}) => {
        calls++
        assert.equal(options.signal, controller.signal)
        controller.abort()
        const report = reportFor("upstream")
        return { report, directory: join(options.outputRoot!, report.runId) }
      },
    )
    assert.equal(calls, before ? 0 : 1)
    assert.equal(summary.outcome, "INCOMPLETE")
    assert.equal(summary.error?.code, "DEMO_INTERRUPTED")
    assert.equal(summary.cases.length, calls)
    assert.ok((await readFile(join(directory, "index.html"))).length > 0)
  }
})
test("demo HTML treats diagnostics and observations as text and rejects unsafe report links", () => {
  const report = reportFor("upstream")
  report.comparison!.differences[0]!.actual = '<img src=x onerror="alert(1)">'
  const html = renderDemo({
    schemaVersion: 1,
    runId: "test",
    startedAt: "test",
    durationMs: 1,
    outcome: "UNEXPECTED_RESULT",
    inputsCaptured: true,
    error: { code: "DEMO_UNEXPECTED_RESULT", stage: "upstream" },
    cases: [
      {
        variant: "upstream",
        reportPath: "javascript:alert(1)",
        report,
        issues: ["<script>bad</script>"],
      },
    ],
  })
  assert.doesNotMatch(html, /<script\b|<img\b|href="javascript:/i)
  assert.match(html, /&lt;img/)
})
test("demo command accepts only its supported presentation options", () => {
  assert.deepEqual(parseDemoArgs([]), {})
  assert.deepEqual(parseDemoArgs(["--headed"]), { headed: true })
  assert.equal(parseDemoArgs(["--help"]), null)
  for (const args of [["--live"], ["--input", "a.csv"], ["--headed", "--headed"]])
    assert.throws(() => parseDemoArgs(args), RunError)
})
