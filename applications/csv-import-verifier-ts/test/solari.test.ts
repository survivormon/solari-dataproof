import { runWithTestInput } from "./support/run.js"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import type { Browser } from "playwright"
import { Budget, type Limits } from "../src/budget.js"
import { Secrets } from "../src/secrets.js"
import { solariDependencies, type SolariDriver } from "../src/solari.js"
import { createLiveDriver } from "../src/solari-driver.js"
import { packageRoot } from "../src/runner.js"
import { renderReport } from "../src/report.js"
import { removeTestDirectory } from "./temp.js"
import { RunError } from "../src/model.js"
import type { ImportAdapter } from "../src/spreadsheet-adapter.js"
import { workerCancellation } from "../src/worker-process.js"

const syntheticKey = "slr_live_synthetic_test_only_123456"
const sandboxId = "private-sandbox-capability",
  browserId = "private-browser-capability",
  token = "private-preview-capability"
const limits: Limits = { workMs: 10_000, totalMs: 20_000, operationMs: 1_000, cleanupCallMs: 500 }
const bundle = {
  sha256: "a".repeat(64),
  files: [
    { path: "/tmp/csv-import-verifier/dist/server.mjs", bytes: Buffer.from("// synthetic bundle") },
  ],
}

function fakeDriver(failure = "") {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const closed: string[] = [],
    commands: string[][] = []
  const fail = (step: string) => {
    if (step === failure) throw new Error(`${syntheticKey} ${token} unexpected diagnostic`)
  }
  const driver: SolariDriver = {
    evidence: "offline-test",
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === "POST" && path === "/sandboxes") {
        fail("sandbox-create")
        return { sandboxId, controlUrl: `wss://api.getsolari.com/control/${sandboxId}` }
      }
      if (method === "POST" && path === "/sessions") {
        fail("browser-create")
        return { sessionId: browserId, wsEndpoint: `wss://api.getsolari.com/ws/${browserId}` }
      }
      if (path.endsWith("/ports/3000")) {
        fail("preview")
        return { url: `https://unit.preview.getsolari.com/?pt_token=${token}`, token }
      }
      if (method === "DELETE") {
        fail(path.startsWith("/sessions/") ? "browser-delete" : "sandbox-delete")
        return undefined
      }
      if (method === "GET" && path.startsWith("/sessions/"))
        return { status: failure === "unconfirmed" ? "active" : "released" }
      if (method === "GET" && path.startsWith("/sandboxes/"))
        return { state: failure === "unconfirmed" ? "running" : "gone" }
      throw new Error("Unexpected fake request")
    },
    sandbox: () => ({
      connect: async () => {
        fail("connect")
      },
      close: () => {
        closed.push("sandbox channel")
      },
      write: async () => {
        fail("upload")
      },
      run: async (command, args) => {
        commands.push([command, ...args])
        fail("command")
        return { exitCode: 0, stdout: "v18.20.8", stderr: "" }
      },
      start: async (command, args) => {
        commands.push([command, ...args])
        fail("start")
      },
    }),
    browser: async () => {
      fail("browser-connect")
      return {
        version: () => "offline-test",
        isConnected: () => true,
        close: async () => {
          closed.push("browser")
        },
        newContext: async () => ({
          close: async () => {
            closed.push("context")
          },
          setDefaultTimeout() {},
          setDefaultNavigationTimeout() {},
          route: async () => {},
          setExtraHTTPHeaders: async (headers: unknown) =>
            assert.deepEqual(headers, { "x-pinetree-preview-token": token }),
          newPage: async () => ({ isClosed: () => true }),
        }),
      } as unknown as Browser
    },
    preview: async () => {
      fail("readiness")
      return {
        status: 200,
        value: { service: "csv-import-verifier", schemaVersion: 1, ready: true },
      }
    },
  }
  return { driver, calls, closed, commands }
}

