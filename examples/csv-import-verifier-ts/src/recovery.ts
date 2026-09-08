import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { RunError } from "./model.js"

export type Resource = "sandbox" | "browser"
export interface ResourceEvent {
  type: "acquired" | "delete-attempted" | "delete-acknowledged" | "gateway-confirmed"
  resource: Resource
  id: string
  phase?: "run" | "recovery"
}
export interface Journal {
  runId: string
  startedAt: string
  events: ResourceEvent[]
}
type Request = (method: "GET" | "DELETE", path: string) => Promise<unknown>
export interface RecoveryResult {
  resource: Resource
  status: "API_CONFIRMED" | "UNCONFIRMED"
  deleteAttempted: boolean
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const bad = (): never => {
  throw new RunError("INVALID_RECOVERY_JOURNAL")
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : bad()
const keys = (value: object, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) bad()
}

function event(value: unknown, history: ResourceEvent[]): ResourceEvent {
  const v = object(value)
  keys(v, ["type", "resource", "id", "phase"])
  if (
    !["acquired", "delete-attempted", "delete-acknowledged", "gateway-confirmed"].includes(
      String(v.type),
    ) ||
    !["sandbox", "browser"].includes(String(v.resource)) ||
    typeof v.id !== "string" ||
    !/^[A-Za-z0-9_:.-]{1,1024}$/.test(v.id) ||
    v.id.startsWith("slr_live_") ||
    (v.phase !== undefined && v.phase !== "run" && v.phase !== "recovery")
  )
    bad()
  const e = { ...v, phase: v.phase ?? "run" } as unknown as ResourceEvent
  const previous = history.filter((item) => item.resource === e.resource)
  if (e.type === "acquired") {
    if (previous.length || e.phase !== "run") bad()
  } else {
    if (!previous.length || previous[0]!.id !== e.id) bad()
    if (previous.some((item) => item.type === e.type && item.phase === e.phase)) bad()
    if (
      e.type === "delete-acknowledged" &&
      !previous.some((item) => item.type === "delete-attempted" && item.phase === e.phase)
    )
      bad()
  }
  return e
}

export function parseJournal(text: string): Journal {
  try {
    if (Buffer.byteLength(text) > 65_536 || !text.endsWith("\n")) bad()
    const lines = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown)
    const header = object(lines.shift())
    keys(header, ["schemaVersion", "runId", "startedAt"])
    if (
      header.schemaVersion !== 1 ||
      typeof header.runId !== "string" ||
      !uuid.test(header.runId) ||
      typeof header.startedAt !== "string" ||
      new Date(header.startedAt).toISOString() !== header.startedAt
    )
      bad()
    const result: Journal = {
      runId: header.runId as string,
      startedAt: header.startedAt as string,
      events: [],
    }
    for (const line of lines) result.events.push(event(line, result.events))
    return result
  } catch {
    return bad()
  }
}

function checkedPath(file: string, stateDirectory: string): string {
  try {
    const directory = realpathSync(stateDirectory),
      target = resolve(file)
    if (
      !uuid.test(basename(target, ".jsonl")) ||
      !target.endsWith(".jsonl") ||
      lstatSync(stateDirectory).isSymbolicLink() ||
      resolve(dirname(target)) !== resolve(directory) ||
      lstatSync(target).isSymbolicLink() ||
      !lstatSync(target).isFile() ||
      lstatSync(target).size > 65_536 ||
      realpathSync(target) !== target
    )
      bad()
    return target
  } catch {
    return bad()
  }
}
export function readJournal(file: string, stateDirectory: string): Journal {
  const journal = parseJournal(readFileSync(checkedPath(file, stateDirectory), "utf8"))
  if (basename(file, ".jsonl") !== journal.runId) bad()
  return journal
}
function flush(file: string, text: string, flag: "ax" | "a"): void {
  const fd = openSync(file, flag, 0o600)
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
export function appendJournal(file: string, input: ResourceEvent, stateDirectory: string): void {
  const journal = readJournal(file, stateDirectory),
    normalized = event(input, journal.events)
  flush(file, `${JSON.stringify(normalized)}\n`, "a")
}
export function createJournal(
  packageRoot: string,
  runId = randomUUID(),
): { path: string; record(input: ResourceEvent): void } {
  if (!uuid.test(runId)) bad()
  const directory = resolve(packageRoot, ".solari-state")
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) bad()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(realpathSync(directory), `${runId}.jsonl`)
  flush(
    path,
    `${JSON.stringify({ schemaVersion: 1, runId, startedAt: new Date().toISOString() })}\n`,
    "ax",
  )
  return { path, record: (input) => appendJournal(path, input, directory) }
}

function httpStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined
}
async function observe(
  request: Request,
  resource: Resource,
  path: string,
): Promise<"terminal" | "active" | "unknown"> {
  try {
    const value = object(await request("GET", path)),
      state = resource === "browser" ? value.status : value.state
    if ((resource === "browser" ? ["released", "expired"] : ["gone"]).includes(String(state)))
      return "terminal"
    if (
      (resource === "browser"
        ? ["active"]
        : ["starting", "running", "paused", "archived"]
      ).includes(String(state))
    )
      return "active"
  } catch (error) {
    if (resource === "sandbox" && httpStatus(error) === 404) return "terminal"
  }
  return "unknown"
}

// Only recorded ownership grants cleanup scope. A lost create response cannot be recovered by listing or guessing IDs.
export async function recoverJournal(
  journal: Journal,
  request: Request,
  record: (input: ResourceEvent) => void,
): Promise<RecoveryResult[]> {
  const results: RecoveryResult[] = [],
    history = [...journal.events]
  const save = (input: ResourceEvent) => {
    const normalized = event(input, history)
    record(normalized)
    history.push(normalized)
  }
  for (const resource of ["browser", "sandbox"] as const) {
    const acquired = history.find((item) => item.resource === resource && item.type === "acquired")
    if (!acquired) continue
    const { id } = acquired,
      path = `${resource === "browser" ? "/sessions/" : "/sandboxes/"}${encodeURIComponent(id)}`
    let deleteAttempted = false,
      state = await observe(request, resource, path)
    try {
      if (
        state === "active" &&
        !history.some(
          (item) =>
            item.resource === resource &&
            item.type === "delete-attempted" &&
            item.phase === "recovery",
        )
      ) {
        save({ type: "delete-attempted", resource, id, phase: "recovery" })
        deleteAttempted = true
        try {
          const reply = await request("DELETE", path)
          if (reply && typeof reply === "object" && Reflect.get(reply, "ok") === false)
            throw new RunError("DELETE_REJECTED")
          save({ type: "delete-acknowledged", resource, id, phase: "recovery" })
        } catch {
          /* Observation remains independent of a lost DELETE acknowledgement. */
        }
        state = await observe(request, resource, path)
      }
      if (
        state === "terminal" &&
        !history.some(
          (item) =>
            item.resource === resource &&
            item.type === "gateway-confirmed" &&
            item.phase === "recovery",
        )
      ) {
        save({ type: "gateway-confirmed", resource, id, phase: "recovery" })
      }
      results.push({
        resource,
        status: state === "terminal" ? "API_CONFIRMED" : "UNCONFIRMED",
        deleteAttempted,
      })
    } catch {
      results.push({ resource, status: "UNCONFIRMED", deleteAttempted })
    }
  }
  return results
}
