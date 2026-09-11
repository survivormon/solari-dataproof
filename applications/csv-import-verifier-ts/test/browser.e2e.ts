import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { localBrowser, packageRoot, runVerification } from "../src/runner.js"
import { spreadsheetAdapter } from "../src/spreadsheet-adapter.js"
import { serveSpreadsheet, spreadsheetFiles } from "../src/spreadsheet-source.js"

for (const failure of ["export", "disconnect", "upload"] as const) {
  test(
    `real spreadsheet: ${failure} failure prevents a verdict and closes resources`,
    {
      timeout: 60_000,
    },
    async () => {
      let origin = ""
      const { report } = await runVerification(
        {
          input: {
            csv: await readFile(join(packageRoot, "demo", "customers.csv")),
            expected: await readFile(join(packageRoot, "demo", "expected.json")),
          },
          timeoutMs: 2_000,
          outputRoot: join(packageRoot, "output", "failure-tests"),
        },
        {
          fixture: async () => {
            const server = await serveSpreadsheet((await spreadsheetFiles()).files)
            origin = server.url
            return server
          },
          browser: localBrowser,
          adapter: async (page, input) => {
            if (failure === "disconnect") await page.context().browser()!.close()
            else
              await page.addInitScript((failure: "upload" | "export") => {
                if (failure === "upload") {
                  // Leave the app's actual FileReader pending until context cleanup.
                  FileReader.prototype.readAsText = () => {}
                } else {
                  // Suppress the actual export anchor click; no download can complete.
                  document.addEventListener(
                    "click",
                    (event) => {
                      if (event.target instanceof HTMLAnchorElement && event.target.download)
                        event.preventDefault()
                    },
                    true,
                  )
                }
              }, failure)
            return spreadsheetAdapter(page, input)
          },
        },
      )
      assert.equal(report.outcome, "INFRA_ERROR", JSON.stringify(report))
      assert.equal(
        report.error?.code,
        failure === "disconnect" ? "BROWSER_DISCONNECTED" : "TIMEOUT",
      )
      if (failure !== "disconnect")
        assert.equal(report.error?.stage, failure === "upload" ? "upload" : "export before reload")
      assert.equal(report.comparison, null)
      assert.equal(report.beforeReloadComparison, undefined)
      assert.equal(report.cleanup.length, 3)
      assert.ok(report.cleanup.every((item) => item.status === "CLOSED"))
      await assert.rejects(fetch(origin))
    },
  )
}
