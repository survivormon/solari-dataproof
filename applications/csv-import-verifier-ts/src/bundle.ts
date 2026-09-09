import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { spreadsheetFiles, type SpreadsheetVariant } from "./spreadsheet-source.js"

export interface FixtureBundle {
  files: Array<{ path: string; bytes: Buffer }>
  sha256: string
}

export async function bundleSpreadsheet(
  variant: SpreadsheetVariant = "upstream",
): Promise<FixtureBundle> {
  const source = await spreadsheetFiles(undefined, variant)
  const assets = [...source.files].map(([path, bytes]) => [path, bytes.toString("base64")])
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("./", import.meta.url)),
      contents: `
      import { serveSpreadsheet } from "./spreadsheet-source.js";
      import { resolve } from "node:path";
      import { fileURLToPath } from "node:url";
      const files = new Map(${JSON.stringify(assets)}.map(([path, base64]) => [path, Buffer.from(base64, "base64")]));
      export const sourceSha256 = ${JSON.stringify(source.sha256)};
      export const startSpreadsheet = (options = {}) => serveSpreadsheet(files, options);
      if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
        const publicOrigin = process.argv[2];
        if (!publicOrigin) throw new Error("PUBLIC_ORIGIN_REQUIRED");
        const server = await startSpreadsheet({ publicOrigin, host: "0.0.0.0", port: 3000 });
        for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void server.close() });
      }
    `,
    },
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    write: false,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  })
  return finishBundle([
    {
      path: "/tmp/csv-import-verifier/dist/server.mjs",
      bytes: Buffer.from(result.outputFiles[0]!.contents),
    },
  ])
}

function finishBundle(files: FixtureBundle["files"]): FixtureBundle {
  const hash = createHash("sha256")
  for (const file of files) hash.update(file.path).update("\0").update(file.bytes).update("\0")
  return { files, sha256: hash.digest("hex") }
}
