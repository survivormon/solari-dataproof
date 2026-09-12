import { spawn } from "node:child_process"
import type { Budget } from "./budget.js"
import { RunError } from "./model.js"

// This backstop belongs to one owned Node process. Graceful cleanup ends at 180s;
// the existing 200s deadline must terminate even a worker that handles SIGTERM.
export function runNodeWorker(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 200_000,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    })
    let interrupted = false, ready = false
    const send = (message: string) => {
      if (child.connected) child.send(message, () => {})
    }
    const interrupt = () => {
      if (interrupted) return
      interrupted = true
      if (ready) send("dataproof:interrupt")
    }
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", interrupt)
    child.on("message", (message) => {
      if (message !== "dataproof:ready" || ready) return
      ready = true
      send(interrupted ? "dataproof:interrupt" : "dataproof:start")
    })
    const finish = (code: number | null) => {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", interrupt)
      resolve(interrupted ? 3 : (code ?? 3))
    }
    child.once("error", () => finish(3))
    child.once("exit", finish)
  })
}

export async function workerCancellation(budget: Budget) {
  const caller = new AbortController()
  let start!: () => void
  const ready = new Promise<void>((resolve) => { start = resolve })
  const interrupt = () => {
    const reason = new RunError("INTERRUPTED")
    caller.abort(reason)
    budget.work.abort(reason)
    start()
  }
  const message = (value: unknown) => {
    if (value === "dataproof:interrupt") interrupt()
    else if (value === "dataproof:start") start()
  }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  process.on("message", message)
  process.on("disconnect", interrupt)
  // IPC transports cancellation; it must not keep a completed worker alive.
  process.channel?.unref()
  if (process.send) {
    process.send("dataproof:ready", (error) => { if (error) interrupt() })
    await ready
  }
  return {
    signal: caller.signal,
    dispose() {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", interrupt)
      process.off("message", message)
      process.off("disconnect", interrupt)
    },
  }
}
