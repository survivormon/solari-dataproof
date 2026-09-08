import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Budget } from "../src/budget.js"
import { createJournal, readJournal } from "../src/recovery.js"
import { Secrets } from "../src/secrets.js"
import { solariDependencies, type SolariDriver } from "../src/solari.js"
import { removeTestDirectory } from "./temp.js"

const browserId = "pool-fast-1:browser_test:org_test:12345.signed-capability"
const sandboxId = "pool-sbx-sta:vm_test:org_test.signed-capability"
const bundle = { sha256: "a".repeat(64), files: [] }
const limits = { workMs: 10_000, totalMs: 20_000, operationMs: 1_000, cleanupCallMs: 500 }

function driver(
  endpoint: string,
  beforeBrowser: () => void = () => {},
): { value: SolariDriver; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    value: {
      evidence: "offline-test",
      request: async (method, path) => {
        calls.push(`${method} ${path}`)
        if (method === "POST" && path === "/sessions")
          return { sessionId: browserId, wsEndpoint: endpoint }
        if (method === "POST" && path === "/sandboxes") return { sandboxId, controlUrl: endpoint }
        if (method === "DELETE") return undefined
        if (method === "GET" && path.startsWith("/sessions/")) return { status: "released" }
        if (method === "GET" && path.startsWith("/sandboxes/")) return { state: "gone" }
        throw new Error("Unexpected fake request")
      },
      browser: async () => {
        beforeBrowser()
        return { close: async () => {} } as Awaited<ReturnType<SolariDriver["browser"]>>
      },
      sandbox: () => assert.fail("Sandbox handle must not be created in these tests"),
      preview: async () => assert.fail("No preview in recovery integration tests"),
    },
  }
}

test("Solari acquisition is flushed before browser connection and cleanup lifecycle is journaled", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-recovery-integration-")),
    budget = new Budget(limits)
  try {
    const journal = createJournal(root),
      state = join(root, ".solari-state")
    const fake = driver("wss://api.getsolari.com/ws/synthetic", () => {
      assert.deepEqual(readJournal(journal.path, state).events, [
        { type: "acquired", resource: "browser", id: browserId, phase: "run" },
      ])
    })
    const dependencies = solariDependencies(
      fake.value,
      budget,
      bundle,
      new Secrets(),
      journal.record,
    )
    await dependencies.browser({ headed: false, timeoutMs: 1000 })
    const cleanup = await dependencies.finish!()
    assert.ok(cleanup.some((value) => value.status === "API_CONFIRMED"))
    const events = readJournal(journal.path, state).events
    assert.deepEqual(
      events.map((value) => value.type),
      ["acquired", "delete-attempted", "delete-acknowledged", "gateway-confirmed"],
    )
    assert.ok(!JSON.stringify(events).includes("wss:"))
  } finally {
    budget.dispose()
    await removeTestDirectory(root)
  }
})

test("malformed service endpoints retain ownership before validation and both resources still receive cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-recovery-integration-")),
    budget = new Budget(limits)
  try {
    const journal = createJournal(root),
      fake = driver("wss://unexpected.invalid/capability", () =>
        assert.fail("Must reject endpoint"),
      )
    const dependencies = solariDependencies(
      fake.value,
      budget,
      bundle,
      new Secrets(),
      journal.record,
    )
    await assert.rejects(dependencies.fixture(), /UNEXPECTED_CONTROL_ENDPOINT/)
    await assert.rejects(
      dependencies.browser({ headed: false, timeoutMs: 1000 }),
      /UNEXPECTED_CONTROL_ENDPOINT/,
    )
    assert.deepEqual(
      readJournal(journal.path, join(root, ".solari-state")).events.map((value) => value.type),
      ["acquired", "acquired"],
    )
    await dependencies.finish!()
    assert.deepEqual(
      fake.calls.filter((value) => value.startsWith("DELETE")),
      [
        `DELETE /sessions/${encodeURIComponent(browserId)}`,
        `DELETE /sandboxes/${encodeURIComponent(sandboxId)}`,
      ],
    )
  } finally {
    budget.dispose()
    await removeTestDirectory(root)
  }
})

test("journal storage failure stops acquisition but cannot skip independently owned cleanup", async () => {
  const budget = new Budget(limits),
    fake = driver("wss://api.getsolari.com/ws/synthetic", () =>
      assert.fail("No connection after failed journal write"),
    )
  try {
    const dependencies = solariDependencies(fake.value, budget, bundle, new Secrets(), () => {
      throw new Error("Disk unavailable")
    })
    await assert.rejects(dependencies.fixture(), /Disk unavailable/)
    await assert.rejects(
      dependencies.browser({ headed: false, timeoutMs: 1000 }),
      /Disk unavailable/,
    )
    const cleanup = await dependencies.finish!()
    assert.equal(fake.calls.filter((value) => value.startsWith("DELETE")).length, 2)
    assert.equal(cleanup.filter((value) => value.status === "API_CONFIRMED").length, 2)
    assert.ok(
      cleanup.some(
        (value) => value.resource === "private recovery journal" && value.status === "UNCONFIRMED",
      ),
    )
  } finally {
    budget.dispose()
  }
})
