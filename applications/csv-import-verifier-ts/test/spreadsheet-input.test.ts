import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import type { Dependencies } from "../src/runner.js"
import { parseSpreadsheetArgs, spreadsheetMain } from "../src/spreadsheet-cli.js"
import { readSpreadsheetInput, runSpreadsheet } from "../src/spreadsheet.js"
import { removeTestDirectory } from "./temp.js"

const header = "source_row,customer_id,name,note\n"
const row = { sourceRow: 2, customer_id: "0017", name: "Ada", note: "hello" }
const expected = { schemaVersion: 1, accepted: [row], rejected: [] }

async function writeInput(
  root: string,
  csv: string | Buffer = header + "2,0017,Ada,hello\n",
  oracle: unknown = expected,
) {
  const input = { csv: join(root, "customers.csv"), expected: join(root, "expected.json") }
  await writeFile(input.csv, csv)
  await writeFile(input.expected, JSON.stringify(oracle))
  return input
}

test("spreadsheet arguments require a complete file pair and reject removed demo controls", () => {
  assert.deepEqual(parseSpreadsheetArgs([]), {})
  assert.equal(parseSpreadsheetArgs(["--help"]), null)
  assert.throws(() => parseSpreadsheetArgs(["--negative-control"]), /INVALID_ARGUMENTS/)
  for (const variant of ["upstream", "patched"]) {
    assert.deepEqual(
      parseSpreadsheetArgs([
        "--expected",
        "oracle.json",
        "--variant",
        variant,
        "--input",
        "customers.csv",
        "--headed",
      ]),
      {
        input: { csv: resolve("customers.csv"), expected: resolve("oracle.json") },
        variant,
        headed: true,
      },
    )
  }
  for (const args of [
    ["--input"],
    ["--expected"],
    ["--input", "customers.csv"],
    ["--expected", "oracle.json"],
    ["--input", "--expected", "oracle.json"],
    ["--variant"],
    ["--variant", "unknown"],
    ["--input", "customers.csv", "--expected", "oracle.json", "--negative-control"],
    ["--input", "first.csv", "--input", "second.csv", "--expected", "oracle.json"],
    ["--headed", "--headed"],
    ["--live"],
    ["--help", "--headed"],
  ])
    assert.throws(() => parseSpreadsheetArgs(args), { code: "INVALID_ARGUMENTS" }, args.join(" "))
})

test("user input keeps exact validated bytes and an independent oracle after source files change", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-user-input-"))
  try {
    const csv = Buffer.from(
      '\uFEFFsource_row,customer_id,name,note\r\n2,0017,Renée,"  keep spaces\r\nand commas, too  "\r\n',
    )
    const oracle = {
      schemaVersion: 1,
      accepted: [{ ...row, name: "Independent expected name", note: "=1+1" }],
      rejected: [],
    }
    const files = await writeInput(root, csv, oracle)
    const oracleBytes = Buffer.from(JSON.stringify(oracle, null, 2) + "\n")
    await writeFile(files.expected, oracleBytes)
    const captured = await readSpreadsheetInput(files)
    await writeFile(files.csv, "changed after validation")
    await writeFile(files.expected, "changed after validation")
    assert.deepEqual(captured.csv, csv)
    assert.deepEqual(captured.expected, oracleBytes)
    assert.notDeepEqual(captured.csv, await readFile(files.csv))
  } finally {
    await removeTestDirectory(root)
  }
})

test("invalid CSV schemas and invalid or unsupported oracles are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-user-schema-"))
  try {
    for (const csv of [
      "customer_id,name,note\n0017,Ada,hello\n",
      header,
      header + "2,0017,Ada\n",
      header + "2,0017,Ada,hello\n2,0042,Renée,hello\n",
      header + "2,0017,Ada,hello\n3,0017,Copy,hello\n",
    ]) {
      await assert.rejects(readSpreadsheetInput(await writeInput(root, csv)))
    }
    for (const oracle of [
      { ...expected, schemaVersion: 2 },
      { ...expected, accepted: [{ ...row, customer_id: 17 }] },
      { ...expected, accepted: [{ ...row, name: null }] },
      { ...expected, accepted: [row, row] },
      { ...expected, accepted: [row, { ...row, sourceRow: 3 }] },
      { ...expected, accepted: [] },
      { ...expected, rejected: [{ sourceRow: 3, customer_id: "0017", reason: "DUPLICATE_ID" }] },
    ])
      await assert.rejects(readSpreadsheetInput(await writeInput(root, undefined, oracle)))
    const input = await writeInput(root)
    await writeFile(input.expected, "{unfinished")
    await assert.rejects(readSpreadsheetInput(input), { code: "INVALID_EXPECTED_JSON" })
  } finally {
    await removeTestDirectory(root)
  }
})

