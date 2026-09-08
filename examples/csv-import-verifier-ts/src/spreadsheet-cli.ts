import { differenceCount } from "./report.js"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { RunError } from "./model.js"
import { runSpreadsheet, type SpreadsheetOptions } from "./spreadsheet.js"

export const spreadsheetUsage = `Usage: npm run local -- [--input customers.csv --expected expected.json] [--variant upstream|patched] [--headed]
Omit input files to reproduce the real defects using demo/customers.csv and demo/expected.json.
Fixed columns: source_row,customer_id,name,note. Unique customer IDs; maximum 50 rows, 256 KB per input file.
Expected JSON is independently authored: {schemaVersion:1, accepted:[...], rejected:[]}.
Uses the pinned independent app locally; no Solari credentials or resources.`

export function parseSpreadsheetArgs(args: string[]): SpreadsheetOptions | null {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return null
  const options: SpreadsheetOptions = {},
    seen = new Set<string>()
  let csv: string | undefined, expected: string | undefined
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (seen.has(flag)) throw new RunError("INVALID_ARGUMENTS")
    seen.add(flag)
    if (flag === "--headed") options.headed = true
    else if (["--input", "--expected", "--variant"].includes(flag)) {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new RunError("INVALID_ARGUMENTS")
      if (flag === "--input") csv = resolve(value)
      else if (flag === "--expected") expected = resolve(value)
      else if (value === "upstream" || value === "patched") options.variant = value
      else throw new RunError("INVALID_ARGUMENTS")
    } else throw new RunError("INVALID_ARGUMENTS")
  }
  if (!!csv !== !!expected) throw new RunError("INVALID_ARGUMENTS")
  if (csv && expected) options.input = { csv, expected }
  return options
}

export async function spreadsheetMain(args: string[]): Promise<number> {
  let options: SpreadsheetOptions | null
  try {
    options = parseSpreadsheetArgs(args)
  } catch {
    console.error(spreadsheetUsage)
    return 2
  }
  if (!options) {
    console.log(spreadsheetUsage)
    return 0
  }
  try {
    const { report, directory } = await runSpreadsheet(options)
    console.log(`${report.outcome}: ${differenceCount(report) ?? "unavailable"} differences`)
    if (report.error) console.error(`${report.error.stage}: ${report.error.code}`)
    console.log(`${directory}/report.html`)
    return report.outcome === "PASS" ? 0 : report.outcome === "FAIL" ? 1 : 3
  } catch (error) {
    console.error(error instanceof RunError ? error.code : "SPREADSHEET_RUN_FAILED")
    return 3
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await spreadsheetMain(process.argv.slice(2))
