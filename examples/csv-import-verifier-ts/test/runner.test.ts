import { runWithTestInput } from "./support/run.js"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { errors, type Browser } from "playwright"
import { packageRoot, type Dependencies } from "../src/runner.js"
import { RunError } from "../src/model.js"
import { differenceCount, renderReport } from "../src/report.js"
import { removeTestDirectory } from "./temp.js"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeDependencies(failAt = "", closeFailures: string[] = []) {
  const closed: string[] = []
  const acquire = (name: string) => {
    if (failAt === name) throw new RunError("INJECTED_FAILURE")
  }
  const close = async (name: string) => {
    closed.push(name)
    if (closeFailures.includes(name)) throw new Error("injected")
  }
  const dependencies: Dependencies = {
    fixture: async () => {
      acquire("fixture")
      return { url: "http://127.0.0.1:1", close: () => close("fixture") }
    },
    browser: async () => {
      acquire("browser")
      return {
        close: () => close("browser"),
        version: () => "unit-double",
        isConnected: () => failAt !== "disconnect",
        newContext: async () => {
          acquire("context")
          return {
            close: () => close("context"),
            setDefaultTimeout() {},
            setDefaultNavigationTimeout() {},
            route: async () => {},
            newPage: async () => {
              acquire("page")
              return { isClosed: () => true }
            },
          }
        },
      } as unknown as Browser
    },
    adapter: async (_, input) => {
      input.onStep("export")
      if (failAt === "timeout") throw new errors.TimeoutError("injected timeout")
      if (failAt === "disconnect") throw new Error("injected disconnect")
      acquire("adapter")
      const exportPath = join(input.outputDirectory, "observed.json")
      await writeFile(
        exportPath,
        failAt === "export"
          ? "not json"
          : await readFile(join(packageRoot, "test", "support", "fixtures", "expected.json")),
      )
      return { exportPath, successMessage: "Import successful" }
    },
  }
  return { dependencies, closed }
}

test("corruption before reload cannot be hidden by a later matching export", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-checkpoints-"))
  try {
    const fake = fakeDependencies()
    const adapter = fake.dependencies.adapter
    fake.dependencies.adapter = async (page, input) => {
      const observed = await adapter(page, input)
      const before = JSON.parse(await readFile(observed.exportPath, "utf8"))
      before.accepted[0].name = "<script>changed</script>\r\nA\u00a0B"
      const beforeReloadPath = join(input.outputDirectory, "before-reload.json")
      await writeFile(beforeReloadPath, JSON.stringify(before))
      return { ...observed, beforeReloadPath }
    }
    const { report } = await runWithTestInput({ outputRoot: root }, fake.dependencies)
    assert.equal(report.outcome, "FAIL")
    assert.equal(report.error, null)
    assert.deepEqual(report.comparison?.differences, [])
    assert.equal(differenceCount(report), 1)
    assert.equal(report.beforeReloadComparison?.differences[0]?.field, "name")
    const html = renderReport(report)
    assert.match(html, /Before reload/)
    assert.match(html, /&lt;script&gt;changed&lt;\/script&gt;/)
    assert.ok(html.includes("\\r\\nA\\u00a0B"))
    assert.equal(
      report.beforeReloadComparison?.differences[0]?.actual,
      "<script>changed</script>\r\nA\u00a0B",
    )
    assert.ok(!html.includes("<script>"))
    assert.ok(report.cleanup.every((item) => item.status === "CLOSED"))
  } finally {
    await removeTestDirectory(root)
  }
})

