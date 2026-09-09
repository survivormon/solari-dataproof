import { RunError } from "./model.js"

export interface Limits {
  workMs: number
  totalMs: number
  operationMs: number
  cleanupCallMs: number
}
export const LIVE_LIMITS: Readonly<Limits> = Object.freeze({
  workMs: 120_000,
  totalMs: 180_000,
  operationMs: 15_000,
  cleanupCallMs: 6_000,
})

export class Budget {
  readonly started = Date.now()
  readonly work = new AbortController()
  readonly total = new AbortController()
  cleaning = false
  private workTimer: NodeJS.Timeout
  private totalTimer: NodeJS.Timeout
  constructor(readonly limits: Limits = LIVE_LIMITS) {
    this.workTimer = setTimeout(() => this.work.abort(), limits.workMs)
    this.totalTimer = setTimeout(() => {
      this.work.abort()
      this.total.abort()
    }, limits.totalMs)
  }
  remaining(): number {
    return Math.max(
      0,
      this.started + (this.cleaning ? this.limits.totalMs : this.limits.workMs) - Date.now(),
    )
  }
  async run<T>(operation: () => Promise<T>, maximumMs = this.limits.operationMs): Promise<T> {
    if (
      this.remaining() <= 0 ||
      (!this.cleaning && this.work.signal.aborted) ||
      this.total.signal.aborted
    )
      throw new RunError("DEADLINE_EXCEEDED")
    let timer: NodeJS.Timeout | undefined
    const signal = this.cleaning ? this.total.signal : this.work.signal
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          onAbort = () =>
            reject(
              signal.reason instanceof RunError ? signal.reason : new RunError("DEADLINE_EXCEEDED"),
            )
          signal.addEventListener("abort", onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              if (!this.cleaning) this.work.abort()
              reject(new RunError("DEADLINE_EXCEEDED"))
            },
            Math.min(maximumMs, this.remaining()),
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }
  beginCleanup(): void {
    this.cleaning = true
    this.work.abort()
    clearTimeout(this.workTimer)
  }
  dispose(): void {
    clearTimeout(this.workTimer)
    clearTimeout(this.totalTimer)
    this.work.abort()
    this.total.abort()
  }
}
