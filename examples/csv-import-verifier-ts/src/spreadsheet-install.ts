import { installSpreadsheet } from "./spreadsheet-source.js"
import { RunError } from "./model.js"

try {
  const result = await installSpreadsheet()
  console.log(
    `Spreadsheet source: ${result.downloaded} files downloaded, ${result.verified} immutable files verified.`,
  )
} catch (error) {
  console.error(error instanceof RunError ? error.code : "SPREADSHEET_INSTALL_FAILED")
  process.exitCode = 3
}