async function runFake(
  root: string,
  fake: ReturnType<typeof fakeDriver>,
  budget = new Budget(limits),
  signal?: AbortSignal,
) {
  const secrets = new Secrets()
  secrets.add(syntheticKey)
  const deps = solariDependencies(fake.driver, budget, bundle, secrets)
  const adapter: ImportAdapter = async (_, input) => {
    const bytes = await readFile(join(packageRoot, "test", "support", "fixtures", "expected.json"))
    input.validateArtifact?.(bytes)
    const exportPath = join(input.outputDirectory, "observed.json")
    await writeFile(exportPath, bytes)
    return { exportPath, beforeReloadPath: exportPath, successMessage: "Import successful" }
  }
  try {
    return await runWithTestInput({ outputRoot: root, signal }, { ...deps, adapter })
  } finally {
    budget.dispose()
  }
}

test("Solari orchestration uses one bounded resource pair and labels simulated evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-solari-"))
  try {
    const fake = fakeDriver()
    const { report } = await runFake(root, fake)
    assert.equal(report.outcome, "PASS")
    assert.equal(report.solari?.evidence, "offline-test")
    assert.match(renderReport(report), /SIMULATED SOLARI/)
    assert.deepEqual(report.solari?.createRequests, { sandbox: 1, browser: 1 })
    const body = fake.calls.find((c) => c.path === "/sandboxes")!.body as Record<string, unknown>
    assert.equal(body.cpu, 1)
    assert.equal(body.memMb, 2048)
    assert.deepEqual(body.lifecycle, { onTimeout: "kill" })
    assert.equal(body.envs, undefined)
    assert.ok(!JSON.stringify(fake.commands).includes(token))
    assert.ok(!JSON.stringify(fake.commands).includes(syntheticKey))
    const deleteIndices = fake.calls.flatMap((c, i) => (c.method === "DELETE" ? [i] : []))
    const observations = fake.calls.flatMap((c, i) =>
      c.method === "GET" && !c.path.includes("/ports/") ? [i] : [],
    )
    assert.equal(deleteIndices.length, 2)
    assert.ok(Math.min(...observations) > Math.max(...deleteIndices))
    assert.equal(report.cleanup.filter((c) => c.status === "API_CONFIRMED").length, 2)
    for (const secret of [syntheticKey, sandboxId, browserId, token])
      assert.ok(!JSON.stringify(report).includes(secret))
  } finally {
    await removeTestDirectory(root)
  }
})

