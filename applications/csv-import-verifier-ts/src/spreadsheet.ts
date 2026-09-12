import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { localBrowser, packageRoot, runVerification, type Dependencies } from "./runner.js"
import { decodeUtf8, parseExport, RunError } from "./model.js"
import { normalizeSpreadsheetCSV, spreadsheetAdapter } from "./spreadsheet-adapter.js"
import {
  spreadsheetCommit,
  spreadsheetFiles,
  serveSpreadsheet,
  type SpreadsheetVariant,
} from "./spreadsheet-source.js"

export interface SpreadsheetOptions {
  signal?: AbortSignal
  headed?: boolean
  outputRoot?: string
  input?: { csv: string; expected: string }
  variant?: SpreadsheetVariant
}

async function readInputFile(file: string, role: "CSV" | "EXPECTED"): Promise<Buffer> {
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new RunError(`${role}_FILE_UNREADABLE`)
    if (info.size > 256_000) throw new RunError("INPUT_TOO_LARGE")
    const bytes = await readFile(file)
    if (bytes.length > 256_000) throw new RunError("INPUT_TOO_LARGE")
    return bytes
  } catch (error) {
    if (error instanceof RunError) throw error
    const missing = ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
    throw new RunError(`${role}_FILE_${missing ? "NOT_FOUND" : "UNREADABLE"}`)
  }
}

export async function readSpreadsheetInput(input: NonNullable<SpreadsheetOptions["input"]>) {
  // Read each file once; the validated bytes, not mutable paths, become run evidence.
  const [csv, expected] = await Promise.all([
    readInputFile(input.csv, "CSV"),
    readInputFile(input.expected, "EXPECTED"),
  ])
  const records = normalizeSpreadsheetCSV(csv)
  const expectedText = decodeUtf8(expected)
  let value: unknown
  try {
    value = JSON.parse(expectedText)
  } catch {
    throw new RunError("INVALID_EXPECTED_JSON")
  }
  const oracle = parseExport(value)
  if (
    records.accepted.length > 50 ||
    oracle.accepted.length === 0 ||
    oracle.accepted.length > 50 ||
    oracle.rejected.length ||
    [records, oracle].some(
      (value) =>
        new Set(value.accepted.map((row) => row.customer_id)).size !== value.accepted.length,
    )
  ) {
    throw new RunError("UNSUPPORTED_SPREADSHEET_INPUT")
  }
  return { csv, expected }
}

export async function runSpreadsheet(
  options: SpreadsheetOptions = {},
  backend?: Omit<Dependencies, "adapter">,
) {
  options.signal?.throwIfAborted()
  const input = await readSpreadsheetInput(
    options.input ?? {
      csv: join(packageRoot, "demo", "customers.csv"),
      expected: join(packageRoot, "demo", "expected.json"),
    },
  )
  options.signal?.throwIfAborted()
  const variant = options.variant ?? "upstream"
  const source = await spreadsheetFiles(undefined, variant)
  return runVerification(
    {
      headed: options.headed,
      signal: options.signal,
      input,
      outputRoot: options.outputRoot ?? join(packageRoot, "output", "external"),
    },
    {
      ...(backend ?? {
        fixture: () => serveSpreadsheet(source.files),
        browser: localBrowser,
      }),
      adapter: spreadsheetAdapter,
      importer: {
        name: "Spreadsheet Live (supunlakmal/spreadsheet)",
        revision: spreadsheetCommit,
        variant,
        sourceSha256: source.sha256,
        policy:
          "Customer rows preserved as exact text under the fixed source_row, customer_id, name, note schema. At most 50 user rows; no duplicate rejection or formula policy. Persistence is the upstream app's URL fragment.",
      },
    },
  )
}
