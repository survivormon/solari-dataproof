import { fileURLToPath, pathToFileURL } from "node:url"
import { join, resolve } from "node:path"
import { runDemo, type DemoOptions } from "./demo.js"
import { describeError } from "./diagnostics.js"
import { RunError } from "./model.js"

export const demoUsage = `Usage: npm run demo -- [--headed]
Run the frozen sample against the original and patched spreadsheet.
Exit 0: demonstration verified; 1: unexpected result; 2: invalid arguments; 3: incomplete run.
Setup: npm ci && npm run spreadsheet:install && npm run browser:install
Linux browser system dependencies: npm run browser:install -- --with-deps
No Solari account or API key is needed.`
export function parseDemoArgs(args: string[]): DemoOptions | null {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return null
  if (args.length === 0) return {}
  if (args.length === 1 && args[0] === "--headed") return { headed: true }
  throw new RunError("INVALID_ARGUMENTS")
}
export async function demoMain(args: string[]): Promise<number> {
  let options: DemoOptions | null
  try {
    options = parseDemoArgs(args)
  } catch {
    console.error(demoUsage)
    return 2
  }
  if (!options) {
    console.log(demoUsage)
    return 0
  }
  const controller = new AbortController()
  const cancel = () => controller.abort(new RunError("DEMO_INTERRUPTED"))
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    console.log("DataProof: verifying the original and patched spreadsheet…")
    const { summary, directory } = await runDemo({ ...options, signal: controller.signal })
    for (const item of summary.cases)
      console.log(
        `${item.variant}: ${item.report.outcome} · ${item.report.beforeReloadComparison?.differences.length ?? "unavailable"} differences before reload · ${item.report.comparison?.differences.length ?? "unavailable"} after reload`,
      )
    console.log(
      summary.outcome === "VERIFIED"
        ? "Demo verified: original defects reproduced, patched records preserved, cleanup complete."
        : `Demo ${summary.outcome.toLowerCase().replaceAll("_", " ")}.`,
    )
    if (summary.error)
      console.error(
        `${summary.error.code}: ${describeError(summary.error.code, summary.error.stage)}`,
      )
    console.log(pathToFileURL(join(directory, "index.html")).href)
    return summary.outcome === "VERIFIED" ? 0 : summary.outcome === "UNEXPECTED_RESULT" ? 1 : 3
  } catch (error) {
    const code = error instanceof RunError ? error.code : "DEMO_RUN_FAILED"
    console.error(`${code}: ${describeError(code, "preflight")}`)
    return 3
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await demoMain(process.argv.slice(2))
