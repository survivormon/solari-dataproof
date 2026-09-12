import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "csv-parse/sync"
import type { Page } from "./browser-types.js"
import { cancelDownload, readDownloadBytes } from "./download.js"
import { decodeUtf8, parseExport, RunError, type ImportExport } from "./model.js"

export interface AdapterInput {
  url: string
  inputPath: string
  outputDirectory: string
  timeoutMs: number
  signal?: AbortSignal
  onStep(step: string): void
  onCheckpoint?(
    phase: "beforeReload" | "afterReload",
    exportPath: string,
    successMessage: string,
  ): Promise<void>
  validateArtifact?(bytes: Buffer | string): void
}
export interface AdapterResult {
  exportPath: string
  beforeReloadPath: string
  successMessage: string
}
export type ImportAdapter = (page: Page, input: AdapterInput) => Promise<AdapterResult>

export function normalizeSpreadsheetCSV(bytes: Buffer): ImportExport {
  if (bytes.length > 256_000) throw new RunError("EXPORT_TOO_LARGE")
  const text = decodeUtf8(bytes)
  let rows: string[][]
  try {
    rows = parse(text, { bom: true, relax_column_count: false, cast: false }) as string[][]
  } catch {
    throw new RunError("INVALID_SPREADSHEET_EXPORT")
  }
  const header = rows.shift()
  if (
    JSON.stringify(header) !== JSON.stringify(["source_row", "customer_id", "name", "note"]) ||
    rows.length === 0 ||
    rows.some((row) => row.length !== 4 || !/^[1-9]\d*$/.test(row[0] ?? ""))
  ) {
    throw new RunError("INVALID_SPREADSHEET_EXPORT")
  }
  return parseExport({
    schemaVersion: 1,
    accepted: rows.map(([sourceRow, customer_id, name, note]) => ({
      sourceRow: Number(sourceRow),
      customer_id,
      name,
      note,
    })),
    rejected: [],
  })
}

// Uses only ordinary file upload, menu clicks, editable cells, reloads and the downloaded CSV.
export const spreadsheetAdapter: ImportAdapter = async (page, input) => {
  const cell = '.cell-content[data-row="1"][data-col="1"]'
  const exportCSV = async (name: string) => {
    input.signal?.throwIfAborted()
    await page.locator("#tools-menu-btn").click()
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#export-csv").click(),
    ])
    if (!download.url().startsWith(`blob:${input.url}/`)) {
      await cancelDownload(download, input.timeoutMs)
      throw new RunError("UNEXPECTED_EXPORT_URL")
    }
    const bytes = await readDownloadBytes(download, input.timeoutMs, input.signal)
    input.validateArtifact?.(bytes)
    input.signal?.throwIfAborted()
    await writeFile(join(input.outputDirectory, `${name}.csv`), bytes, {
      flag: "wx",
      signal: input.signal,
    })
    const normalized = normalizeSpreadsheetCSV(bytes)
    const exportPath = join(input.outputDirectory, `${name}.json`)
    input.signal?.throwIfAborted()
    await writeFile(exportPath, JSON.stringify(normalized, null, 2) + "\n", {
      flag: "wx",
      signal: input.signal,
    })
    return exportPath
  }
  input.onStep("open independent spreadsheet")
  const response = await page.goto(input.url)
  if (!response?.ok()) throw new RunError("PAGE_UNAVAILABLE")
  await page.locator(cell).waitFor()
  input.onStep("upload")
  const beforeUpload = page.url()
  // Chromium cannot read long Windows host paths; send the original bytes over the wire.
  const buffer = await readFile(input.inputPath, { signal: input.signal })
  input.signal?.throwIfAborted()
  await page
    .locator("#import-csv-file")
    .setInputFiles({ name: "input.csv", mimeType: "text/csv", buffer })
  const success = page.getByText("CSV imported successfully", { exact: true })
  await success.waitFor()
  const successMessage = (await success.textContent()) ?? ""
  await page.waitForURL((url) => url.href !== beforeUpload && url.hash.length > 1)
  // Inspect rendered evidence, not the app's HTML CSP (which includes public wss:// wildcards).
  input.validateArtifact?.(await page.locator("body").innerText())
  input.signal?.throwIfAborted()
  await page.screenshot({
    path: join(input.outputDirectory, "import-success.png"),
    fullPage: true,
  })
  input.onStep("export before reload")
  const beforeReloadPath = await exportCSV("before-reload")
  await input.onCheckpoint?.("beforeReload", beforeReloadPath, successMessage)

  input.onStep("reload persisted import")
  const reload = await page.reload()
  if (!reload?.ok()) throw new RunError("RELOAD_FAILED")
  await page.locator(cell).waitFor()
  input.validateArtifact?.(await page.locator("body").innerText())
  input.signal?.throwIfAborted()
  await page.screenshot({ path: join(input.outputDirectory, "persisted.png"), fullPage: true })
  input.onStep("export")
  // Raw browser output is retained before normalization for independent review.
  const exportPath = await exportCSV("observed")
  await input.onCheckpoint?.("afterReload", exportPath, successMessage)
  return { exportPath, beforeReloadPath, successMessage }
}