test("a missing or malformed pre-reload export prevents a completed verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-checkpoint-error-"))
  try {
    for (const malformed of [false, true]) {
      const fake = fakeDependencies()
      const adapter = fake.dependencies.adapter
      fake.dependencies.adapter = async (page, input) => {
        const observed = await adapter(page, input)
        const beforeReloadPath = join(input.outputDirectory, "before-reload.json")
        if (malformed) await writeFile(beforeReloadPath, "not JSON")
        return { ...observed, beforeReloadPath }
      }
      const { report } = await runWithTestInput({ outputRoot: root }, fake.dependencies)
      assert.equal(report.outcome, "INFRA_ERROR")
      assert.equal(report.error?.stage, "compare")
      assert.equal(report.comparison, null)
      assert.equal(differenceCount(report), undefined)
      assert.deepEqual(fake.closed, ["context", "browser", "fixture"])
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("every acquisition failure closes only owned resources, in reverse order", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-runner-"))
  try {
    for (const [stage, expected] of [
      ["fixture", []],
      ["browser", ["fixture"]],
      ["context", ["browser", "fixture"]],
      ["page", ["context", "browser", "fixture"]],
      ["adapter", ["context", "browser", "fixture"]],
    ] as const) {
      const fake = fakeDependencies(stage)
      const { report } = await runWithTestInput({ outputRoot: root }, fake.dependencies)
      assert.equal(report.outcome, "INFRA_ERROR", stage)
      assert.deepEqual(fake.closed, expected, stage)
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("timeout, disconnect, and invalid export never produce PASS", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-failure-"))
  try {
    for (const [fault, code] of [
      ["timeout", "TIMEOUT"],
      ["disconnect", "BROWSER_DISCONNECTED"],
      ["export", "INVALID_JSON"],
    ]) {
      const fake = fakeDependencies(fault)
      const { report } = await runWithTestInput({ outputRoot: root }, fake.dependencies)
      assert.equal(report.outcome, "INFRA_ERROR")
      assert.equal(report.error?.code, code)
      assert.equal(report.comparison, null)
      assert.deepEqual(fake.closed, ["context", "browser", "fixture"])
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("a context cleanup failure cannot skip browser/server cleanup or preserve PASS", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-cleanup-"))
  try {
    const fake = fakeDependencies("", ["context", "browser"])
    const { report } = await runWithTestInput({ outputRoot: root }, fake.dependencies)
    assert.equal(report.comparison?.differences.length, 0)
    assert.equal(report.outcome, "INFRA_ERROR")
    assert.equal(report.error?.code, "CLEANUP_FAILED")
    assert.deepEqual(fake.closed, ["context", "browser", "fixture"])
    assert.deepEqual(
      report.cleanup.map((r) => r.status),
      ["FAILED", "FAILED", "CLOSED"],
    )
    assert.ok(
      report.cleanup
        .slice(0, 2)
        .every((r) => r.errorCode === "CLOSE_REJECTED" && r.elapsedMs! >= 0),
    )
    assert.match(renderReport(report), /CLOSE_REJECTED/)
  } finally {
    await removeTestDirectory(root)
  }
})

test("invalid UTF-8 is refused before any resource acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-encoding-"))
  try {
    const fake = fakeDependencies()
    const { report } = await runWithTestInput(
      {
        outputRoot: root,
        input: { csv: Buffer.from([0xff]), expected: Buffer.from("{}") },
      },
      fake.dependencies,
    )
    assert.equal(report.error?.code, "INVALID_UTF8")
    assert.deepEqual(report.steps, ["preflight"])
    assert.deepEqual(fake.closed, [])
  } finally {
    await removeTestDirectory(root)
  }
})

test("sensitive input is refused before copying evidence or acquiring resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-sensitive-input-"))
  try {
    const fake = fakeDependencies()
    fake.dependencies.validateArtifact = (bytes) => {
      if (String(bytes).includes("SYNTHETIC_PRIVATE_MARKER"))
        throw new RunError("SENSITIVE_ARTIFACT")
    }
    const oracle = await readFile(join(packageRoot, "test", "support", "fixtures", "expected.json"))
    for (const where of ["csv", "expected"] as const) {
      const expected =
        where === "expected"
          ? Buffer.from(oracle.toString().replace("0017", "SYNTHETIC_PRIVATE_MARKER"))
          : oracle
      const { report, directory } = await runWithTestInput(
        {
          outputRoot: root,
          input: {
            csv: Buffer.from(where === "csv" ? "SYNTHETIC_PRIVATE_MARKER" : "plain input"),
            expected,
          },
        },
        fake.dependencies,
      )
      assert.equal(report.outcome, "INFRA_ERROR")
      assert.equal(report.error?.code, "SENSITIVE_ARTIFACT")
      assert.deepEqual(report.steps, ["preflight"])
      assert.deepEqual(fake.closed, [])
      await assert.rejects(readFile(join(directory, "input.csv")), { code: "ENOENT" })
      await assert.rejects(readFile(join(directory, "expected.json")), { code: "ENOENT" })
    }
  } finally {
    await removeTestDirectory(root)
  }
})

test("HTML evidence escapes data and links only fixed artifact names", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-report-"))
  try {
    const { report } = await runWithTestInput({ outputRoot: root }, fakeDependencies().dependencies)
    const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>'
    report.successMessage = hostile
    report.comparison!.differences.push({
      code: "FIELD_CHANGED",
      customerId: hostile,
      sourceRow: 2,
      field: "note",
      expected: hostile,
      actual: "'&",
    })
    report.artifacts.push("javascript:alert(1)")
    const html = renderReport(report)
    assert.ok(html.includes("&lt;script&gt;"))
    assert.ok(!html.includes("<script"))
    assert.ok(!html.includes("javascript:"))
    assert.ok(!html.includes("<img src=x"))
  } finally {
    await removeTestDirectory(root)
  }
})