test("both CSV and oracle enforce 50-row and byte-size limits independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-user-limits-"))
  try {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      ...row,
      sourceRow: index + 2,
      customer_id: `C-${index}`,
    }))
    const csv = (count: number) =>
      header +
      rows
        .slice(0, count)
        .map((value) => `${value.sourceRow},${value.customer_id},Ada,hello\n`)
        .join("")
    await readSpreadsheetInput(
      await writeInput(root, csv(50), { ...expected, accepted: rows.slice(0, 50) }),
    )
    await assert.rejects(readSpreadsheetInput(await writeInput(root, csv(51))), {
      code: "UNSUPPORTED_SPREADSHEET_INPUT",
    })
    await assert.rejects(
      readSpreadsheetInput(await writeInput(root, undefined, { ...expected, accepted: rows })),
      { code: "UNSUPPORTED_SPREADSHEET_INPUT" },
    )
    for (const which of ["csv", "expected"] as const) {
      const input = await writeInput(root)
      await writeFile(input[which], "é".repeat(128_001))
      await assert.rejects(readSpreadsheetInput(input), { code: "INPUT_TOO_LARGE" })
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("invalid user input and a requested demo edit stop before serving or browser acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-user-preflight-"))
  try {
    const acquired: string[] = []
    const backend: Dependencies = {
      fixture: async () => {
        acquired.push("fixture")
        throw new Error("Fixture must not start")
      },
      browser: async () => {
        acquired.push("browser")
        throw new Error("Browser must not start")
      },
      adapter: async () => {
        throw new Error("Adapter must not run")
      },
    }
    const input = await writeInput(root, "wrong,header\n")
    await assert.rejects(runSpreadsheet({ input, outputRoot: join(root, "output") }, backend), {
      code: "INVALID_SPREADSHEET_EXPORT",
    })
    assert.deepEqual(acquired, [])
    assert.deepEqual((await readdir(root)).sort(), ["customers.csv", "expected.json"])
  } finally {
    await removeTestDirectory(root)
  }
})

test("CSV and oracle UTF-8 failures stop before acquisition while valid U+FFFD is accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-user-utf8-"))
  try {
    const acquired: string[] = []
    const backend: Dependencies = {
      fixture: async () => {
        acquired.push("fixture")
        throw new Error("Unexpected acquisition")
      },
      browser: async () => {
        acquired.push("browser")
        throw new Error("Unexpected acquisition")
      },
      adapter: async () => {
        throw new Error("Unexpected adapter")
      },
    }
    const oracle = { ...expected, accepted: [{ ...row, note: "\uFFFD" }] }
    for (const role of ["csv", "expected"] as const) {
      const input = await writeInput(root, header + "2,0017,Ada,\uFFFD\n", oracle)
      await readSpreadsheetInput(input)
      const text = (await readFile(input[role])).toString("utf8")
      const [before, after] = text.split("\uFFFD")
      await writeFile(
        input[role],
        Buffer.concat([Buffer.from(before!), Buffer.from([0xff]), Buffer.from(after!)]),
      )
      await assert.rejects(runSpreadsheet({ input, outputRoot: join(root, "output") }, backend), {
        code: "INVALID_UTF8",
      })
    }
    assert.deepEqual(acquired, [])
    assert.deepEqual((await readdir(root)).sort(), ["customers.csv", "expected.json"])
  } finally {
    await removeTestDirectory(root)
  }
})

test("input diagnostics identify file roles without exposing paths or malformed JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "csv-user-errors-"))
  const errors = t.mock.method(console, "error", () => {})
  try {
    const input = await writeInput(root)
    const cases = [
      { ...input, csv: join(root, "private-missing-csv"), code: "CSV_FILE_NOT_FOUND" },
      { ...input, expected: join(root, "private-missing-oracle"), code: "EXPECTED_FILE_NOT_FOUND" },
      { ...input, csv: root, code: "CSV_FILE_UNREADABLE" },
      { ...input, expected: root, code: "EXPECTED_FILE_UNREADABLE" },
    ]
    for (const item of cases) {
      await assert.rejects(readSpreadsheetInput(item), { code: item.code })
      assert.equal(await spreadsheetMain(["--input", item.csv, "--expected", item.expected]), 3)
    }
    await writeFile(input.expected, '{"private_note":"NEVER_PRINT_THIS",unfinished')
    assert.equal(await spreadsheetMain(["--input", input.csv, "--expected", input.expected]), 3)
    assert.deepEqual(
      errors.mock.calls.map((call) => [String(call.arguments[0]).split(":")[0]]),
      [...cases.map((item) => [item.code]), ["INVALID_EXPECTED_JSON"]],
    )
    const output = errors.mock.calls.map((call) => call.arguments.join(" ")).join("\n")
    assert.doesNotMatch(output, /private-missing|NEVER_PRINT_THIS/)
    assert.ok(!output.includes(root))
    assert.match(output, /--input/)
    assert.match(output, /--expected/)
    assert.deepEqual((await readdir(root)).sort(), ["customers.csv", "expected.json"])
  } finally {
    await removeTestDirectory(root)
  }
})
