import { realpath, rm } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { tmpdir } from "node:os"

export async function removeTestDirectory(directory: string): Promise<void> {
  const target = await realpath(directory)
  const parent = await realpath(tmpdir())
  if (resolve(dirname(target)) !== resolve(parent) || !basename(target).startsWith("csv-")) {
    throw new Error("Refusing cleanup outside an owned CSV test temp directory")
  }
  await rm(target, { recursive: true })
}
