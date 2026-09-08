import type { Download } from "./browser-types.js"
import { RunError } from "./model.js"

type ByteDownload = Pick<Download, "failure" | "createReadStream" | "cancel">

export async function cancelDownload(
  download: Pick<Download, "cancel">,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => download.cancel())
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(timeoutMs, 1_000))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Keep artifact writes outside this race: a late protocol reply must never publish an export.
export async function readDownloadBytes(
  download: ByteDownload,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let onAbort: (() => void) | undefined
  let stream: Awaited<ReturnType<ByteDownload["createReadStream"]>> | undefined
  try {
    return await Promise.race([
      (async () => {
        if (await download.failure()) throw new RunError("EXPORT_FAILED")
        if (stopped) throw new RunError("EXPORT_TIMEOUT")
        stream = await download.createReadStream()
        // A stream acquired after timeout still belongs to this operation and must be closed.
        stream.on("error", () => {})
        if (stopped) {
          stream.destroy()
          throw new RunError("EXPORT_TIMEOUT")
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of stream) {
          size += chunk.length
          if (size > 256_000) throw new RunError("EXPORT_TOO_LARGE")
          chunks.push(Buffer.from(chunk))
        }
        if (stopped) throw new RunError("EXPORT_TIMEOUT")
        const bytes = Buffer.concat(chunks)
        if (bytes.length === 0) throw new RunError("EXPORT_EMPTY")
        return bytes
      })(),
      new Promise<never>((_, reject) => {
        const stop = (code: string) => {
          stopped = true
          reject(new RunError(code))
          stream?.destroy()
        }
        onAbort = () => stop("EXPORT_ABORTED")
        signal?.addEventListener("abort", onAbort, { once: true })
        if (signal?.aborted) onAbort()
        timer = setTimeout(() => stop("EXPORT_TIMEOUT"), timeoutMs)
      }),
    ])
  } catch (error) {
    stopped = true
    stream?.destroy()
    await cancelDownload(download, timeoutMs)
    throw error instanceof RunError ? error : new RunError("EXPORT_TRANSFER_FAILED")
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}
