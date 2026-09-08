import { readFile } from "node:fs/promises"
import { runVerification, type RunOptions, type Dependencies } from "../../src/runner.js"

export async function runWithTestInput(
  options: Omit<RunOptions, "input"> & { input?: RunOptions["input"] },
  dependencies: Dependencies,
) {
  return runVerification(
    {
      ...options,
      input: options.input ?? {
        csv: await readFile(new URL("./fixtures/customers.csv", import.meta.url)),
        expected: await readFile(new URL("./fixtures/expected.json", import.meta.url)),
      },
    },
    dependencies,
  )
}
