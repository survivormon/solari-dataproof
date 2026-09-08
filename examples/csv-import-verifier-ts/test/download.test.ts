import assert from "node:assert/strict"
import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import type { ImportAdapter } from "../src/spreadsheet-adapter.js"
import { readDownloadBytes } from "../src/download.js"
import { RunError } from "../src/model.js"
import { packageRoot } from "../src/runner.js"
import { spreadsheetAdapter } from "../src/spreadsheet-adapter.js"
import { removeTestDirectory } from "./temp.js"

const url = "http://127.0.0.1:3210"
function downloadDouble(overrides: Partial<Parameters<typeof readDownloadBytes>[0]> = {}) {
  let cancellations = 0
  return {
    url: () => `blob:${url}/test-download`,
    failure: async () => null,
    createReadStream: async () => Readable.from([Buffer.from("export")]),
    cancel: async () => {
      cancellations++
    },
    ...overrides,
    get cancellations() {
      return cancellations
    },
  }
}

function pageDouble(download: ReturnType<typeof downloadDouble>): Parameters<ImportAdapter>[0] {
  const locator = {
    waitFor: async () => {},
    setInputFiles: async () => {},
    click: async () => {},
    textContent: async () => "Import successful",
    innerText: async () => "Import successful",
    getAttribute: async () => "complete",
  }
  return {
    goto: async () => ({ ok: () => true }),
    reload: async () => ({ ok: () => true }),
    url: () => url,
    content: async () => "<p>synthetic test</p>",
    locator: () => locator,
    getByText: () => locator,
    getByRole: () => locator,
    getByLabel: () => locator,
    waitForURL: async () => {},
    screenshot: async () => {},
    waitForEvent: async () => download,
  } as unknown as Parameters<ImportAdapter>[0]
}

test("download: complete bytes at the size limit are returned without cancellation", async () => {
  const first = Buffer.alloc(128_000, "a"),
    second = Buffer.alloc(128_000, "b")
  const download = downloadDouble({ createReadStream: async () => Readable.from([first, second]) })
  assert.deepEqual(await readDownloadBytes(download, 1_000), Buffer.concat([first, second]))
  assert.equal(download.cancellations, 0)
})

test("download: empty, failed, oversized and interrupted transfers preserve their error", async () => {
  const cases: [Partial<Parameters<typeof readDownloadBytes>[0]>, string][] = [
    [{ failure: async () => "download rejected" }, "EXPORT_FAILED"],
    [{ createReadStream: async () => Readable.from([]) }, "EXPORT_EMPTY"],
    [{ createReadStream: async () => Readable.from([Buffer.alloc(256_001)]) }, "EXPORT_TOO_LARGE"],
    [
      {
        createReadStream: async () => {
          throw new Error("protocol disconnected")
        },
      },
      "EXPORT_TRANSFER_FAILED",
    ],
    [
      {
        createReadStream: async () => {
          throw new RunError("PRIMARY_FAILURE")
        },
      },
      "PRIMARY_FAILURE",
    ],
    [
      {
        createReadStream: async () =>
          Readable.from(
            (async function* () {
              yield Buffer.from("partial")
              throw new Error("stream disconnected")
            })(),
          ),
      },
      "EXPORT_TRANSFER_FAILED",
    ],
  ]
  for (const [overrides, code] of cases) {
    let cancellations = 0
    const download = downloadDouble({
      ...overrides,
      cancel: async () => {
        cancellations++
        throw new Error("cancellation failed")
      },
    })
    await assert.rejects(readDownloadBytes(download, 1_000), { code })
    assert.equal(cancellations, 1)
  }
})

test(
  "download: a stalled stream is destroyed even when cancellation never settles",
  { timeout: 2_000 },
  async () => {
    const stream = new Readable({ read() {} })
    let cancellations = 0
    const download = downloadDouble({
      createReadStream: async () => stream,
      cancel: () => {
        cancellations++
        return new Promise<void>(() => {})
      },
    })
    await assert.rejects(readDownloadBytes(download, 20), { code: "EXPORT_TIMEOUT" })
    assert.equal(stream.destroyed, true)
    assert.equal(cancellations, 1)
  },
)