test("validated user buffers replace frozen demo paths and retain an independent failing oracle", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-runner-user-"))
  try {
    const csv = Buffer.from("source_row,customer_id,name,note\n2,0017,Ada,user-provided\n")
    const expected = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        accepted: [{ sourceRow: 2, customer_id: "0017", name: "Ada", note: "user-provided" }],
        rejected: [],
      }),
    )
    const fake = fakeDependencies()
    fake.dependencies.adapter = async (_, input) => {
      assert.deepEqual(await readFile(input.inputPath), csv)
      const exportPath = join(input.outputDirectory, "observed.json")
      await writeFile(
        exportPath,
        JSON.stringify({
          schemaVersion: 1,
          accepted: [{ sourceRow: 2, customer_id: "17", name: "Ada", note: "user-provided" }],
          rejected: [],
        }),
      )
      return { exportPath, successMessage: "Import successful" }
    }
    const { report, directory } = await runWithTestInput(
      {
        outputRoot: root,
        input: { csv, expected },
      },
      fake.dependencies,
    )
    assert.equal(report.outcome, "FAIL")
    assert.ok(report.comparison!.differences.length > 0)
    assert.equal(report.comparison!.expectedAccepted, 1)
    assert.deepEqual(await readFile(join(directory, "input.csv")), csv)
    assert.deepEqual(await readFile(join(directory, "expected.json")), expected)
    const { createHash } = await import("node:crypto")
    assert.equal(report.input!.sha256, createHash("sha256").update(csv).digest("hex"))
    assert.equal(report.input!.expectedSha256, createHash("sha256").update(expected).digest("hex"))
  } finally {
    await removeTestDirectory(root)
  }
})

test(
  "stalled context and browser closes cannot skip fixture cleanup or prevent a failure report",
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "csv-runner-stalled-cleanup-"))
    try {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
      const fake = fakeDependencies()
      const contextStarted = deferred(),
        browserStarted = deferred()
      const stall = (name: string) => {
        fake.closed.push(name)
        if (name === "context") contextStarted.resolve()
        else browserStarted.resolve()
        return new Promise<void>(() => {})
      }
      fake.dependencies.browser = async () =>
        ({
          version: () => "unit-double",
          isConnected: () => true,
          close: () => stall("browser"),
          newContext: async () => ({
            close: () => stall("context"),
            setDefaultTimeout() {},
            setDefaultNavigationTimeout() {},
            route: async () => {},
            newPage: async () => ({ isClosed: () => true }),
          }),
        }) as unknown as Browser
      const running = runWithTestInput({ outputRoot: root }, fake.dependencies)
      await contextStarted.promise
      t.mock.timers.tick(6_001)
      await browserStarted.promise
      t.mock.timers.tick(35_001)
      const { report, directory } = await running
      assert.equal(report.comparison?.differences.length, 0)
      assert.equal(report.outcome, "INFRA_ERROR")
      assert.deepEqual(report.error, { stage: "cleanup", code: "CLEANUP_FAILED" })
      assert.deepEqual(fake.closed, ["context", "browser", "fixture"])
      assert.deepEqual(
        report.cleanup.map(({ resource, status }) => ({ resource, status })),
        [
          { resource: "browser context", status: "FAILED" },
          { resource: "browser", status: "FAILED" },
          { resource: "fixture server", status: "CLOSED" },
        ],
      )
      assert.equal(report.cleanup[0]!.errorCode, "DEADLINE_EXCEEDED")
      assert.equal(report.cleanup[1]!.errorCode, "DEADLINE_EXCEEDED")
      assert.ok(report.cleanup[0]!.elapsedMs! >= 6_000)
      assert.ok(report.cleanup[1]!.elapsedMs! >= 35_000)
      const saved = JSON.parse(await readFile(join(directory, "report.json"), "utf8"))
      assert.equal(saved.outcome, "INFRA_ERROR")
      assert.deepEqual(saved.cleanup, report.cleanup)
      assert.match(await readFile(join(directory, "report.html"), "utf8"), /INFRA_ERROR/)
    } finally {
      t.mock.timers.reset()
      await removeTestDirectory(root)
    }
  },
)

