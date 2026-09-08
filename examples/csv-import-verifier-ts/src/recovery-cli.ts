import { closeSync, openSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { appendJournal, readJournal, recoverJournal } from "./recovery.js"
import { RunError } from "./model.js"

const stateDirectory = fileURLToPath(new URL("../.solari-state/", import.meta.url))
const usage =
  "npm run solari:recover -- --file <exact .solari-state/run-id.jsonl path> --live\nGET recorded resource IDs; at most one recovery DELETE each if active. Requires SOLARI_API_KEY. No .env files are read."

export function recoveryLockFailure(error: unknown, lockPath: string): string {
  if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") return "RECOVERY_UNCONFIRMED"
  return `RECOVERY_LOCKED: ${lockPath}\nThe lock may belong to an active recovery process or remain after a crash. Verify no recovery process is using this journal before manually removing only this exact lock file, then rerun the same recovery command. The lock and journal were left unchanged.`
}

export async function recoveryMain(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage)
    return 0
  }
  if (args.length !== 3 || args[0] !== "--file" || !args[1] || args[2] !== "--live") {
    console.log(usage)
    return 2
  }
  const file = resolve(args[1])
  let journal: ReturnType<typeof readJournal>
  try {
    journal = readJournal(file, stateDirectory)
  } catch {
    console.log("INVALID_RECOVERY_JOURNAL")
    return 2
  }
  const key = process.env.SOLARI_API_KEY
  if (!key || key.length < 16) {
    console.log("API_KEY_REQUIRED")
    return 2
  }
  let lock: number | undefined
  const lockPath = join(stateDirectory, `${journal.runId}.lock`)
  try {
    lock = openSync(lockPath, "wx", 0o600)
    const results = await recoverJournal(
      journal,
      async (method, path) => {
        const response = await fetch(`https://api.getsolari.com${path}`, {
          method,
          headers: { Authorization: `Bearer ${key}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw Object.assign(new RunError("RECOVERY_HTTP_ERROR"), { status: response.status })
        }
        const text = await response.text()
        return text ? (JSON.parse(text) as unknown) : undefined
      },
      (input) => appendJournal(file, input, stateDirectory),
    )
    console.log(
      JSON.stringify({ cleanupScope: "gateway API observations only", resources: results }),
    )
    return results.length > 0 && results.every((item) => item.status === "API_CONFIRMED") ? 0 : 3
  } catch (error) {
    console.log(lock === undefined ? recoveryLockFailure(error, lockPath) : "RECOVERY_UNCONFIRMED")
    return 3
  } finally {
    if (lock !== undefined) {
      closeSync(lock)
      unlinkSync(lockPath)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await recoveryMain(process.argv.slice(2))
