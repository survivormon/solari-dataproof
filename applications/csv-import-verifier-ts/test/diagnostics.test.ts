import assert from "node:assert/strict"
import test from "node:test"
import { describeError } from "../src/diagnostics.js"

test("missing prerequisites give the supported installation command", () => {
  assert.match(describeError("SPREADSHEET_NOT_INSTALLED"), /npm run spreadsheet:install/)
  assert.match(describeError("BROWSER_NOT_INSTALLED"), /npm run browser:install/)
})

test("source hash failure preserves evidence instead of silently repairing the cache", () => {
  const guidance = describeError("UPSTREAM_HASH_MISMATCH")
  assert.match(guidance, /Preserve the cache/)
  assert.match(guidance, /do not edit the manifest or silently replace/)
})

test("input diagnostics identify CSV and independent expectation roles", () => {
  for (const suffix of ["NOT_FOUND", "UNREADABLE"]) {
    assert.match(describeError(`CSV_FILE_${suffix}`), /--input/)
    assert.match(
      describeError(`EXPECTED_FILE_${suffix}`),
      /independent JSON expectation.*--expected/,
    )
  }
  assert.match(describeError("INVALID_EXPECTED_JSON"), /JSON syntax/)
  assert.match(describeError("INVALID_EXPORT", "preflight"), /expectation.*schemaVersion 1/)
  assert.match(describeError("INVALID_EXPORT", "compare"), /exported records/)
  assert.match(describeError("INVALID_SPREADSHEET_EXPORT"), /source_row, customer_id, name, note/)
})

test("timeouts and cleanup failures explain their limits", () => {
  assert.match(describeError("EXPORT_TIMEOUT"), /export.*time limit/)
  for (const code of ["TIMEOUT", "DEADLINE_EXCEEDED"]) {
    assert.match(describeError(code), /exceeded its time limit/)
  }
  for (const code of ["CLEANUP_FAILED", "CLEANUP_UNCONFIRMED"]) {
    const guidance = describeError(code)
    assert.match(guidance, /Completed comparisons remain evidence/)
    assert.match(guidance, /incomplete and cannot be PASS/)
    assert.match(guidance, /Windows limitation/)
  }
})

test("output failure guidance preserves incomplete evidence", () => {
  for (const code of ["OUTPUT_DIRECTORY_FAILED", "OUTPUT_WRITE_FAILED", "REPORT_WRITE_FAILED"]) {
    assert.match(describeError(code), /free space and output-directory permissions/)
    assert.match(describeError(code), /preserve partial files/)
  }
})

test("unknown errors and stages never enter the returned guidance", () => {
  const unknown = "C:\\private\\customer.csv <script>secret</script>"
  const fallback = describeError(unknown, unknown)
  assert.doesNotMatch(fallback, /private|customer|script|secret/)
  assert.equal(fallback, describeError("constructor"))
  assert.equal(fallback, describeError("__proto__"))
  assert.doesNotMatch(describeError("INVALID_JSON", unknown), /private|customer|script|secret/)
})

test("demo contract failures preserve frozen samples and unexpected evidence", () => {
  assert.match(describeError("DEMO_INPUT_CHANGED"), /Preserve the changed files/)
  assert.match(describeError("DEMO_UNEXPECTED_RESULT"), /do not change the expected result/)
  assert.match(describeError("DEMO_INTERRUPTED"), /interrupted/)
  assert.match(describeError("DEMO_RUN_FAILED"), /available reports/)
})
