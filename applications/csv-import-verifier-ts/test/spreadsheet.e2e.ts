import assert from "node:assert/strict"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import test from "node:test"
import { packageRoot } from "../src/runner.js"
import { normalizeSpreadsheetCSV } from "../src/spreadsheet-adapter.js"
import { runSpreadsheet } from "../src/spreadsheet.js"
import { runDemo } from "../src/demo.js"

for (const variant of ["upstream", "patched"] as const) {
  test(
    `independent spreadsheet: ${variant} accepts cells matching the import success notification`,
    { timeout: 60_000 },
    async (t) => {
      const root = join(packageRoot, "output", "external", "tests", `notification-${variant}-${randomUUID()}`)
      await mkdir(root, { recursive: true })
      const input = { csv: join(root, "input.csv"), expected: join(root, "expected.json") }
      const expected = {
        schemaVersion: 1,
        accepted: [
          { sourceRow: 2, customer_id: "0001", name: "Alice", note: "CSV imported successfully" },
          { sourceRow: 3, customer_id: "0002", name: "CSV imported successfully", note: "Ordinary note" },
        ],
        rejected: [],
      }
      await writeFile(
        input.csv,
        "source_row,customer_id,name,note\r\n" +
          "2,0001,Alice,CSV imported successfully\r\n" +
          "3,0002,CSV imported successfully,Ordinary note\r\n",
        { flag: "wx" },
      )
      await writeFile(input.expected, JSON.stringify(expected), { flag: "wx" })
      const { report, directory } = await runSpreadsheet({ input, signal: t.signal, variant, outputRoot: root })
      console.log(`Notification collision evidence (${variant}): ${directory}`)
      assert.deepEqual(
        report.cleanup.map(({ resource, status }) => ({ resource, status })),
        [
          { resource: "browser context", status: "CLOSED" },
          { resource: "browser", status: "CLOSED" },
          { resource: "fixture server", status: "CLOSED" },
        ],
      )
      assert.equal(report.outcome, "PASS", JSON.stringify(report))
      assert.equal(report.error, null)
      assert.equal(report.successMessage, "CSV imported successfully")
      assert.deepEqual(report.beforeReloadComparison?.differences, [])
      assert.deepEqual(report.comparison?.differences, [])
      for (const name of ["before-reload.csv", "observed.csv"])
        assert.deepEqual(normalizeSpreadsheetCSV(await readFile(join(directory, name))), expected)
    },
  )
}

test(
  "README demo verifies both variants and writes a linked comparison report",
  { timeout: 90_000 },
  async (t) => {
    const { summary, directory: demoDirectory } = await runDemo({
      signal: t.signal,
      outputRoot: join(packageRoot, "output", "demo-tests", "nested-checkout-".repeat(8), "nested-checkout-".repeat(8)),
    })
    console.log(`README demo: ${demoDirectory}`)
    assert.equal(summary.outcome, "VERIFIED", JSON.stringify(summary))
    assert.deepEqual(summary.cases.map((item) => item.variant), ["upstream", "patched"])
    const index = await readFile(join(demoDirectory, "index.html"), "utf8")
    for (const item of summary.cases) {
      const directory = dirname(join(demoDirectory, item.reportPath))
      assert.ok(join(directory, "input.csv").length > 260)
      assert.ok(index.includes(`href="${item.reportPath}"`))
      const html = await readFile(join(directory, "report.html"), "utf8")
      if (item.variant === "upstream") assert.ok(html.includes("Jean\\u00a0Dupont"))
      assert.ok(!/<script\b/i.test(html))
      for (const name of ["before-reload.csv", "before-reload.json", "observed.csv", "observed.json", "import-success.png", "persisted.png"])
        await access(join(directory, name))
    }
  },
)
test(
  "independent spreadsheet: the 50-row supported boundary preserves every row and closes all resources",
  { timeout: 60_000 },
  async (t) => {
    const root = join(packageRoot, "output", "external", "tests", `boundary-50-${randomUUID()}`)
    await mkdir(root, { recursive: true })
    const accepted = Array.from({ length: 50 }, (_, index) => ({
      sourceRow: index + 2,
      customer_id: String(index + 1).padStart(4, "0"),
      name: `Customer ${index + 1}, Zoë`,
      note:
        index === 49 ? 'Final row: "quoted"\nCondition=New & boxed\u00a0item' : `Note ${index + 1}`,
    }))
    const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`
    const csv =
      [
        "source_row,customer_id,name,note",
        ...accepted.map((row) =>
          [row.sourceRow, row.customer_id, row.name, row.note].map(quote).join(","),
        ),
      ].join("\r\n") + "\r\n"
    const input = { csv: join(root, "input.csv"), expected: join(root, "expected.json") }
    await writeFile(input.csv, csv, { flag: "wx" })
    await writeFile(input.expected, JSON.stringify({ schemaVersion: 1, accepted, rejected: [] }), {
      flag: "wx",
    })
    const { report, directory } = await runSpreadsheet({
      input,
      signal: t.signal,
      variant: "patched",
      outputRoot: root,
    })
    console.log(`50-row boundary evidence: ${directory}`)
    assert.equal(report.outcome, "PASS", JSON.stringify(report))
    assert.equal(report.error, null)
    assert.equal(report.comparison?.actualAccepted, 50)
    assert.deepEqual(report.comparison?.differences, [])
    assert.deepEqual(report.beforeReloadComparison?.differences, [])
    assert.deepEqual(normalizeSpreadsheetCSV(await readFile(join(directory, "observed.csv"))), {
      schemaVersion: 1,
      accepted,
      rejected: [],
    })
    assert.deepEqual(
      report.cleanup.map(({ resource, status }) => ({ resource, status })),
      [
        { resource: "browser context", status: "CLOSED" },
        { resource: "browser", status: "CLOSED" },
        { resource: "fixture server", status: "CLOSED" },
      ],
    )
  },
)
