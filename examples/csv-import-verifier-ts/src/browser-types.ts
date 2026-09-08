import type * as Playwright from "playwright"
import type * as Patchright from "patchright-core"

// Both documented clients implement the browser methods used by the verifier.
// Keep their actual types: Patchright adds methods that prevent full assignability.
export type Browser = Playwright.Browser | Patchright.Browser
export type BrowserContext = Playwright.BrowserContext | Patchright.BrowserContext
export type Download = Playwright.Download | Patchright.Download
export type Page = (Playwright.Page | Patchright.Page) & {
  // Explicit common overloads let TypeScript call these methods on either client.
  waitForEvent(event: "download"): Promise<Download>
}
