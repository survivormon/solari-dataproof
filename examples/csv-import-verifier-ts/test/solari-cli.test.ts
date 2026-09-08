import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { liveMain, liveEnvironment, parseLiveArgs } from "../index.js"
import { browserEnvironment, packageRoot } from "../src/runner.js"

test("plan/help/refusals need no key or live worker; an explicit live command passes a narrow environment", async () => {
  let keyReads = 0,
    executions = 0
  const messages: string[] = []
  const dependencies = {
    key: () => {
      keyReads++
      return undefined as string | undefined
    },
    execute: async () => {
      executions++
      return 0
    },
    output: (text: string) => {
      messages.push(text)
    },
  }
  assert.equal(await liveMain(["--plan"], dependencies), 0)
  assert.equal(await liveMain(["--help"], dependencies), 0)
  assert.equal(await liveMain([], dependencies), 2)
  assert.equal(
    await liveMain(
      ["--variant", "patched", "--input", "input.csv", "--expected", "expected.json"],
      dependencies,
    ),
    2,
  )
  for (const args of [["--case", "fixed"], ["--fault", "drop-row"], ["--spreadsheet"]]) {
    assert.equal(await liveMain([...args, "--live"], dependencies), 2)
  }
  assert.equal(keyReads, 0)
  assert.equal(executions, 0)
  assert.equal(await liveMain(["--live"], dependencies), 2)
  assert.equal(messages.at(-1), "API_KEY_REQUIRED")
  assert.equal(executions, 0)
  assert.equal(await liveMain(["--live"], { ...dependencies, key: () => "short" }), 2)
  const key = "slr_live_synthetic_only_1234"
  assert.equal(
    await liveMain(["--variant", "patched", "--live"], {
      ...dependencies,
      key: () => key,
      execute: async (args, env) => {
        assert.ok(!args.includes(key))
        assert.equal(env.SOLARI_API_KEY, key)
        return 1
      },
    }),
    1,
  )
  assert.deepEqual(
    Object.keys(liveEnvironment(key)).sort(),
    [...Object.keys(browserEnvironment()), "SOLARI_API_KEY"].sort(),
  )
})

test("live arguments select one spreadsheet variant and reject ambiguous flags", () => {
  assert.deepEqual(parseLiveArgs(["--variant", "patched", "--live"]), {
    options: { variant: "patched" },
    live: true,
  })
  for (const args of [
    ["--live", "--live"],
    ["--headed", "--live"],
    ["--timeout-ms", "1000", "--live"],
    ["--variant", "upstream", "--variant", "patched", "--live"],
    ["--plan", "--live"],
    ["--help", "--live"],
  ]) {
    assert.throws(() => parseLiveArgs(args), /INVALID_ARGUMENTS/)
  }
})

test("actual CLI and direct worker refusals cannot read keys or reach the network", () => {
  for (const [entry, args, code, forbidKey] of [
    ["index.ts", ["--plan"], 0, true],
    ["index.ts", ["--help"], 0, true],
    ["index.ts", [], 2, true],
    ["index.ts", ["--live"], 2, false],
    ["src/live-worker.ts", [], 2, true],
    ["index.ts", ["--variant", "patched"], 2, true],
    ["src/live-worker.ts", ["--input", "missing.csv", "--expected", "missing.json"], 2, true],
    ["index.ts", ["--case", "fixed", "--live"], 2, true],
    ["index.ts", ["--fault", "drop-row", "--live"], 2, true],
    ["index.ts", ["--spreadsheet", "--live"], 2, true],
  ] as const) {
    const env = { ...browserEnvironment(), ...(forbidKey ? { CSV_FORBID_KEY_READ: "1" } : {}) }
    const result = spawnSync(
      process.execPath,
      ["--import", "./test/no-network.mjs", "--import", "tsx", entry, ...args],
      {
        cwd: packageRoot,
        env,
        encoding: "utf8",
        timeout: 20_000,
      },
    )
    assert.equal(result.status, code, result.stderr + result.stdout)
    assert.ok(!result.stderr.includes("TRIPWIRE"))
  }
})
