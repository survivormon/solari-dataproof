// Verify a spreadsheet CSV round trip with a Solari browser and sandbox.
// Use --plan to inspect resource limits, or --live to run the check.
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { browserEnvironment } from "./src/runner.js"
import { LIVE_LIMITS } from "./src/budget.js"
import { RunError } from "./src/model.js"
import { parseSpreadsheetArgs } from "./src/spreadsheet-cli.js"
import type { SpreadsheetOptions } from "./src/spreadsheet.js"
import { runNodeWorker } from "./src/worker-process.js"

export const liveUsage = `Solari CSV import verifier
  npm start -- --plan
  npm start -- --variant upstream --live
  npm start -- --input customers.csv --expected expected.json --variant patched --live
--live authorizes one sandbox and one browser create request. No replacement creates.
120s work cutoff; cleanup budget ends at 180s. Process watchdog: 200s.
Requires SOLARI_API_KEY supplied in the caller environment. No .env files are read.`

export function parseLiveArgs(
  args: string[],
): { options: SpreadsheetOptions; live: boolean } | "plan" | "help" {
  if (args.length === 1 && args[0] === "--plan") return "plan"
  if (args.length === 1 && args[0] === "--help") return "help"
  if (
    args.filter((arg) => arg === "--live").length > 1 ||
    args.some((arg) => ["--headed", "--timeout-ms"].includes(arg))
  ) {
    throw new RunError("INVALID_ARGUMENTS")
  }
  const options = parseSpreadsheetArgs(args.filter((arg) => arg !== "--live"))
  if (!options) throw new RunError("INVALID_ARGUMENTS")
  return { options, live: args.includes("--live") }
}

export function liveEnvironment(apiKey: string): Record<string, string> {
  return { ...browserEnvironment(), SOLARI_API_KEY: apiKey }
}

interface CliDependencies {
  key(): string | undefined
  execute(args: string[], env: Record<string, string>): Promise<number>
  output(text: string): void
}
const defaults: CliDependencies = {
  key: () => process.env.SOLARI_API_KEY,
  output: (text) => console.log(text),
  execute: (args, env) =>
    runNodeWorker(
      ["--import", "tsx", fileURLToPath(new URL("src/live-worker.ts", import.meta.url)), ...args],
      env,
    ),
}

export async function liveMain(
  args: string[],
  dependencies: CliDependencies = defaults,
): Promise<number> {
  let parsed: ReturnType<typeof parseLiveArgs>
  try {
    parsed = parseLiveArgs(args)
  } catch {
    dependencies.output(liveUsage)
    return 2
  }
  if (parsed === "help") {
    dependencies.output(liveUsage)
    return 0
  }
  if (parsed === "plan") {
    dependencies.output(
      JSON.stringify(
        {
          live: false,
          limits: LIVE_LIMITS,
          sandbox: {
            count: 1,
            template: "base",
            cpu: 1,
            memMb: 2048,
            idleTimeoutMs: 120_000,
            onTimeout: "kill",
          },
          browser: { count: 1, stealth: false, recording: false, proxy: false, profiles: false },
          createRetries: 0,
          guestInstalls: 0,
          target:
            "pinned independent spreadsheet (--variant upstream|patched; optional --input/--expected)",
          operations: [
            "validate input and bundle locally",
            "create sandbox",
            "upload self-contained app bundle",
            "start server",
            "poll signed preview readiness",
            "create browser",
            "upload CSV",
            "download UI export before/after reload for spreadsheet",
            "compare",
            "close connections",
            "DELETE both resources",
            "observe both gateway states",
          ],
          retryPolicy: "No automatic retry after an execution or cleanup failure.",
        },
        null,
        2,
      ),
    )
    return 0
  }
  if (!parsed.live) {
    dependencies.output("LIVE_FLAG_REQUIRED")
    return 2
  }
  const apiKey = dependencies.key()
  if (!apiKey) {
    dependencies.output("API_KEY_REQUIRED")
    return 2
  }
  if (apiKey.length < 16) {
    dependencies.output("API_KEY_TOO_SHORT")
    return 2
  }
  // A fresh process prevents ambient debug/proxy/NODE_OPTIONS configuration from logging capabilities.
  return dependencies.execute(args, liveEnvironment(apiKey))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await liveMain(process.argv.slice(2))
