import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { compare, type Difference } from "../../src/compare.js"
import { parseExport, RunError, type ImportExport, type Outcome } from "../../src/model.js"
import type { Report } from "../../src/report.js"
import { packageRoot } from "../../src/runner.js"
import { runSpreadsheet } from "../../src/spreadsheet.js"
import { normalizeSpreadsheetCSV } from "../../src/spreadsheet-adapter.js"
import { digest, spreadsheetCommit, spreadsheetFiles } from "../../src/spreadsheet-source.js"

type Variant = "upstream" | "patched"
type Expectation = {
  outcome: "PASS" | "FAIL"
  differences: Difference[]
  beforeReloadDifferences?: Difference[]
}
interface BenchmarkCase {
  id: string
  csv: string
  expected: ImportExport
  upstream: Expectation
  patched: Expectation
}
interface Result {
  id: string
  variant: Variant
  matched: boolean
  expected: Expectation
  actual: {
    outcome: Outcome
    differences: Difference[] | null
    beforeReloadDifferences: Difference[] | null
    error: Report["error"]
  }
  inputSha256: string
  expectedSha256: string
  source: Report["importer"] | null
  report: string | null
}

export async function runBenchmark(outputRoot = join(packageRoot, "output", "benchmark")) {
  const casesBytes = await readFile(new URL("./cases.json", import.meta.url))
  const catalog = JSON.parse(casesBytes.toString("utf8")) as {
    schemaVersion: number
    cases: BenchmarkCase[]
  }
  if (
    catalog.schemaVersion !== 1 ||
    !Array.isArray(catalog.cases) ||
    !catalog.cases.length ||
    new Set(catalog.cases.map((item) => item.id)).size !== catalog.cases.length ||
    catalog.cases.some((item) => !/^[a-z0-9-]+$/.test(item.id))
  )
    throw new RunError("INVALID_BENCHMARK_CASES")
  for (const item of catalog.cases) parseExport(item.expected)
  const directory = join(outputRoot, `benchmark-${randomUUID()}`),
    startedAt = new Date().toISOString()
  await mkdir(directory, { recursive: true })
  const sourceManifest = await readFile(
    join(packageRoot, "upstream", "spreadsheet", "manifest.json"),
  )
  const sourceSha256 = {
    upstream: (await spreadsheetFiles(undefined, "upstream")).sha256,
    patched: (await spreadsheetFiles(undefined, "patched")).sha256,
  }
  await writeFile(join(directory, "cases.json"), casesBytes, { flag: "wx" })
  await writeFile(join(directory, "source-manifest.json"), sourceManifest, { flag: "wx" })
  // Freeze every CSV and independent JSON oracle before starting any browser run.
  const inputs = await Promise.all(
    catalog.cases.map(async (item) => {
      const root = join(directory, "inputs", item.id)
      await mkdir(root, { recursive: true })
      const csv = Buffer.from(item.csv),
        expected = Buffer.from(JSON.stringify(item.expected, null, 2) + "\n")
      const input = { csv: join(root, "input.csv"), expected: join(root, "expected.json") }
      await writeFile(input.csv, csv, { flag: "wx" })
      await writeFile(input.expected, expected, { flag: "wx" })
      return { item, input, inputSha256: digest(csv), expectedSha256: digest(expected) }
    }),
  )
  const results: Result[] = []
  const counts = {
    upstream: { PASS: 0, FAIL: 0, INFRA_ERROR: 0 },
    patched: { PASS: 0, FAIL: 0, INFRA_ERROR: 0 },
  }
  for (const variant of ["upstream", "patched"] as const) {
    for (const { item, input, inputSha256, expectedSha256 } of inputs) {
      const result: Result = {
        id: item.id,
        variant,
        matched: false,
        expected: item[variant],
        actual: {
          outcome: "INFRA_ERROR",
          differences: null,
          beforeReloadDifferences: null,
          error: null,
        },
        inputSha256,
        expectedSha256,
        source: null,
        report: null,
      }
      try {
        const run = await runSpreadsheet({
          input,
          variant,
          outputRoot: join(directory, variant, item.id),
        })
        const report = run.report
        result.source = report.importer ?? null
        result.report = relative(directory, join(run.directory, "report.html")).replaceAll(
          "\\",
          "/",
        )
        result.actual = {
          outcome: report.outcome,
          differences: report.comparison?.differences ?? null,
          beforeReloadDifferences: report.artifacts.includes("before-reload.csv")
            ? compare(
                item.expected,
                normalizeSpreadsheetCSV(await readFile(join(run.directory, "before-reload.csv"))),
              ).differences
            : null,
          error: report.error,
        }
        result.matched =
          report.outcome === result.expected.outcome &&
          report.error === null &&
          isDeepStrictEqual(result.actual.differences, result.expected.differences) &&
          report.environment.backend === "local" &&
          (result.expected.beforeReloadDifferences === undefined ||
            isDeepStrictEqual(
              result.actual.beforeReloadDifferences,
              result.expected.beforeReloadDifferences,
            )) &&
          report.importer?.variant === variant &&
          report.importer.sourceSha256 === sourceSha256[variant] &&
          report.input?.sha256 === inputSha256 &&
          report.input.expectedSha256 === expectedSha256
      } catch (error) {
        result.actual.outcome = "INFRA_ERROR"
        result.actual.error = {
          stage: "benchmark",
          code: error instanceof RunError ? error.code : "BENCHMARK_RUN_FAILED",
        }
      }
      counts[variant][result.actual.outcome]++
      results.push(result)
    }
  }
  const summary = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    gate: results.every((result) => result.matched)
      ? ("MATCHED" as const)
      : ("DISCREPANCY" as const),
    meaning:
      "MATCHED means the exact expected matrix reproduced; it does not mean every import passed. CRLF normalization remains a known limitation in both variants.",
    casesSha256: digest(casesBytes),
    sourceCommit: spreadsheetCommit,
    sourceManifestSha256: digest(sourceManifest),
    sourceSha256,
    counts,
    results,
  }
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
  })
  return { summary, directory }
}
