import { differenceCount } from "./report.js"
import { join } from "node:path"
import { parseLiveArgs } from "../index.js"
import { Budget } from "./budget.js"
import { bundleSpreadsheet } from "./bundle.js"
import { Secrets } from "./secrets.js"
import { packageRoot } from "./runner.js"
import { createJournal } from "./recovery.js"
import { readSpreadsheetInput, runSpreadsheet } from "./spreadsheet.js"
import { workerCancellation } from "./worker-process.js"

// Defense in depth: direct invocation still requires the live flag before reading a key/importing the live driver.
async function main(): Promise<number> {
  const args = parseLiveArgs(process.argv.slice(2))
  if (typeof args === "string" || !args.live) {
    console.log("LIVE_FLAG_REQUIRED")
    return 2
  }
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey || apiKey.length < 16) {
    console.log("API_KEY_REQUIRED")
    return 2
  }
  // Reject unsupported reviewer data before any live driver or resource acquisition.
  if (args.options.input) await readSpreadsheetInput(args.options.input)
  const bundle = await bundleSpreadsheet(args.options.variant)
  const journal = createJournal(packageRoot)
  console.log(`Private recovery journal: ${journal.path}`)
  const budget = new Budget()
  const cancellation = await workerCancellation(budget)
  try {
    const { createLiveDriver } = await import("./solari-driver.js")
    const { solariDependencies } = await import("./solari.js")
    const secrets = new Secrets()
    secrets.add(apiKey)
    const dependencies = solariDependencies(
      createLiveDriver(apiKey, budget),
      budget,
      bundle,
      secrets,
      journal.record,
    )
    const { report, directory } = await runSpreadsheet(
      { ...args.options, signal: cancellation.signal },
      dependencies,
    )
    console.log(`${report.outcome}: ${differenceCount(report) ?? "unavailable"} differences`)
    if (report.error) console.log(`${report.error.stage}: ${report.error.code}`)
    console.log(`Report: ${join(directory, "report.html")}`)
    return report.outcome === "PASS" ? 0 : report.outcome === "FAIL" ? 1 : 3
  } finally {
    cancellation.dispose()
    budget.dispose()
  }
}

try {
  process.exitCode = await main()
} catch {
  console.error("LIVE_RUN_FAILED: no complete evidence report; do not retry automatically")
  process.exitCode = 3
}
