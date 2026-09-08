import test from "node:test"
import assert from "node:assert/strict"
import { Budget } from "../src/budget.js"
import { observeFixtureCommand } from "../src/solari-driver.js"

test("background command rejection during cleanup is observed without aborting REST cleanup", async () => {
  const budget = new Budget()
  try {
    let reject!: (reason: Error) => void
    const pending = new Promise<number>((_, failure) => {
      reject = failure
    })
    observeFixtureCommand({ wait: () => pending }, budget)
    budget.beginCleanup()
    reject(new Error("Control channel closed"))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await budget.run(async () => "cleanup available"), "cleanup available")
  } finally {
    budget.dispose()
  }
})

test("unexpected fixture command loss aborts work with a structural error", async () => {
  const budget = new Budget()
  try {
    observeFixtureCommand({ wait: () => Promise.reject(new Error("private SDK detail")) }, budget)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(budget.work.signal.aborted, true)
    assert.equal(budget.work.signal.reason.code, "FIXTURE_COMMAND_DISCONNECTED")
  } finally {
    budget.dispose()
  }
})
