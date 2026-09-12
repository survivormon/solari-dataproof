import type { DemoSummary } from "./demo.js"
import { describeError } from "./diagnostics.js"
import { escapeHtml } from "./report.js"

export function renderDemo(summary: DemoSummary): string {
  const e = escapeHtml
  const verified = summary.outcome === "VERIFIED"
  const heading = verified
    ? "See what survived the import."
    : summary.outcome === "INCOMPLETE"
      ? "The demonstration is incomplete."
      : "The result needs investigation."
  const cases = (["upstream", "patched"] as const)
    .map((variant, index) => {
      const item = summary.cases.find((item) => item.variant === variant)
      const report = item?.report
      const complete = item?.issues.length === 0
      const link =
        item && new RegExp(`^${variant}/[a-f0-9-]{36}/report\\.html$`).test(item.reportPath)
          ? `<a class="button" href="${e(item.reportPath)}">Inspect ${variant === "upstream" ? "original" : "patched"} evidence <span aria-hidden="true">↗</span></a>`
          : ""
      return `<article><div class="case-top"><span class="eyebrow">0${index + 1} / ${variant === "upstream" ? "The original" : "The repair"}</span><span class="status ${e(report?.outcome ?? "pending")}">${e(report?.outcome ?? "NOT RUN")}</span></div>
<h2>${variant === "upstream" ? (complete ? "The app said it worked." : "Original spreadsheet") : "The same data. Two small fixes."}</h2>
<p>${variant === "upstream" ? (complete ? "Its export replaced nonbreaking spaces. Reloading also changed an ampersand into literal HTML text." : "This case checks whether the original app changes nonbreaking spaces and ampersands during export and reload.") : "The patches preserve nonbreaking spaces and prevent repeated HTML encoding during reload."}</p>
<dl><div><dt>Before reload</dt><dd>${report?.beforeReloadComparison?.differences.length ?? "—"}<small> differences</small></dd></div><div><dt>After reload</dt><dd>${report?.comparison?.differences.length ?? "—"}<small> differences</small></dd></div></dl>
<p class="note">${!item ? (variant === "upstream" ? "The original case has not run." : "The original case must complete before this case can run.") : item.issues.length ? "This case did not satisfy the full demonstration contract." : variant === "upstream" ? "Expected FAIL: the exact original defects were reproduced." : "PASS: both exports match the independent expectation."}</p>${link}</article>`
    })
    .join("")
  const differences =
    summary.cases.find((item) => item.variant === "upstream")?.report.comparison?.differences ?? []
  const value = (text: string | null) =>
    e(text === null ? "absent" : JSON.stringify(text).replaceAll("\u00a0", "\\u00a0"))
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>DataProof · ${verified ? "Demo verified" : e(summary.outcome)}</title><style>
:root{font-family:system-ui,sans-serif;color:#17372e;background:#f5f6f1;color-scheme:light}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:42px 28px 56px}.masthead,.case-top{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-size:23px;font-weight:760;letter-spacing:-.06em}.brand span{color:#598267}.eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;font-weight:750;color:#546c61}.status{font-size:11px;font-weight:750;letter-spacing:.04em;border-radius:99px;background:#e7ece5;padding:7px 11px}.VERIFIED,.PASS{background:#daecde;color:#20583b}.FAIL{background:#f8e3d9;color:#893d23}.INCOMPLETE,.INFRA_ERROR,.UNEXPECTED_RESULT{background:#fff0c7;color:#765910}h1{font-size:clamp(36px,6vw,64px);max-width:770px;letter-spacing:-.055em;line-height:1.06;margin:46px 0 20px}.intro{font-size:18px;line-height:1.65;max-width:790px;color:#4f675b}.cases{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:34px 0 24px}article,section{padding:26px;background:#fff;border:1px solid #d7e1d7;border-radius:12px}article h2{font-size:24px;line-height:1.2;letter-spacing:-.025em;margin-top:26px}p{line-height:1.65;color:#4f675b}dl{display:flex;gap:40px;border-top:1px solid #e3e9e1;padding-top:18px}dt{font-size:12px;color:#536c5d}dd{margin:5px 0;font-size:30px;font-weight:700}dd small{font-size:12px;font-weight:400}.note{font-size:13px;min-height:43px}.button{display:inline-block;border:1px solid #b3c8b6;padding:11px 14px;border-radius:6px;font-size:13px;text-decoration:none;color:#1c5238}.button:hover{background:#edf3ec}a:focus-visible{outline:3px solid #9b6500;outline-offset:4px}section{margin-top:20px}section h2{font-size:20px;margin-top:0}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:14px 10px;text-align:left;vertical-align:top;border-bottom:1px solid #e4e9e1}th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#536c5d}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;max-width:290px}code{overflow-wrap:anywhere}a{color:#1c5238;text-underline-offset:3px}footer{font-size:12px;color:#546c61;line-height:1.8;margin-top:26px}.links{display:flex;flex-wrap:wrap;gap:18px;font-size:13px}.error{border-left:4px solid #b98423}.muted{font-size:12px}li{line-height:1.7}@media(max-width:720px){main{padding:24px 16px}.cases{grid-template-columns:1fr}article,section{padding:20px}.masthead{align-items:flex-start}h1{margin-top:36px}.note{min-height:0}dl{gap:28px}}
</style></head><body><main><div class="masthead"><div class="brand">Data<span>Proof</span></div><span class="status ${e(summary.outcome)}">${verified ? "DEMO VERIFIED" : e(summary.outcome.replaceAll("_", " "))}</span></div>
<h1>${heading}</h1><p class="intro">A browser imports the same two customer records into the original spreadsheet and a patched copy. DataProof checks their exports against an independent expectation, before and after reload.</p>
${summary.error ? `<section class="error"><h2>${e(summary.error.code)}</h2><p>${e(describeError(summary.error.code, summary.error.stage))}</p><p class="muted">Completed evidence is retained below. A partial run cannot verify the demonstration.</p>${summary.cases.some((item) => item.issues.length) ? `<ul>${summary.cases.flatMap((item) => item.issues.map((issue) => `<li>${e(issue)}</li>`)).join("")}</ul>` : ""}</section>` : ""}
<div class="cases">${cases}</div>
${differences.length ? `<section><h2>What changed in the original app</h2><p class="muted">Actual values exported after reload. <code>\\u00a0</code> makes nonbreaking spaces visible.</p><div class="scroll"><table><thead><tr><th>Customer / field</th><th>Expected</th><th>Original export</th></tr></thead><tbody>${differences.map((diff) => `<tr><td>${e(diff.customerId)} / ${e(diff.field)}</td><td><pre>${value(diff.expected)}</pre></td><td><pre>${value(diff.actual)}</pre></td></tr>`).join("")}</tbody></table></div></section>` : ""}
<section><h2>${verified ? "What this demonstration establishes" : "What a complete demonstration checks"}</h2><p>The original must reproduce the exact known changes. The patched version must preserve every expected field at both checkpoints. Both runs must use the frozen input and application source, and close all acquired resources.</p><p>These results cover the bundled input and pinned Spreadsheet Live version. Reload checks its URL fragment persistence. Embedded CRLF normalization remains a known failing case outside this sample.</p><div class="links">${summary.inputsCaptured ? '<a href="input.csv">Demo CSV</a><a href="expected.json">Independent expectation</a>' : ""}<a href="summary.json">Full comparison record</a></div></section>
<footer>Local browser demonstration · ${e(summary.startedAt)} · ${(summary.durationMs / 1000).toFixed(1)} seconds<br>Run ${e(summary.runId)} · No Solari resources used.</footer></main></body></html>`
}