test("setup/connect/readiness failures preserve known ownership and never replace creates", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-solari-fail-"))
  try {
    for (const fault of [
      "sandbox-create",
      "connect",
      "command",
      "upload",
      "preview",
      "start",
      "readiness",
      "browser-create",
      "browser-connect",
    ]) {
      const fake = fakeDriver(fault)
      const { report } = await runFake(root, fake)
      assert.equal(report.outcome, "INFRA_ERROR", fault)
      assert.ok(
        fake.calls.filter((c) => c.method === "POST" && c.path === "/sandboxes").length <= 1,
      )
      assert.ok(fake.calls.filter((c) => c.method === "POST" && c.path === "/sessions").length <= 1)
      if (fault !== "sandbox-create")
        assert.ok(
          fake.calls.some((c) => c.method === "DELETE" && c.path.includes(sandboxId)),
          fault,
        )
      if (fault === "browser-connect")
        assert.ok(fake.calls.some((c) => c.method === "DELETE" && c.path.includes(browserId)))
      for (const secret of [syntheticKey, sandboxId, browserId, token])
        assert.ok(!JSON.stringify(report).includes(secret))
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("canceled admission does not count or report an uncertain create for either resource", async () => {
  for (const resource of ["sandbox", "browser"] as const) {
    const budget = new Budget(limits),
      fake = fakeDriver()
    const deps = solariDependencies(fake.driver, budget, bundle, new Secrets())
    try {
      budget.work.abort(new RunError("INTERRUPTED"))
      await assert.rejects(
        resource === "sandbox" ? deps.fixture() : deps.browser({ headed: false, timeoutMs: 1_000 }),
        { code: "DEADLINE_EXCEEDED" },
      )
      assert.deepEqual(fake.calls, [])
      assert.deepEqual(deps.metadata!().createRequests, { sandbox: 0, browser: 0 })
      assert.deepEqual(await deps.finish!(), [])
      assert.deepEqual(fake.closed, [])
    } finally {
      budget.dispose()
    }
  }
})

test("a dispatched create with a lost response remains counted and unconfirmed", async () => {
  for (const resource of ["sandbox", "browser"] as const) {
    const budget = new Budget(limits),
      fake = fakeDriver(`${resource}-create`)
    const deps = solariDependencies(fake.driver, budget, bundle, new Secrets())
    try {
      await assert.rejects(
        resource === "sandbox" ? deps.fixture() : deps.browser({ headed: false, timeoutMs: 1_000 }),
      )
      assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1)
      assert.deepEqual(deps.metadata!().createRequests, {
        sandbox: resource === "sandbox" ? 1 : 0,
        browser: resource === "browser" ? 1 : 0,
      })
      assert.deepEqual(await deps.finish!(), [
        {
          resource: `${resource === "sandbox" ? "sandbox" : "browser session"} create outcome`,
          status: "UNCONFIRMED",
        },
      ])
      assert.equal(
        fake.calls.length,
        1,
        "an unknown create outcome cannot trigger guessed cleanup requests",
      )
    } finally {
      budget.dispose()
    }
  }
})

test("failed browser deletion still attempts sandbox deletion; acknowledgements alone cannot pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-solari-cleanup-"))
  try {
    for (const fault of ["browser-delete", "sandbox-delete", "unconfirmed"]) {
      const fake = fakeDriver(fault)
      const { report } = await runFake(root, fake)
      assert.equal(report.outcome, "INFRA_ERROR")
      assert.equal(fake.calls.filter((c) => c.method === "DELETE").length, 2)
      assert.ok(report.cleanup.some((c) => c.status === "UNCONFIRMED"))
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("a late create response is owned during cleanup, with no subsequent browser creation", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "csv-solari-late-"))
  try {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
    const fake = fakeDriver(),
      original = fake.driver.request
    let dispatched!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { dispatched = resolve })
    const response = new Promise<void>((resolve) => { release = resolve })
    fake.driver.request = async (...args) => {
      if (args[0] === "POST") {
        dispatched()
        await response
      }
      return original(...args)
    }
    const running = runFake(
      root,
      fake,
      new Budget({ ...limits, operationMs: 50, cleanupCallMs: 500 }),
    )
    await started
    t.mock.timers.tick(51)
    await new Promise<void>((resolve) => setImmediate(resolve))
    release()
    const { report } = await running
    assert.equal(report.outcome, "INFRA_ERROR")
    assert.equal(report.error?.code, "DEADLINE_EXCEEDED")
    assert.ok(fake.calls.some((c) => c.method === "DELETE" && c.path.includes(sandboxId)))
    assert.ok(!fake.calls.some((c) => c.method === "POST" && c.path === "/sessions"))
  } finally {
    t.mock.timers.reset()
    await removeTestDirectory(root)
  }
})

test("the installed core SDK makes exactly one HTTP attempt, even for idempotent 503s", async () => {
  const budget = new Budget(limits)
  try {
    let attempts = 0
    const fakeFetch: typeof fetch = async (url, init) => {
      attempts++
      assert.equal(String(url), "https://api.getsolari.com/sandboxes")
      assert.equal(init?.redirect, "error")
      assert.ok(init?.signal)
      return new Response(JSON.stringify({ error: "capacity unavailable", retryable: true }), {
        status: 503,
      })
    }
    const driver = createLiveDriver(syntheticKey, budget, fakeFetch)
    await assert.rejects(driver.request("POST", "/sandboxes", {}, "synthetic-idempotency-key"))
    assert.equal(attempts, 1)
  } finally {
    budget.dispose()
  }
})

test("capabilities and credentials are refused before artifact publication", () => {
  const secrets = new Secrets()
  secrets.add(syntheticKey)
  secrets.add(token)
  secrets.add(browserId)
  for (const value of [
    syntheticKey,
    token,
    browserId,
    "https://host/?pt_token=unknown",
    "wss://api.getsolari.com/cdp/unknown",
  ]) {
    assert.throws(
      () => secrets.check(`{"value":${JSON.stringify(value)}}`),
      /SENSITIVE_ARTIFACT_BLOCKED/,
    )
  }
  assert.doesNotThrow(() => secrets.check('{"outcome":"FAIL","customer_id":"0017"}'))
})

