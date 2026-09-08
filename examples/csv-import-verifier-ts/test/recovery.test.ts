import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createJournal,
  parseJournal,
  readJournal,
  recoverJournal,
  type Journal,
  type ResourceEvent,
} from "../src/recovery.js"
import { browserEnvironment, packageRoot } from "../src/runner.js"
import { removeTestDirectory } from "./temp.js"

const runId = "12345678-1234-4123-8123-123456789abc"
const header = { schemaVersion: 1, runId, startedAt: "2026-09-07T00:00:00.000Z" }
const owned: ResourceEvent[] = [
  { type: "acquired", resource: "sandbox", id: "sandbox-owned", phase: "run" },
  { type: "acquired", resource: "browser", id: "browser-owned", phase: "run" },
]
const encode = (events: unknown[], extraHeader = {}) =>
  [
    JSON.stringify({ ...header, ...extraHeader }),
    ...events.map((value) => JSON.stringify(value)),
  ].join("\n") + "\n"
const journal = (): Journal => parseJournal(encode(owned))

test("journal persists each event immediately and rejects extra fields, capabilities, invalid order, and truncated records", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-recovery-"))
  try {
    const writer = createJournal(root, runId),
      state = join(root, ".solari-state")
    assert.deepEqual(readJournal(writer.path, state).events, [])
    for (const value of owned) writer.record(value)
    assert.deepEqual(readJournal(writer.path, state).events, owned)
    const before = readFileSync(writer.path, "utf8")
    assert.throws(
      () => writer.record({ ...owned[0]!, id: "another-id" }),
      /INVALID_RECOVERY_JOURNAL/,
    )
    assert.equal(readFileSync(writer.path, "utf8"), before)
    for (const invalid of [
      encode([{ ...owned[0], token: "secret" }]),
      encode([{ ...owned[0], id: "slr_live_test-only" }]),
      encode([{ ...owned[0], id: "https://control.invalid" }]),
      encode([{ ...owned[0], id: "../unowned" }]),
      encode([{ ...owned[0], phase: "recovery" }]),
      encode([{ ...owned[0], type: "delete-attempted" }]),
      encode([owned[0], { ...owned[0], type: "delete-acknowledged" }]),
      encode(owned, { secret: "no" }),
      encode(owned, { runId: "not-uuid" }),
      before.slice(0, -1),
    ])
      assert.throws(() => parseJournal(invalid), /INVALID_RECOVERY_JOURNAL/)
    const outside = join(root, `${runId}.jsonl`)
    writeFileSync(outside, before)
    assert.throws(() => readJournal(outside, state), /INVALID_RECOVERY_JOURNAL/)
  } finally {
    await removeTestDirectory(root)
  }
})

test("recovery GETs exact owned IDs before DELETE and confirms both independently without leaking IDs", async () => {
  const calls: string[] = [],
    saved: ResourceEvent[] = [],
    gone = new Set<string>()
  const result = await recoverJournal(
    journal(),
    async (method, path) => {
      calls.push(`${method} ${path}`)
      if (method === "DELETE") {
        gone.add(path)
        return undefined
      }
      if (path.startsWith("/sessions/")) return { status: gone.has(path) ? "released" : "active" }
      if (gone.has(path))
        throw Object.assign(new Error("private-capability must not be emitted"), { status: 404 })
      return { state: "running" }
    },
    (value) => saved.push(value),
  )
  assert.deepEqual(calls, [
    "GET /sessions/browser-owned",
    "DELETE /sessions/browser-owned",
    "GET /sessions/browser-owned",
    "GET /sandboxes/sandbox-owned",
    "DELETE /sandboxes/sandbox-owned",
    "GET /sandboxes/sandbox-owned",
  ])
  assert.equal(saved.filter((value) => value.type === "delete-attempted").length, 2)
  assert.ok(saved.every((value) => value.phase === "recovery"))
  assert.ok(result.every((value) => value.status === "API_CONFIRMED"))
  assert.ok(!JSON.stringify(result).includes("owned"))
})

