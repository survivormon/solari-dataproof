import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { createServer, request, type Server } from "node:http"
import test from "node:test"
import { chromium } from "playwright"
import type { BrowserContext } from "patchright-core"
import { bundleSpreadsheet } from "../src/bundle.js"
import { runSpreadsheet } from "../src/spreadsheet.js"
import { Secrets } from "../src/secrets.js"
import { browserEnvironment, packageRoot } from "../src/runner.js"
import { removeTestDirectory } from "./temp.js"

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return address.port
}
const close = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })

// Model the gateway forwarding to a different Host than the browser's public origin.
async function previewFixture(
  start: (options: {
    publicOrigin: string
    port: number
  }) => Promise<{ url: string; close(): Promise<void> }>,
  token: string,
) {
  const probe = createServer(),
    backendPort = await listen(probe)
  await close(probe)
  const proxy = createServer((incoming, outgoing) => {
    if (incoming.headers["x-pinetree-preview-token"] !== token) {
      outgoing.writeHead(401).end()
      return
    }
    const forwarded = request(
      {
        host: "127.0.0.1",
        port: backendPort,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, host: "rewritten.guest:3000" },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      },
    )
    forwarded.on("error", () => outgoing.writeHead(502).end())
    incoming.pipe(forwarded)
  })
  const publicOrigin = `http://127.0.0.1:${await listen(proxy)}`
  try {
    const fixture = await start({ publicOrigin, port: backendPort })
    return {
      url: publicOrigin,
      close: async () => {
        try {
          await close(proxy)
        } finally {
          await fixture.close()
        }
      },
    }
  } catch (error) {
    await close(proxy)
    throw error
  }
}

test(
  "independent app upload bundle reproduces the real persistence defect and fix over the browser wire protocol",
  { timeout: 90_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "csv-spreadsheet-bundle-"))
    const { chromium: remoteChromium } = await import("patchright-core")
    const browserServer = await remoteChromium.launchServer({
      executablePath: chromium.executablePath(),
      env: browserEnvironment(),
    })
    try {
      const cases = JSON.parse(
        await readFile(join(packageRoot, "test", "support", "cases.json"), "utf8"),
      )
      const item = cases.cases.find((value: { id: string }) => value.id === "condition-note")
      const input = { csv: join(root, "customers.csv"), expected: join(root, "expected.json") }
      await writeFile(input.csv, item.csv)
      await writeFile(input.expected, JSON.stringify(item.expected))
      const markup = [
        "<img src=x onerror=alert(1)>",
        "<script>1</script>",
        "<b onclick=alert(1)>safe</b>",
        "<a href=javascript:alert(1)>link</a>",
        '<span style="color:red" onload=x>safe</span>',
        '<span style="color:red">allowed</span>',
        "<b>Condition=New &amp; boxed</b>",
      ]
      let originalMarkup: string[] | undefined
      for (const variant of ["upstream", "patched"] as const) {
        const bundle = await bundleSpreadsheet(variant)
        assert.equal(bundle.files.length, 1)
        assert.ok(bundle.files[0]!.bytes.length < 2_000_000)
        const filename = join(root, `${variant}.mjs`)
        await writeFile(filename, bundle.files[0]!.bytes)
        const built = await import(pathToFileURL(filename).href)
        const fixture = await built.startSpreadsheet()
        try {
          const browser = await remoteChromium.connect(browserServer.wsEndpoint())
          try {
            const page = await browser.newPage()
            await page.route("**/*", (route) =>
              new URL(route.request().url()).origin === fixture.url
                ? route.continue()
                : route.abort(),
            )
            await page.goto(fixture.url)
            const observed = await page.evaluate(
              async ({ origin, markup }) => {
                const { sanitizeHTML } = await import(origin + "/modules/security.js")
                const text = [
                  "Condition=New &amp; boxed",
                  "Connection=mobile &amp; retry",
                  "&lt;img src=x onerror=alert(1)&gt;",
                  "&#60;img src=x onerror=alert(1)&#62;",
                ]
                return {
                  markup: markup.map((value) => sanitizeHTML(value)),
                  textElements: text.map((value) => {
                    const node = document.createElement("div")
                    node.innerHTML = sanitizeHTML(value)
                    return node.querySelectorAll("*").length
                  }),
                }
              },
              { origin: fixture.url, markup },
            )
            if (variant === "upstream") originalMarkup = observed.markup
            else
              assert.deepEqual(
                observed.markup,
                originalMarkup,
                "actual-markup sanitizer behavior stays unchanged",
              )
            assert.deepEqual(observed.textElements, [0, 0, 0, 0])
          } finally {
            await browser.close()
          }
        } finally {
          await fixture.close()
        }
        const secrets = new Secrets()
        const previewToken = "synthetic-preview-token-for-local-test"
        secrets.add(previewToken)
        const remotePaths: Promise<void>[] = []
        const { report, directory } = await runSpreadsheet(
          { input, variant, outputRoot: join(packageRoot, "output", "external", "bundle-tests") },
          {
            fixture: async () => {
              const fixture = await previewFixture(built.startSpreadsheet, previewToken)
              assert.equal((await fetch(fixture.url)).status, 401)
              secrets.add(fixture.url)
              return fixture
            },
            browser: ({ timeoutMs }) =>
              remoteChromium.connect(browserServer.wsEndpoint(), { timeout: timeoutMs }),
            configureContext: async (context) => {
              await context.setExtraHTTPHeaders({ "x-pinetree-preview-token": previewToken })
              const remoteContext = context as BrowserContext
              remoteContext.on("page", (page) => {
                page.on("download", (download) => {
                  remotePaths.push(assert.rejects(download.path(), /not available|remote browser/i))
                })
              })
            },
            validateArtifact: (bytes) => secrets.check(bytes),
          },
        )
        await Promise.all(remotePaths)
        assert.equal(remotePaths.length, 2, "both CSV exports cross the browser wire protocol")
        assert.equal(
          report.outcome,
          variant === "upstream" ? "FAIL" : "PASS",
          JSON.stringify(report),
        )
        assert.equal(report.comparison!.differences.length, variant === "upstream" ? 2 : 0)
        assert.equal(report.importer!.sourceSha256, built.sourceSha256)
        for (const file of ["before-reload.csv", "observed.csv"])
          assert.ok((await readFile(join(directory, file))).length > 0)
        assert.ok(report.cleanup.every((item) => item.status === "CLOSED"))
      }
    } finally {
      await browserServer.close()
      await removeTestDirectory(root)
    }
  },
)
