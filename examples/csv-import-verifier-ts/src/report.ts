import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Comparison } from "./compare.js"
import type { Outcome } from "./model.js"

export interface CleanupRecord {
  resource: string
  status: "CLOSED" | "FAILED" | "API_ACKNOWLEDGED" | "API_CONFIRMED" | "UNCONFIRMED"
  elapsedMs?: number
  slow?: boolean
  errorCode?: "DEADLINE_EXCEEDED" | "CLOSE_REJECTED"
}
export interface Report {
  schemaVersion: 2
  runId: string
  startedAt: string
  durationMs: number
  outcome: Outcome
  environment: {
    backend: "local" | "solari"
    node: string
    browser: string | null
    playwright: string
  }
  importer?: {
    name: string
    revision: string
    policy: string
    variant?: "upstream" | "patched"
    sourceSha256?: string
  }
  solari?: {
    evidence: "live" | "offline-test"
    browserClient?: string
    sdk: string
    fixtureBundleSha256: string
    workDeadlineMs: number
    totalDeadlineMs: number
    createRequests: { sandbox: number; browser: number }
    cleanupScope: string
  }
  input: { file: string; sha256: string; expectedSha256: string } | null
  comparison: Comparison | null
  beforeReloadComparison?: Comparison
  successMessage: string | null
  steps: string[]
  cleanup: CleanupRecord[]
  error: { stage: string; code: string } | null
  artifacts: string[]
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  )
}

export function differenceCount(report: Report): number | undefined {
  return report.comparison
    ? report.comparison.differences.length +
        (report.beforeReloadComparison?.differences.length ?? 0)
    : undefined
}