test("signed composite resource IDs survive disk and become one encoded path segment", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-recovery-"))
  try {
    const writer = createJournal(root),
      id = "pool-fast-1:12345678-1234-4123-8123-123456789abc:org_synthetic:1234567890.signature-123"
    writer.record({ type: "acquired", resource: "browser", id })
    const parsed = readJournal(writer.path, join(root, ".solari-state")),
      calls: string[] = []
    assert.equal(parsed.events[0]!.id, id)
    let gone = false
    const result = await recoverJournal(
      parsed,
      async (method, path) => {
        calls.push(`${method} ${path}`)
        if (method === "DELETE") {
          gone = true
          return undefined
        }
        return { status: gone ? "released" : "active" }
      },
      writer.record,
    )
    assert.deepEqual(
      calls,
      ["GET", "DELETE", "GET"].map((method) => `${method} /sessions/${encodeURIComponent(id)}`),
    )
    assert.equal(result[0]!.status, "API_CONFIRMED")
    for (const rejected of [
      "id?token=secret",
      "id#secret",
      "id/another",
      "id secret",
      "id\\another",
      "x".repeat(1025),
    ]) {
      assert.throws(
        () => parseJournal(encode([{ type: "acquired", resource: "browser", id: rejected }])),
        /INVALID_RECOVERY_JOURNAL/,
      )
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("unknown/404 browser state never authorizes deletion; a failing browser cannot skip sandbox recovery", async () => {
  for (const unknown of ["unknown", "releasing", 404]) {
    const calls: string[] = []
    const result = await recoverJournal(
      journal(),
      async (method, path) => {
        calls.push(`${method} ${path}`)
        if (path.startsWith("/sessions/")) {
          if (unknown === 404) throw Object.assign(new Error("secret"), { status: 404 })
          return { status: unknown }
        }
        return { state: "gone" }
      },
      () => {},
    )
    assert.deepEqual(calls, ["GET /sessions/browser-owned", "GET /sandboxes/sandbox-owned"])
    assert.equal(result[0]!.status, "UNCONFIRMED")
    assert.equal(result[1]!.status, "API_CONFIRMED")
  }
})

test("a recovery DELETE is persisted before request and cannot repeat on a later invocation", async () => {
  const current = journal(),
    saved: ResourceEvent[] = []
  let deletes = 0
  const request = async (method: "GET" | "DELETE", path: string) => {
    if (method === "DELETE") {
      assert.equal(saved.at(-1)!.type, "delete-attempted")
      deletes++
      throw new Error("private raw response")
    }
    return path.startsWith("/sessions/") ? { status: "active" } : { state: "running" }
  }
  const first = await recoverJournal(current, request, (value) => saved.push(value))
  assert.equal(deletes, 2)
  assert.ok(first.every((value) => value.status === "UNCONFIRMED"))
  const second = await recoverJournal(parseJournal(encode([...owned, ...saved])), request, () =>
    assert.fail("No event expected"),
  )
  assert.equal(deletes, 2)
  assert.ok(second.every((value) => !value.deleteAttempted))
})

test("terminal observations require no DELETE and journal write failure prevents mutation", async () => {
  for (const terminal of ["released", "expired"]) {
    const result = await recoverJournal(
      journal(),
      async (method, path) => {
        assert.equal(method, "GET")
        return path.startsWith("/sessions/") ? { status: terminal } : { state: "gone" }
      },
      () => {},
    )
    assert.ok(result.every((value) => value.status === "API_CONFIRMED" && !value.deleteAttempted))
  }
  let gets = 0
  const result = await recoverJournal(
    journal(),
    async (method, path) => {
      assert.equal(method, "GET")
      gets++
      return path.startsWith("/sessions/") ? { status: "active" } : { state: "running" }
    },
    () => {
      throw new Error("disk unavailable")
    },
  )
  assert.equal(gets, 2)
  assert.ok(result.every((value) => value.status === "UNCONFIRMED" && !value.deleteAttempted))
})

test("actual recovery CLI rejects unscoped or nonlive requests before reading keys or reaching network", () => {
  const writer = createJournal(packageRoot)
  try {
    for (const [args, code, forbidKey] of [
      [["--help"], 0, true],
      [["--file", writer.path], 2, true],
      [["--file", join(packageRoot, "README.md"), "--live"], 2, true],
      [["--file", writer.path, "--live"], 2, false],
    ] as const) {
      const result = spawnSync(
        process.execPath,
        ["--import", "./test/no-network.mjs", "--import", "tsx", "src/recovery-cli.ts", ...args],
        {
          cwd: packageRoot,
          env: { ...browserEnvironment(), ...(forbidKey ? { CSV_FORBID_KEY_READ: "1" } : {}) },
          encoding: "utf8",
          timeout: 20_000,
        },
      )
      assert.equal(result.status, code, result.stderr + result.stdout)
      assert.ok(!result.stderr.includes("TRIPWIRE"))
    }
  } finally {
    unlinkSync(writer.path)
  }
})
