import { RunError } from "./model.js"

// Exact known capabilities are kept in memory only. Error prose is never exported.
export class Secrets {
  private values = new Set<string>()
  add(value: string | undefined): void {
    if (!value) return
    this.values.add(value)
    this.values.add(encodeURIComponent(value))
    this.values.add(JSON.stringify(value).slice(1, -1))
  }
  check(bytes: Buffer | string): void {
    const text = typeof bytes === "string" ? bytes : bytes.toString("utf8")
    for (const value of this.values)
      if (text.includes(value)) throw new RunError("SENSITIVE_ARTIFACT_BLOCKED")
    if (/slr_live_[A-Za-z0-9_-]+|pt_token=|x-pinetree-preview-token|wss:\/\//i.test(text))
      throw new RunError("SENSITIVE_ARTIFACT_BLOCKED")
  }
}
