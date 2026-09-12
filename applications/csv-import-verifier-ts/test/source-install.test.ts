import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { digest, writeVerifiedSourceFile } from "../src/spreadsheet-source.js"
import { removeTestDirectory } from "./temp.js"

const content = Buffer.from("complete pinned source")
const expected = { bytes: content.length, sha256: digest(content) }
const body = (bytes = content) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

test("source install: an interrupted download leaves no cache file and a retry succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-source-install-"))
  const target = join(directory, "source.js")
  const abandoned = ".source.js.abandoned.tmp"
  const abandonedBytes = Buffer.from("previous process's partial download")
  let pulls = 0
  let observedPartialStage = false
  const interrupted = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(content.subarray(0, 5))
          return
        }
        const entries = await readdir(directory)
        const staging = entries.find((entry) => entry !== abandoned)
        assert.ok(staging)
        assert.ok(staging.endsWith(".tmp"))
        assert.deepEqual(await readFile(join(directory, staging)), content.subarray(0, 5))
        observedPartialStage = true
        controller.error(new Error("connection interrupted"))
      },
    },
    { highWaterMark: 0 },
  )
  try {
    await writeFile(join(directory, abandoned), abandonedBytes, { flag: "wx" })
    await assert.rejects(writeVerifiedSourceFile(target, expected, interrupted), {
      message: "connection interrupted",
    })
    assert.equal(observedPartialStage, true)
    assert.deepEqual(await readdir(directory), [abandoned])
    await writeVerifiedSourceFile(target, expected, body())
    assert.deepEqual(await readFile(target), content)
    assert.deepEqual(await readFile(join(directory, abandoned)), abandonedBytes)
    assert.deepEqual((await readdir(directory)).sort(), [abandoned, "source.js"])
  } finally {
    await removeTestDirectory(directory)
  }
})

test("source install: short, oversized and changed downloads never become cache entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-source-install-"))
  try {
    for (const bytes of [
      content.subarray(0, content.length - 1),
      Buffer.concat([content, Buffer.from("extra")]),
      Buffer.alloc(content.length, "x"),
    ]) {
      await assert.rejects(
        writeVerifiedSourceFile(join(directory, "source.js"), expected, body(bytes)),
        { code: "UPSTREAM_HASH_MISMATCH" },
      )
      assert.deepEqual(await readdir(directory), [])
    }
  } finally {
    await removeTestDirectory(directory)
  }
})

test("source install: oversized downloads cancel the remaining stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-source-install-"))
  let cancelled = false
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(expected.bytes + 1))
    },
    cancel() {
      cancelled = true
    },
  })
  try {
    await assert.rejects(
      writeVerifiedSourceFile(join(directory, "source.js"), expected, oversized),
      { code: "UPSTREAM_HASH_MISMATCH" },
    )
    assert.equal(cancelled, true)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await removeTestDirectory(directory)
  }
})

test("source install: a cache file created during download is never overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "csv-source-install-"))
  const target = join(directory, "source.js")
  const changed = Buffer.from("somebody else's changed source")
  const racing = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await writeFile(target, changed, { flag: "wx" })
      controller.enqueue(content)
      controller.close()
    },
  })
  try {
    await assert.rejects(writeVerifiedSourceFile(target, expected, racing), { code: "EEXIST" })
    assert.deepEqual(await readFile(target), changed)
    assert.deepEqual(await readdir(directory), ["source.js"])
  } finally {
    await removeTestDirectory(directory)
  }
})
