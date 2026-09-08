import assert from "node:assert/strict"
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { recoveryLockFailure } from "../src/recovery-cli.js"
import { removeTestDirectory } from "./temp.js"

test("an existing recovery lock reports bounded manual recovery and remains untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-recovery-lock-"))
  const lockPath = join(root, "synthetic-run.lock")
  try {
    writeFileSync(lockPath, "synthetic active or stale lock")
    let failure: unknown
    try {
      closeSync(openSync(lockPath, "wx", 0o600))
    } catch (error) {
      failure = error
    }
    const diagnostic = recoveryLockFailure(failure, lockPath)
    assert.ok(diagnostic.startsWith(`RECOVERY_LOCKED: ${lockPath}\n`))
    assert.match(diagnostic, /active recovery process or remain after a crash/)
    assert.match(
      diagnostic,
      /Verify no recovery process is using this journal before manually removing only this exact lock file/,
    )
    assert.match(diagnostic, /rerun the same recovery command/)
    assert.equal(readFileSync(lockPath, "utf8"), "synthetic active or stale lock")
  } finally {
    await removeTestDirectory(root)
  }
})

test("other lock failures remain unconfirmed without exposing raw error details", () => {
  for (const error of [
    Object.assign(new Error("private detail"), { code: "EACCES" }),
    null,
    undefined,
  ]) {
    assert.equal(recoveryLockFailure(error, "synthetic-run.lock"), "RECOVERY_UNCONFIRMED")
  }
})
