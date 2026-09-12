import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { link, mkdir, open, readFile, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { RunError } from "./model.js"
import type { FixtureHandle } from "./runner.js"

export const spreadsheetCommit = "fdad288df3de36fc6c235c6bc24d94fa8a30bf5d"
const root = fileURLToPath(new URL("../", import.meta.url))
export const spreadsheetCache = join(root, "output", "external", "upstream", spreadsheetCommit)
interface SourceFile {
  path: string
  bytes: number
  sha256: string
}
interface SourceManifest {
  commit: string
  files: SourceFile[]
}
export const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")
export type SpreadsheetVariant = "upstream" | "patched"

// Two explicit, reviewable changes to the pinned app. The verified cache stays untouched.
export const spreadsheetPatches = [
  {
    path: "modules/selectionStatusManager.js",
    before: 'return text.replace(/\\u00a0/g, " ");',
    after: "return text;",
  },
  {
    path: "modules/security.js",
    before:
      'export function sanitizeHTML(html) {\n  if (!html || typeof html !== "string") return "";',
    after:
      'export function sanitizeHTML(html) {\n  if (!html || typeof html !== "string") return "";\n  // Already encoded text cannot create markup without a literal less-than sign.\n  if (!html.includes("<")) return html;',
  },
] as const

async function manifest(): Promise<SourceManifest> {
  const value = JSON.parse(
    await readFile(join(root, "upstream", "spreadsheet", "manifest.json"), "utf8"),
  ) as SourceManifest
  if (
    value.commit !== spreadsheetCommit ||
    !Array.isArray(value.files) ||
    value.files.length !== 33 ||
    value.files.some(
      (file) =>
        !/^(?:[\w-]+\/)*[\w.-]+$/.test(file.path) ||
        file.path.includes("..") ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 200_000 ||
        !/^[a-f0-9]{64}$/.test(file.sha256),
    )
  ) {
    throw new RunError("INVALID_UPSTREAM_MANIFEST")
  }
  return value
}

export async function writeVerifiedSourceFile(
  target: string,
  expected: Pick<SourceFile, "bytes" | "sha256">,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  const temporary = join(dirname(target), "." + basename(target) + "." + randomUUID() + ".tmp")
  const reader = body.getReader()
  let staged: FileHandle | undefined
  try {
    await mkdir(dirname(target), { recursive: true })
    staged = await open(temporary, "wx")
    const hash = createHash("sha256")
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > expected.bytes) throw new RunError("UPSTREAM_HASH_MISMATCH")
      hash.update(value)
      await staged.writeFile(value)
    }
    if (size !== expected.bytes || hash.digest("hex") !== expected.sha256)
      throw new RunError("UPSTREAM_HASH_MISMATCH")
    await staged.sync()
    await staged.close()
    // A same-directory hard link publishes complete bytes atomically and never replaces a file.
    await link(temporary, target)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    if (staged) {
      await staged.close()
      await unlink(temporary)
    }
  }
}

export async function installSpreadsheet(): Promise<{ downloaded: number; verified: number }> {
  let downloaded = 0
  const source = await manifest()
  for (const file of source.files) {
    const target = join(spreadsheetCache, file.path)
    let bytes: Buffer | undefined
    try {
      bytes = await readFile(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (!bytes) {
      const response = await fetch(
        `https://raw.githubusercontent.com/supunlakmal/spreadsheet/${spreadsheetCommit}/${file.path}`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      )
      if (!response.ok || !response.body) throw new RunError("UPSTREAM_DOWNLOAD_FAILED")
      await writeVerifiedSourceFile(target, file, response.body)
      downloaded++
      continue
    }
    // Never silently replace somebody's changed cache file.
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new RunError("UPSTREAM_HASH_MISMATCH")
  }
  return { downloaded, verified: source.files.length }
}

export async function spreadsheetFiles(
  cache = spreadsheetCache,
  variant: SpreadsheetVariant = "upstream",
) {
  const source = await manifest()
  const files = new Map<string, Buffer>()
  // No network calls during a demo. Verify and load exact upstream bytes before serving.
  for (const file of source.files) {
    let bytes: Buffer
    try {
      bytes = await readFile(join(cache, file.path))
    } catch {
      throw new RunError("SPREADSHEET_NOT_INSTALLED")
    }
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new RunError("UPSTREAM_HASH_MISMATCH")
    const patch =
      variant === "patched"
        ? spreadsheetPatches.find((patch) => patch.path === file.path)
        : undefined
    if (patch) {
      const text = bytes.toString("utf8")
      if (text.split(patch.before).length !== 2) throw new RunError("UPSTREAM_PATCH_MISMATCH")
      bytes = Buffer.from(text.replace(patch.before, patch.after))
    }
    files.set(`/${file.path}`, bytes)
  }
  const hash = createHash("sha256")
  for (const [path, bytes] of files) hash.update(path).update("\0").update(bytes).update("\0")
  return { files, sha256: hash.digest("hex") }
}

export async function serveSpreadsheet(
  files: Map<string, Buffer>,
  options: { publicOrigin?: string; host?: string; port?: number } = {},
): Promise<FixtureHandle> {
  let origin = options.publicOrigin ?? ""
  if (origin && new URL(origin).origin !== origin) throw new RunError("SERVER_ADDRESS_INVALID")
  const server = createServer((request, response) => {
    // The authenticated preview gateway may rewrite Host on its request to the guest.
    if (!options.publicOrigin && request.headers.host !== new URL(origin).host) {
      response.writeHead(403).end()
      return
    }
    if (request.method !== "GET") {
      response.writeHead(405).end()
      return
    }
    let pathname: string
    try {
      pathname = new URL(request.url ?? "/", origin).pathname
    } catch {
      response.writeHead(400).end()
      return
    }
    if (pathname === "/health") {
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ service: "csv-import-verifier", schemaVersion: 1, ready: true }))
      return
    }
    const resource = pathname === "/" ? "/index.html" : pathname
    const bytes = files.get(resource)
    if (!bytes) {
      response.writeHead(404).end()
      return
    }
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    }
    response
      .writeHead(200, {
        "Content-Type": types[extname(resource)] ?? "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .end(bytes)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new RunError("SERVER_ADDRESS_INVALID")
  }
  origin ||= `http://127.0.0.1:${address.port}`
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
