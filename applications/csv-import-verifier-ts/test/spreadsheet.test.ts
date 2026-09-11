import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"
import type { ImportAdapter } from "../src/spreadsheet-adapter.js"
import { compare } from "../src/compare.js"
import { parseExport } from "../src/model.js"
import { packageRoot } from "../src/runner.js"
import { normalizeSpreadsheetCSV, spreadsheetAdapter } from "../src/spreadsheet-adapter.js"
import { request } from "node:http"
import { serveSpreadsheet, spreadsheetFiles } from "../src/spreadsheet-source.js"
import { removeTestDirectory } from "./temp.js"

test("spreadsheet: normalization preserves every regression case's exact text", async () => {
  const { cases } = JSON.parse(
    await readFile(new URL("./support/cases.json", import.meta.url), "utf8"),
  )
  for (const item of cases) {
    const actual = normalizeSpreadsheetCSV(Buffer.from(item.csv))
    assert.deepEqual(compare(parseExport(item.expected), actual).differences, [], item.id)
  }
})

test("spreadsheet: malformed exports cannot produce an integrity verdict", () => {
  const header = "source_row,customer_id,name,note\n"
  for (const text of [
    "",
    header,
    "customer_id,name,note\n0017,Ada,hello",
    header + "2,0017,Ada",
    header + "2,0017,Ada,note,extra",
    header + '2,0017,Ada,"unclosed',
    header + "2,,Ada,note",
    ...["1", "0", "-2", "2.5", "2e1", "02", "Infinity", "9007199254740992"].map(
      (row) => header + `${row},0017,Ada,note`,
    ),
    header + "2,0017,Ada,note\n2,0042,Renée,hello",
  ]) {
    assert.throws(() => normalizeSpreadsheetCSV(Buffer.from(text)))
  }
  assert.throws(() => normalizeSpreadsheetCSV(Buffer.alloc(256_001)), { code: "EXPORT_TOO_LARGE" })
})

test("spreadsheet: valid replacement characters survive but malformed UTF-8 never becomes one", () => {
  const prefix = Buffer.from("source_row,customer_id,name,note\n2,0017,Ada,")
  const suffix = Buffer.from("\n")
  const valid = Buffer.concat([prefix, Buffer.from("\uFFFD Renée 李"), suffix])
  assert.equal(normalizeSpreadsheetCSV(valid).accepted[0]!.note, "\uFFFD Renée 李")
  for (const invalid of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]]) {
    const bytes = Buffer.concat([prefix, Buffer.from(invalid), suffix])
    assert.throws(() => normalizeSpreadsheetCSV(bytes), { code: "INVALID_UTF8" })
  }
})

test("spreadsheet: missing or changed upstream source stops before serving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-spreadsheet-source-"))
  try {
    await assert.rejects(spreadsheetFiles(directory), { code: "SPREADSHEET_NOT_INSTALLED" })
    // LICENSE is first in the pinned inventory; changed bytes must not be repaired silently.
    await writeFile(join(directory, "LICENSE"), "deliberately changed")
    await assert.rejects(spreadsheetFiles(directory), { code: "UPSTREAM_HASH_MISMATCH" })
    assert.equal(await readFile(join(directory, "LICENSE"), "utf8"), "deliberately changed")
  } finally {
    await removeTestDirectory(directory)
  }
})

test("spreadsheet: malformed request URLs do not terminate the server", async () => {
  const server = await serveSpreadsheet(new Map([["/index.html", Buffer.from("healthy")]]))
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(server.url, { path: "//[", timeout: 1_000 }, (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode))
      })
      req.on("error", reject)
      req.on("timeout", () => req.destroy(new Error("Request timed out")))
      req.end()
    })
    assert.equal(status, 400)
    assert.equal(await (await fetch(server.url)).text(), "healthy")
  } finally {
    await server.close()
  }
})

test(
  "spreadsheet: stalled, failed and oversized browser transfers retain no fake export",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "csv-spreadsheet-transfer-"))
    try {
      for (const failure of ["stream", "status", "oversized", "origin"] as const) {
        let cancelled = 0
        const download = {
          url: () =>
            failure === "origin"
              ? "https://unexpected.invalid/export.csv"
              : "blob:http://127.0.0.1:3210/test-download",
          createReadStream: async () =>
            failure === "stream"
              ? await new Promise<Readable>(() => {})
              : Readable.from([Buffer.alloc(failure === "oversized" ? 256_001 : 1)]),
          failure: async () => (failure === "status" ? await new Promise<string>(() => {}) : null),
          cancel: async () => {
            cancelled++
          },
        }
        const locator = {
          waitFor: async () => {},
          setInputFiles: async () => {},
          click: async () => {},
          textContent: async () => "CSV imported successfully",
        }
        const page = {
          goto: async () => ({ ok: () => true }),
          reload: async () => ({ ok: () => true }),
          url: () => "http://127.0.0.1:3210/",
          content: async () => "<p>synthetic test</p>",
          locator: () => locator,
          getByText: () => locator,
          waitForURL: async () => {},
          screenshot: async () => {},
          waitForEvent: async () => download,
        } as unknown as Parameters<ImportAdapter>[0]
        await assert.rejects(
          spreadsheetAdapter(page, {
            url: "http://127.0.0.1:3210",
            inputPath: join(packageRoot, "demo", "customers.csv"),
            outputDirectory: directory,
            timeoutMs: 25,
            onStep: () => {},
          }),
          {
            code:
              failure === "oversized"
                ? "EXPORT_TOO_LARGE"
                : failure === "origin"
                  ? "UNEXPECTED_EXPORT_URL"
                  : "EXPORT_TIMEOUT",
          },
        )
        assert.equal(cancelled, 1)
        assert.deepEqual(await readdir(directory), [])
      }
    } finally {
      await removeTestDirectory(directory)
    }
  },
)