test(
  "slow acknowledged local browser closure is visible and must finish before PASS is published",
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "csv-runner-slow-cleanup-"))
    try {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
      const fake = fakeDependencies(),
        started = deferred(),
        closed = deferred()
      const originalBrowser = fake.dependencies.browser
      fake.dependencies.browser = async (options) => {
        const browser = await originalBrowser(options)
        browser.close = () => {
          started.resolve()
          return closed.promise
        }
        return browser
      }
      let returned = false
      const running = runWithTestInput({ outputRoot: root }, fake.dependencies).then((value) => {
        returned = true
        return value
      })
      await started.promise
      t.mock.timers.tick(23_000)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(returned, false, "dispatched close without acknowledgement cannot publish PASS")
      closed.resolve()
      const { report } = await running
      assert.equal(report.outcome, "PASS")
      assert.deepEqual(
        report.cleanup.find((item) => item.resource === "browser"),
        { resource: "browser", status: "CLOSED", elapsedMs: 23_000, slow: true },
      )
      assert.match(renderReport(report), /slow closure; 23000 ms/)
    } finally {
      t.mock.timers.reset()
      await removeTestDirectory(root)
    }
  },
)

test("interruption at the final export read cannot publish a successful comparison", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-final-read-abort-"))
  try {
    const fake = fakeDependencies(),
      controller = new AbortController()
    let finalReadGuarded = false
    fake.dependencies.signal = controller.signal
    fake.dependencies.guard = async (operation) => {
      const value = await operation()
      if (Buffer.isBuffer(value)) {
        finalReadGuarded = true
        controller.abort(new RunError("INTERRUPTED"))
      }
      return value
    }
    const { report } = await runWithTestInput({ outputRoot: root }, fake.dependencies)
    assert.equal(finalReadGuarded, true)
    assert.equal(report.outcome, "INFRA_ERROR")
    assert.deepEqual(report.error, { stage: "compare", code: "INTERRUPTED" })
    assert.equal(report.comparison, null)
    assert.deepEqual(fake.closed, ["context", "browser", "fixture"])
  } finally {
    await removeTestDirectory(root)
  }
})

test("invalid UTF-8 cannot become matching JSON evidence or enter input artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-runner-utf8-"))
  try {
    const expected = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        accepted: [{ sourceRow: 2, customer_id: "C-1", name: "\uFFFD", note: "" }],
        rejected: [],
      }),
    )
    const position = expected.indexOf(Buffer.from("\uFFFD"))
    const malformed = Buffer.concat([
      expected.subarray(0, position),
      Buffer.from([0xff]),
      expected.subarray(position + 3),
    ])
    for (const which of ["csv", "expected", "export"] as const) {
      const fake = fakeDependencies()
      fake.dependencies.adapter = async (_, input) => {
        const exportPath = join(input.outputDirectory, "observed.json")
        await writeFile(exportPath, malformed)
        return { exportPath, successMessage: "Synthetic encoding test" }
      }
      const { report, directory } = await runWithTestInput(
        {
          outputRoot: root,
          input: {
            csv: which === "csv" ? Buffer.from([0xff]) : Buffer.from("plain CSV"),
            expected: which === "expected" ? malformed : expected,
          },
        },
        fake.dependencies,
      )
      assert.equal(report.outcome, "INFRA_ERROR", which)
      assert.equal(report.error?.code, "INVALID_UTF8", which)
      assert.equal(report.comparison, null, which)
      assert.deepEqual(
        fake.closed,
        which === "export" ? ["context", "browser", "fixture"] : [],
        which,
      )
      if (which !== "export")
        await assert.rejects(readFile(join(directory, "input.csv")), { code: "ENOENT" })
    }
  } finally {
    await removeTestDirectory(root)
  }
})