export function renderReport(report: Report): string {
  const e = escapeHtml
  const comparison = report.comparison
  const value = (text: string | null) =>
    text === null ? "∅ absent" : e(JSON.stringify(text).replace(/\u00a0/g, "\\u00a0"))
  const rows = [
    { phase: "Before reload", comparison: report.beforeReloadComparison },
    { phase: "After reload", comparison },
  ]
    .flatMap(({ phase, comparison }) =>
      (comparison?.differences ?? []).map((diff) => {
        return `<tr><td>${e(phase)}</td><td><strong>${e(diff.customerId)}</strong><br><small>Source row ${e(diff.sourceRow)}</small></td>
    <td>${e(diff.code)}<br><small>${e(diff.field)}</small></td>
    <td><pre>${value(diff.expected)}</pre></td>
    <td><pre>${value(diff.actual)}</pre></td></tr>`
      }),
    )
    .join("")
  const has = (name: string) => report.artifacts.includes(name)
  const links = [
    "report.json",
    "input.csv",
    "expected.json",
    "before-reload.csv",
    "before-reload.json",
    "observed.json",
    "observed.csv",
    "import-success.png",
    "persisted.png",
    "failure.png",
  ]
    .filter((name) => name === "report.json" || has(name))
    .map((name) => `<a href="${name}">${name}</a>`)
    .join("")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'">
<title>${e(report.outcome)} · CSV import verifier</title>
<style>
 :root{color-scheme:light;font-family:system-ui,sans-serif;color:#18332f;background:#f3f5ef}*{box-sizing:border-box}
 body{margin:0}main{max-width:1160px;margin:auto;padding:40px 32px 64px}.top{display:flex;justify-content:space-between;gap:20px;align-items:center}
 .eyebrow{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.14em;color:#566d62}.badge{padding:8px 13px;border-radius:100px;background:#dceee4;font-size:12px;font-weight:750}
 .FAIL{background:#fae1d8;color:#8a321b}.INFRA_ERROR{background:#fff0bd;color:#715100}h1{white-space:pre-line;line-height:1.1;font-size:clamp(30px,5vw,52px);letter-spacing:-.045em;margin:35px 0 18px}
 .intro{max-width:740px;font-size:16px;line-height:1.65;color:#50665d}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:28px 0}
 .stat,section{background:#fff;border:1px solid #d7e0d7;border-radius:12px;padding:22px}.stat strong{display:block;font-size:28px;margin:8px 0}
 section{margin-top:20px}h2{font-size:19px;margin:0 0 16px}small,.muted{font-size:12px;color:#52665d}table{border-collapse:collapse;width:100%;font-size:13px}
 th{text-align:left;color:#52665d;font-size:11px;text-transform:uppercase;letter-spacing:.05em}th,td{padding:14px 10px;border-bottom:1px solid #e4e9e3;vertical-align:top}
 pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace,monospace;max-width:300px}.scroll{overflow-x:auto}img{width:100%;border:1px solid #d7e0d7;border-radius:8px}
 a{color:#15563f;text-underline-offset:3px}.links{display:flex;gap:16px;flex-wrap:wrap;font-size:13px}.checks{display:flex;gap:12px;flex-wrap:wrap;font-size:13px}
 code{overflow-wrap:anywhere;font-size:12px}details{margin-top:18px}summary{cursor:pointer;color:#15563f;font-size:13px}footer{margin-top:26px;font-size:12px;line-height:1.7;color:#52665d}
 @media(max-width:640px){main{padding:24px 16px}.grid{grid-template-columns:1fr}.top{align-items:start;flex-direction:column}section{padding:16px}}
</style></head><body><main>
<div class="top"><span class="eyebrow">CSV import verifier / evidence report</span><span class="badge ${e(report.outcome)}">${e(report.outcome)} · ${report.environment.backend === "solari" ? (report.solari?.evidence === "offline-test" ? "SIMULATED SOLARI" : "SOLARI") : "LOCAL BROWSER"}</span></div>
<h1>CSV round-trip verification</h1>
<p class="intro">${
    report.outcome === "INFRA_ERROR"
      ? "No import verdict is available. Resolve the execution failure before assessing data integrity."
      : "A real browser uploaded the CSV, reloaded the page, and downloaded persisted records. Each record was checked against an independently authored expectation."
  }</p>
<div class="grid"><div class="stat"><span class="eyebrow">Before reload</span><strong>${report.beforeReloadComparison?.differences.length ?? "Not measured"}</strong><small>Field differences</small></div>
<div class="stat"><span class="eyebrow">After reload</span><strong>${comparison?.differences.length ?? "Not measured"}</strong><small>Field differences</small></div>
<div class="stat"><span class="eyebrow">Records after reload</span><strong>${comparison ? `${comparison.actualAccepted} / ${comparison.expectedAccepted}` : "Unavailable"}</strong><small>Observed / expected</small></div></div>
<section><h2>${report.error ? "Execution failure" : differenceCount(report) ? "What changed" : "Record checks"}</h2>
${report.error ? `<p>Stage: <code>${e(report.error.stage)}</code> · <code>${e(report.error.code)}</code></p>` : ""}
${
  rows
    ? `<p class="muted">Values are quoted. Escapes expose line endings (<code>\\r\\n</code>, <code>\\n</code>), tabs (<code>\\t</code>), and nonbreaking spaces (<code>\\u00a0</code>).</p><div class="scroll"><table><thead><tr><th>Checkpoint</th><th>Record</th><th>Difference</th><th>Expected</th><th>Observed</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : comparison
      ? "<p>All fields and rejection records match the frozen expectation.</p>"
      : "<p>No completed comparison.</p>"
}
</section>
${has("persisted.png") ? `<section><h2>What the browser saw after reload</h2><a href="persisted.png"><img src="persisted.png" alt="Actual browser screenshot of persisted customer records after page reload"></a></section>` : ""}
${!has("persisted.png") && has("failure.png") ? `<section><h2>Browser at failure</h2><img src="failure.png" alt="Actual browser screenshot captured after execution failed"></section>` : ""}
<section><h2>Evidence &amp; cleanup</h2><div class="links">${links}</div>
${report.importer ? `<p>Importer: <strong>${e(report.importer.name)}</strong> · revision <code>${e(report.importer.revision)}</code> · ${e(report.importer.variant ?? "upstream")}</p><p>${e(report.importer.policy)}</p>${report.importer.sourceSha256 ? `<p>Served source SHA-256: <code>${e(report.importer.sourceSha256)}</code></p>` : ""}` : ""}
<p>Importer message: <strong>${e(report.successMessage ?? "Not observed")}</strong></p>
<div class="checks">${report.cleanup.map((item) => `<span>${e(item.resource)}: <strong>${e(item.status)}</strong>${item.elapsedMs !== undefined ? ` (${item.slow ? "slow closure; " : ""}${item.errorCode ? `${e(item.errorCode)}, ` : ""}${e(item.elapsedMs)} ms)` : ""}</span>`).join("") || "No resources acquired."}</div>
<details><summary>Run details</summary><p>Run <code>${e(report.runId)}</code> · ${e(report.startedAt)} · ${e(report.durationMs)} ms</p>
<p>Node ${e(report.environment.node)} · Chromium ${e(report.environment.browser ?? "not launched")} · Playwright ${e(report.environment.playwright)}</p>
${report.solari?.browserClient ? `<p>Remote browser client: ${e(report.solari.browserClient)}</p>` : ""}
<p>Input SHA-256: <code>${e(report.input?.sha256 ?? "unavailable")}</code></p>
<p>Expectation SHA-256: <code>${e(report.input?.expectedSha256 ?? "unavailable")}</code></p>
<p>Steps entered: ${e(report.steps.join(" → "))}</p></details></section>
<footer>${report.importer ? e(report.importer.name) : "Verifier test"} · ${e(report.importer?.variant ?? "test")} case · ${
    report.environment.backend === "solari"
      ? report.solari?.evidence === "offline-test"
        ? "Offline Solari adapter test; no service calls were made."
        : `Solari integration run. ${e(report.solari?.cleanupScope ?? "Cleanup observations unavailable")}.`
      : "Local-only run. No Solari resources were used."
  }<br>
${report.importer ? "Results apply to this input and pinned application version." : "Controlled test; no application compatibility claim."}</footer>
</main></body></html>`
}

export async function writeReport(directory: string, report: Report): Promise<void> {
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  })
  await writeFile(join(directory, "report.html"), renderReport(report), { flag: "wx" })
}