test("temporary active gateway views settle without another create or DELETE", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-solari-propagation-"))
  try {
    const fake = fakeDriver(),
      original = fake.driver.request
    let browserViews = 0
    fake.driver.request = async (...args) => {
      const value = await original(...args)
      if (args[0] === "GET" && args[1].startsWith("/sessions/")) {
        browserViews++
        return { status: browserViews < 3 ? "active" : "released" }
      }
      return value
    }
    const { report } = await runFake(root, fake, new Budget({ ...limits, cleanupCallMs: 100 }))
    assert.equal(report.outcome, "PASS")
    assert.equal(browserViews, 3)
    assert.equal(
      fake.calls.filter((c) => c.method === "DELETE" && c.path.startsWith("/sessions/")).length,
      1,
    )
    assert.deepEqual(report.solari?.createRequests, { sandbox: 1, browser: 1 })
  } finally {
    await removeTestDirectory(root)
  }
})

test("interrupting active work stops it promptly while leaving cleanup available", async () => {
  const budget = new Budget(limits)
  try {
    const work = budget.run(() => new Promise<never>(() => {}))
    budget.work.abort(new RunError("INTERRUPTED"))
    await assert.rejects(work, /INTERRUPTED/)
    await assert.rejects(
      budget.run(async () => 1),
      /DEADLINE_EXCEEDED/,
    )
    budget.beginCleanup()
    assert.equal(await budget.run(async () => 42), 42)
  } finally {
    budget.dispose()
  }
})

test("unexpected preview hosts and explicit DELETE rejection fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-solari-endpoint-"))
  try {
    for (const condition of ["host", "delete"]) {
      const fake = fakeDriver(),
        original = fake.driver.request
      fake.driver.request = async (...args) => {
        const value = await original(...args)
        if (condition === "host" && args[1].includes("/ports/"))
          return { url: "https://example.org/?pt_token=synthetic", token }
        if (condition === "delete" && args[0] === "DELETE" && args[1].startsWith("/sessions/"))
          return { ok: false }
        return value
      }
      const { report } = await runFake(root, fake)
      assert.equal(report.outcome, "INFRA_ERROR")
      if (condition === "host") assert.equal(report.error?.code, "UNEXPECTED_PREVIEW_ENDPOINT")
      else
        assert.ok(
          report.cleanup.some(
            (r) => r.resource === "browser session DELETE" && r.status === "UNCONFIRMED",
          ),
        )
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("cloud interruption during cleanup preserves its verdict and completes all owned cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-solari-cleanup-interrupt-"))
  const budget = new Budget(limits)
  const cancellation = await workerCancellation(budget)
  try {
    const fake = fakeDriver(), originalBrowser = fake.driver.browser
    fake.driver.browser = async (...args) => {
      const browser = await originalBrowser(...args) as Browser
      const originalContext = browser.newContext.bind(browser)
      browser.newContext = async (...contextArgs) => {
        const context = await originalContext(...contextArgs), close = context.close.bind(context)
        context.close = async () => {
          assert.equal(budget.cleaning, true)
          process.emit("SIGINT")
          process.emit("SIGTERM")
          await close()
        }
        return context
      }
      return browser
    }
    const { report, directory } = await runFake(root, fake, budget, cancellation.signal)
    assert.equal(report.outcome, "INFRA_ERROR")
    assert.deepEqual(report.error, { stage: "cleanup", code: "INTERRUPTED" })
    assert.equal(report.comparison?.differences.length, 0)
    assert.deepEqual(fake.closed, ["context", "browser", "sandbox channel"])
    assert.deepEqual(fake.calls.filter((call) => call.method === "DELETE").map((call) => call.path), [
      `/sessions/${browserId}`, `/sandboxes/${sandboxId}`,
    ])
    assert.equal(report.cleanup.filter((item) => item.status === "API_CONFIRMED").length, 2)
    assert.ok(report.cleanup.every((item) => !["FAILED", "UNCONFIRMED"].includes(item.status)))
    const saved = JSON.parse(await readFile(join(directory, "report.json"), "utf8"))
    assert.equal(saved.outcome, "INFRA_ERROR")
    assert.deepEqual(saved.error, report.error)
  } finally {
    cancellation.dispose()
    budget.dispose()
    await removeTestDirectory(root)
  }
})
