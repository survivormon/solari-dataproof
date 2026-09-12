import { installSpreadsheet } from "./spreadsheet-source.js"
import { RunError } from "./model.js"
import { describeError } from "./diagnostics.js"

try {
  const result = await installSpreadsheet()
  console.log(
    `Spreadsheet source: ${result.downloaded} files downloaded, ${result.verified} immutable files verified.`,
  )
} catch (error) {
  const code = error instanceof RunError ? error.code : "SPREADSHEET_INSTALL_FAILED"
  console.error(`${code}: ${describeError(code, "preflight")}`)
  process.exitCode = 3
}
