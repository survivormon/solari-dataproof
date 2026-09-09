import { HttpTransport, Sandbox, type CreateSandboxResponse } from "@solarisdk/core"
import { chromium } from "patchright-core"
import type { Budget } from "./budget.js"
import type { SolariDriver } from "./solari.js"
import { RunError } from "./model.js"

export function observeFixtureCommand(command: { wait(): Promise<number> }, budget: Budget): void {
  // The SDK owns a rejecting exit promise even when a command is left running.
  // Observe it immediately so channel closure cannot crash independent REST cleanup.
  void command.wait().then(
    () => {
      if (!budget.cleaning) budget.work.abort(new RunError("FIXTURE_EXITED"))
    },
    () => {
      if (!budget.cleaning) budget.work.abort(new RunError("FIXTURE_COMMAND_DISCONNECTED"))
    },
  )
}

// The product-specific client does not expose maxRetries; the same exported core transport does.
// No global fetch replacement, SDK monkeypatch, or implicit create retry is needed.
export function createLiveDriver(
  apiKey: string,
  budget: Budget,
  fetchImpl: typeof fetch = fetch,
): SolariDriver {
  const boundedFetch: typeof fetch = (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        ...(init.signal ? [init.signal] : []),
        budget.cleaning ? budget.total.signal : budget.work.signal,
        AbortSignal.timeout(
          budget.cleaning ? budget.limits.cleanupCallMs : budget.limits.operationMs,
        ),
      ]),
    })
  const http = new HttpTransport({
    apiKey,
    baseUrl: "https://api.getsolari.com",
    maxRetries: 0,
    requestTimeoutMs: budget.limits.operationMs,
    fetch: boundedFetch,
  })
  return {
    evidence: "live",
    request: (method, path, body, idempotencyKey) =>
      http.request(method, path, body, idempotencyKey ? { idempotencyKey } : undefined),
    sandbox: (raw) => {
      const handle = new Sandbox(raw as CreateSandboxResponse, {
        callTimeoutMs: budget.limits.operationMs,
        headers: http.authHeaders(),
      })
      return {
        connect: () => handle.connect(),
        close: () => handle.close(),
        write: (path, bytes) => handle.files.write(path, bytes),
        run: (command, args) =>
          handle.commands.run(command, { args, timeoutMs: budget.limits.operationMs }),
        start: async (command, args) => {
          observeFixtureCommand(await handle.commands.start(command, { args }), budget)
        },
      }
    },
    browser: (endpoint, timeout) => chromium.connect(endpoint, { timeout }),
    preview: async (url, token) => {
      const response = await boundedFetch(url, { headers: { "x-pinetree-preview-token": token } })
      const value: unknown = response.ok ? await response.json() : null
      if (!response.ok) await response.body?.cancel()
      return { status: response.status, value }
    },
  }
}