test(
  "download: late stream and cancellation rejections are consumed",
  { timeout: 2_000 },
  async () => {
    let rejectStream!: (error: Error) => void, rejectCancel!: (error: Error) => void
    const download = downloadDouble({
      createReadStream: () =>
        new Promise<Readable>((_, reject) => {
          rejectStream = reject
        }),
      cancel: () =>
        new Promise<void>((_, reject) => {
          rejectCancel = reject
        }),
    })
    await assert.rejects(readDownloadBytes(download, 20), { code: "EXPORT_TIMEOUT" })
    rejectStream(new Error("late stream failure"))
    rejectCancel(new Error("late cancellation failure"))
    await setImmediate()
  },
)

test(
  "download: timeout during status prevents a late stream acquisition",
  { timeout: 2_000 },
  async () => {
    let resolveStatus!: (value: null) => void,
      acquisitions = 0
    const download = downloadDouble({
      failure: () =>
        new Promise<null>((resolve) => {
          resolveStatus = resolve
        }),
      createReadStream: async () => {
        acquisitions++
        return Readable.from([Buffer.from("late")])
      },
    })
    await assert.rejects(readDownloadBytes(download, 20), { code: "EXPORT_TIMEOUT" })
    resolveStatus(null)
    await setImmediate()
    assert.equal(acquisitions, 0)
  },
)

const adapter = spreadsheetAdapter
test(
  `spreadsheet: outer cancellation prevents late bytes from publishing artifacts`,
  { timeout: 2_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "csv-download-abort-"))
    const controller = new AbortController()
    let resolveStream!: (value: Readable) => void
    let streamReady!: () => void
    const streamStarted = new Promise<void>((resolve) => {
      streamReady = resolve
    })
    const download = downloadDouble({
      createReadStream: () =>
        new Promise<Readable>((resolve) => {
          resolveStream = resolve
          streamReady()
        }),
    })
    try {
      const operation = adapter(pageDouble(download), {
        url,
        inputPath: join(packageRoot, "demo", "customers.csv"),
        outputDirectory: directory,
        timeoutMs: 1_000,
        signal: controller.signal,
        onStep: () => {},
      })
      const rejected = assert.rejects(operation, { code: "EXPORT_ABORTED" })
      await streamStarted
      controller.abort()
      await rejected
      const stream = Readable.from([Buffer.from("late successful export")])
      resolveStream(stream)
      await setImmediate()
      assert.equal(stream.destroyed, true)
      assert.deepEqual(await readdir(directory), [])
    } finally {
      await removeTestDirectory(directory)
    }
  },
)
test(
  `spreadsheet: a stream arriving after timeout is destroyed and cannot write an export`,
  { timeout: 2_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "csv-download-late-"))
    let resolveStream!: (value: Readable) => void,
      validatedDownloads = 0,
      cancellations = 0
    const download = downloadDouble({
      createReadStream: () =>
        new Promise<Readable>((resolve) => {
          resolveStream = resolve
        }),
      cancel: () => {
        cancellations++
        return new Promise<void>(() => {})
      },
    })
    try {
      await assert.rejects(
        adapter(pageDouble(download), {
          url,
          inputPath: join(packageRoot, "demo", "customers.csv"),
          outputDirectory: directory,
          timeoutMs: 20,
          onStep: () => {},
          validateArtifact: (bytes) => {
            if (Buffer.isBuffer(bytes)) validatedDownloads++
          },
        }),
        { code: "EXPORT_TIMEOUT" },
      )
      assert.equal(cancellations, 1)
      assert.deepEqual(await readdir(directory), [])
      const stream = new Readable({
        read() {
          this.push(Buffer.from("late export"))
          this.push(null)
        },
        destroy(_error, callback) {
          callback(new Error("late stream cleanup failure"))
        },
      })
      const closed = new Promise<void>((resolve) => stream.once("close", resolve))
      resolveStream(stream)
      await closed
      await setImmediate()
      assert.equal(stream.destroyed, true)
      assert.equal(validatedDownloads, 0)
      assert.deepEqual(await readdir(directory), [])
    } finally {
      await removeTestDirectory(directory)
    }
  },
)

test(
  "spreadsheet: unexpected export URL survives a stalled cancellation",
  { timeout: 2_000 },
  async () => {
    const download = {
      ...downloadDouble({ cancel: () => new Promise<void>(() => {}) }),
      url: () => "https://unexpected.invalid/export.csv",
    }
    await assert.rejects(
      spreadsheetAdapter(pageDouble(download), {
        url,
        inputPath: join(packageRoot, "demo", "customers.csv"),
        outputDirectory: "unused-output",
        timeoutMs: 20,
        onStep: () => {},
      }),
      { code: "UNEXPECTED_EXPORT_URL" },
    )
  },
)
