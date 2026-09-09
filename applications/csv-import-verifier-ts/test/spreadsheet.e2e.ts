import assert from "node:assert/strict"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import test from "node:test"
import { packageRoot } from "../src/runner.js"
import { normalizeSpreadsheetCSV } from "../src/spreadsheet-adapter.js"
import { runSpreadsheet } from "../src/spreadsheet.js"
import { spreadsheetCommit } from "../src/spreadsheet-source.js"

test(
  "README demo detects the upstream defects and passes with the two patches",
  { timeout: 90_000 },
  async () => {
    const input = {
      csv: join(packageRoot, "demo", "customers.csv"),
      expected: join(packageRoot, "demo", "expected.json"),
    }
    const expectedDifferences = [
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
    for (const variant of ["upstream", "patched"] as const) {
      const { report, directory } = await runSpreadsheet({
        input,
        variant,
        outputRoot: join(
          packageRoot,
          "output",
          "demo-tests",
          "nested-checkout-".repeat(8),
          "nested-checkout-".repeat(8),
        ),
      })
      assert.ok(join(directory, "input.csv").length > 260)
      assert.equal(report.outcome, variant === "upstream" ? "FAIL" : "PASS", JSON.stringify(report))
      assert.equal(report.error, null)
      assert.equal(
        report.beforeReloadComparison?.differences.length,
        variant === "upstream" ? 2 : 0,
      )
      assert.deepEqual(
        report.comparison?.differences,
        variant === "upstream" ? expectedDifferences : [],
      )
      assert.ok(report.cleanup.every((item) => item.status === "CLOSED"))
      const html = await readFile(join(directory, "report.html"), "utf8")
      if (variant === "upstream") assert.ok(html.includes("Jean\\u00a0Dupont"))
      assert.ok(!/<script\b/i.test(html))
      for (const name of [
        "before-reload.csv",
        "before-reload.json",
        "observed.csv",
        "observed.json",
        "import-success.png",
        "persisted.png",
      ])
        await access(join(directory, name))
      console.log(`README demo ${variant}: ${directory}`)
    }
  },
)

test(
  "independent spreadsheet: the 50-row supported boundary preserves every row and closes all resources",
  { timeout: 60_000 },
  async () => {
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
