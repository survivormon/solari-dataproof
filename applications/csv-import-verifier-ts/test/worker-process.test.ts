import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { browserEnvironment, packageRoot } from "../src/runner.js"
import { parseJournal } from "../src/recovery.js"
import { runNodeWorker } from "../src/worker-process.js"
import { removeTestDirectory } from "./temp.js"

const workerModule = pathToFileURL(join(packageRoot, "src", "worker-process.ts")).href
const budgetModule = pathToFileURL(join(packageRoot, "src", "budget.ts")).href
const recoveryModule = pathToFileURL(join(packageRoot, "src", "recovery.ts")).href
const imports = `
  import { workerCancellation } from ${JSON.stringify(workerModule)};
  import { Budget } from ${JSON.stringify(budgetModule)};
  import { writeFileSync } from "node:fs";
  const budget = new Budget({ workMs: 10000, totalMs: 15000, operationMs: 1000, cleanupCallMs: 500 });
`
const args = (source: string) => ["--import", "tsx", "--input-type=module", "--eval", source]

test("the worker handshake and IPC do not keep a completed child alive", { timeout: 10_000 }, async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
  const started = performance.now()
  const code = await runNodeWorker(args(`${imports}
    const cancellation = await workerCancellation(budget);
    if (cancellation.signal.aborted) throw new Error("Unexpected interruption");
    cancellation.dispose();
    budget.dispose();
  `), browserEnvironment(), 5_000)
  assert.equal(code, 0)
  assert.ok(performance.now() - started < 5_000)
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before)
})

test("early and repeated parent interruptions reach the worker before admission", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-worker-interrupt-"))
  try {
    const resultPath = join(root, "result.json")
    const running = runNodeWorker(args(`${imports}
      await new Promise(resolve => setTimeout(resolve, 200));
      const cancellation = await workerCancellation(budget);
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
        admitted: !cancellation.signal.aborted,
        code: cancellation.signal.reason?.code,
        workAborted: budget.work.signal.aborted,
      }));
      cancellation.dispose();
      budget.dispose();
    `), browserEnvironment(), 5_000)
    process.emit("SIGINT")
    process.emit("SIGINT")
    process.emit("SIGTERM")
    assert.equal(await running, 3)
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
      admitted: false, code: "INTERRUPTED", workAborted: true,
    })
  } finally {
    await removeTestDirectory(root)
  }
})

test("Linux hard deadline terminates a SIGTERM-handling worker and preserves recovery evidence", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "csv-worker-watchdog-"))
  const statePath = join(root, "state.json"), alivePath = join(root, "alive.json")
  let settled = false, fallbackUsed = false
  // A regression must not leave the deliberately persistent, exactly owned test child alive.
  const fallback = setTimeout(() => {
    if (settled) return
    fallbackUsed = true
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    process.kill(state.pid, "SIGKILL")
  }, 6_000)
  try {
    const started = performance.now()
    const code = await runNodeWorker(args(`${imports}
      import { createJournal } from ${JSON.stringify(recoveryModule)};
      const journal = createJournal(${JSON.stringify(root)});
      journal.record({ type: "acquired", resource: "sandbox", id: "synthetic-owned-resource" });
      const cancellation = await workerCancellation(budget);
      writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ pid: process.pid, journal: journal.path }));
      let terms = 0, ticks = 0;
      process.on("SIGTERM", () => { terms++; });
      process.kill(process.pid, "SIGTERM");
      setInterval(() => {
        ticks++;
        writeFileSync(${JSON.stringify(alivePath)}, JSON.stringify({ terms, ticks }));
      }, 25);
    `), browserEnvironment(), 2_000)
    settled = true
    assert.equal(fallbackUsed, false, "the production watchdog must terminate the child")
    assert.equal(code, 3)
    assert.ok(performance.now() - started < 5_000, "parent must return after its hard deadline")
    const alive = JSON.parse(await readFile(alivePath, "utf8"))
    assert.equal(alive.terms, 1, "the child demonstrably handled SIGTERM")
    assert.ok(alive.ticks >= 2, "the child continued running after handling SIGTERM")
    const state = JSON.parse(await readFile(statePath, "utf8"))
    assert.throws(() => process.kill(state.pid, 0), { code: "ESRCH" }, "child must be gone")
    assert.deepEqual(parseJournal(await readFile(state.journal, "utf8")).events, [
      { type: "acquired", resource: "sandbox", id: "synthetic-owned-resource", phase: "run" },
    ])
  } finally {
    clearTimeout(fallback)
    await removeTestDirectory(root)
  }
})
