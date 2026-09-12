import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"
import { packageRoot } from "../src/runner.js"
import { runBenchmark } from "./support/benchmark.js"

test("an already-cancelled benchmark stops before output setup or browser acquisition", async () => {
  // An existing file makes setup fail fast if cancellation regresses, without launching the matrix.
  const outputRoot = join(packageRoot, "package.json")
  const reason = new Error("test deadline expired")
  await assert.rejects(
    runBenchmark(outputRoot, AbortSignal.abort(reason)),
    (error) => error === reason,
  )
})
