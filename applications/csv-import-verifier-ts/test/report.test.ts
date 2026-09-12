import assert from "node:assert/strict"
import test from "node:test"
import { renderReport, type Report } from "../src/report.js"

function completedReport(): Report {
  const comparison = {
    expectedAccepted: 1,
    actualAccepted: 1,
    expectedRejected: 0,
    actualRejected: 0,
    differences: [],
  }
  return {
    schemaVersion: 2,
    runId: "report-test",
    startedAt: "2026-09-12T04:00:00.000Z",
    durationMs: 900,
    outcome: "PASS",
    environment: { backend: "local", node: "v22", browser: "test-browser", playwright: "test" },
    importer: {
      name: "Spreadsheet Live",
      revision: "pinned-revision",
      variant: "patched",
      sourceSha256: "source-hash",
      policy: "Exact customer text",
    },
    input: { file: "input.csv", sha256: "input-hash", expectedSha256: "expected-hash" },
    comparison,
    beforeReloadComparison: { ...comparison, differences: [] },
    successMessage: "CSV imported successfully",
    steps: ["preflight", "compare"],
    cleanup: [{ resource: "browser", status: "CLOSED" }],
    error: null,
    artifacts: ["input.csv", "expected.json", "before-reload.csv", "observed.csv", "persisted.png"],
  }
}

test("report identifies DataProof, the case, and run time without opening details", () => {
  for (const variant of ["upstream", "patched"] as const) {
    const report = completedReport()
    report.importer!.variant = variant
    const html = renderReport(report)
    const label = variant === "upstream" ? "Upstream case" : "Patched case"
    assert.ok(html.includes(`<title>DataProof · ${label} · PASS</title>`))
    assert.ok(html.includes(`<h1>DataProof<br>${label}</h1>`))
    assert.ok(
      html.indexOf('<time datetime="2026-09-12T04:00:00.000Z">') < html.indexOf("<details>"),
    )
    assert.match(html, /2026-09-12 04:00:00 UTC/)
  }
})

test("matching exports followed by failed cleanup retain evidence without claiming PASS", () => {
  for (const code of ["CLEANUP_FAILED", "CLEANUP_UNCONFIRMED"]) {
    const report = completedReport()
    report.outcome = "INFRA_ERROR"
    report.error = { stage: "cleanup", code }
    report.cleanup = [{ resource: "browser", status: "FAILED", errorCode: "CLOSE_REJECTED" }]
    const html = renderReport(report)
    assert.match(html, /Completed comparisons remain evidence/)
    assert.match(html, /run is incomplete and cannot be PASS/)
    assert.match(html, /Completed comparisons found no differences/)
    assert.doesNotMatch(html, /No import verdict is available/)
    assert.doesNotMatch(html, /All fields and rejection records match/)
    assert.match(html, /CLOSE_REJECTED/)
    assert.match(html, /href="observed.csv"/)
  }
})

test("an execution failure before comparisons explains that no verdict is available", () => {
  const report = completedReport()
  report.outcome = "INFRA_ERROR"
  report.error = { stage: "browser", code: "BROWSER_NOT_INSTALLED" }
  report.comparison = null
  delete report.beforeReloadComparison
  const html = renderReport(report)
  assert.match(html, /No import verdict is available/)
  assert.match(html, /No completed comparison/)
  assert.match(html, /npm run browser:install/)
  assert.doesNotMatch(html, /Completed comparisons found no differences/)
})

test("a partial comparison remains visible when the second checkpoint fails", () => {
  const report = completedReport()
  report.outcome = "INFRA_ERROR"
  report.error = { stage: "compare", code: "INVALID_EXPORT" }
  report.comparison = null
  const html = renderReport(report)
  assert.match(html, /Completed comparisons remain evidence/)
  assert.match(html, /Completed comparisons found no differences/)
  assert.match(html, /Not measured/)
  assert.doesNotMatch(html, /No completed comparison|No import verdict is available/)
})

test("difference counts cover missing records and changes at both checkpoints", () => {
  const report = completedReport()
  report.outcome = "FAIL"
  report.beforeReloadComparison!.differences.push({
    code: "MISSING_RECORD",
    customerId: "0017",
    sourceRow: 2,
    field: "record",
    expected: "present",
    actual: null,
  })
  report.comparison!.differences.push({
    code: "UNEXPECTED_RECORD",
    customerId: "0042",
    sourceRow: 3,
    field: "record",
    expected: null,
    actual: "present",
  })
  const html = renderReport(report)
  assert.doesNotMatch(html, /Field differences/)
  assert.match(html, /MISSING_RECORD/)
  assert.match(html, /UNEXPECTED_RECORD/)
  assert.match(html, /Before reload/)
  assert.match(html, /After reload/)
  assert.doesNotMatch(html, /Completed comparisons found no differences/)
})

test("report escapes evidence and only links allowlisted artifacts without scripts", () => {
  const report = completedReport()
  const injection = '<script>alert("unsafe")</script>'
  report.runId = injection
  report.startedAt = injection
  report.successMessage = injection
  report.importer!.name = injection
  report.importer!.policy = injection
  report.error = { stage: injection, code: injection }
  report.cleanup = [{ resource: injection, status: "UNCONFIRMED" }]
  report.comparison!.differences.push({
    code: "FIELD_CHANGED",
    customerId: injection,
    sourceRow: 2,
    field: injection,
    expected: injection,
    actual: "'&\u00a0\r\n",
  })
  report.artifacts.push("javascript:alert(1)", "../../private.txt")
  const html = renderReport(report)
  assert.doesNotMatch(html, /<script|javascript:|\.\.\/\.\.\/private/)
  assert.match(html, /&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt;/)
  assert.ok(html.includes("\\u00a0\\r\\n"))
  assert.match(html, /default-src 'none'/)
  assert.match(html, /href="report.json"/)
  assert.match(html, /href="persisted.png"/)
  assert.match(html, /href="expected.json"/)
  assert.doesNotMatch(html, /href="failure.png"/)
})
