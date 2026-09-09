import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import test from "node:test"
import { runBenchmark } from "./support/benchmark.js"
import { packageRoot } from "../src/runner.js"
import { digest, spreadsheetCommit } from "../src/spreadsheet-source.js"
import type { Report } from "../src/report.js"

test(
  "benchmark: independent CSV matrix reproduces exact upstream defects and bounded patch results",
  // Sixteen serial browser runs include acknowledged but sometimes slow Windows shutdowns.
  { timeout: 300_000 },
  async () => {
    const { summary, directory } = await runBenchmark(
      join(packageRoot, "output", "benchmark", "tests"),
    )
    console.log(`Benchmark evidence: ${join(directory, "summary.json")}`)
    assert.equal(
      summary.gate,
      "MATCHED",
      JSON.stringify(summary.results.filter((result) => !result.matched)),
    )
    assert.equal(summary.results.length, 16)
    assert.deepEqual(summary.counts, {
      upstream: { PASS: 4, FAIL: 4, INFRA_ERROR: 0 },
      patched: { PASS: 7, FAIL: 1, INFRA_ERROR: 0 },
    })
    assert.equal(summary.sourceCommit, spreadsheetCommit)
    assert.notEqual(summary.sourceSha256.upstream, summary.sourceSha256.patched)
    assert.equal(summary.casesSha256, digest(await readFile(join(directory, "cases.json"))))
    assert.equal(
      summary.sourceManifestSha256,
      digest(await readFile(join(directory, "source-manifest.json"))),
    )
    for (const result of summary.results) {
      assert.ok(result.report)
      const reportDirectory = dirname(join(directory, result.report))
      const report: Report = JSON.parse(
        await readFile(join(reportDirectory, "report.json"), "utf8"),
      )
      assert.equal(report.environment.backend, "local")
      assert.equal(report.solari, undefined)
      assert.equal(report.successMessage, "CSV imported successfully")
      assert.equal(report.error, null)
      assert.equal(report.outcome, result.expected.outcome)
      assert.deepEqual(report.comparison?.differences, result.expected.differences)
      assert.deepEqual(
        report.beforeReloadComparison?.differences,
        result.actual.beforeReloadDifferences,
      )
      assert.deepEqual(report.importer, result.source)
      assert.equal(report.importer?.variant, result.variant)
      assert.equal(report.importer?.sourceSha256, summary.sourceSha256[result.variant])
      if (result.id === "condition-note") {
        assert.deepEqual(result.actual.beforeReloadDifferences, [])
        assert.equal(result.actual.differences?.length, result.variant === "upstream" ? 2 : 0)
      }
      assert.equal(digest(await readFile(join(reportDirectory, "input.csv"))), result.inputSha256)
      assert.equal(
        digest(await readFile(join(reportDirectory, "expected.json"))),
        result.expectedSha256,
      )
      const reload = report.steps.indexOf("reload persisted import"),
        exported = report.steps.indexOf("export")
      assert.ok(reload >= 0 && exported > reload)
      assert.ok(
        report.cleanup.every((item) => typeof item.elapsedMs === "number" && item.elapsedMs >= 0),
      )
      assert.deepEqual(
        report.cleanup.map(({ resource, status }) => ({ resource, status })),
        [
          { resource: "browser context", status: "CLOSED" },
          { resource: "browser", status: "CLOSED" },
          { resource: "fixture server", status: "CLOSED" },
        ],
      )
      for (const file of [
        "before-reload.csv",
        "observed.csv",
        "observed.json",
        "import-success.png",
        "persisted.png",
        "report.html",
      ])
        await access(join(reportDirectory, file))
    }
  },
)
