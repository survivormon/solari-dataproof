# Solari DataProof

Import a customer CSV into a real spreadsheet, export it, reload the page, and
compare both exports with independently written expectations. The bundled demo
reproduces two data-preservation bugs in Spreadsheet Live, then passes with two
small source patches. An HTML report shows the exact changed values, screenshots,
and exported CSVs. Both exports must match for PASS.

## Run the local demo

Requires Node 22+ and npm. No Solari account or API key is needed for this demo.
From the repository root:

```sh
cd applications/csv-import-verifier-ts
npm ci
npm run spreadsheet:install
npm run browser:install
npm run local
```

The upstream run intentionally exits `1`: two differences before reload and three
after it. Now run the patched version:

```sh
npm run local -- --variant patched
```

The patched run exits `0` with no differences. Open each printed `report.html`
path to compare the changed values and downloaded CSVs. Add `--headed` to watch
the local browser. On Linux, install browser system dependencies with
`npm run browser:install -- --with-deps` if they are not already available.

The target is MIT-licensed [Spreadsheet Live](https://github.com/supunlakmal/spreadsheet),
pinned to `fdad288df3de36fc6c235c6bc24d94fa8a30bf5d`. Installation fetches 33
hash-verified source files. The lockfile fixes npm dependency versions, and the
pinned Playwright package selects the Chromium revision used by the demo and tests.
Installation needs network access; the local demo uses the verified source cache.

The demo exposes two defects: ampersands become literal `&amp;` after reload in
certain notes, and export replaces nonbreaking spaces. `--variant patched` applies
two in-memory fixes from `src/spreadsheet-source.ts`; the verified upstream cache
stays unchanged. Embedded CRLF still becomes LF, and the tests retain that failure.

## Custom data and limits

Use the [demo CSV](demo/customers.csv) and [expected JSON](demo/expected.json) as
templates, then pass `--input your.csv --expected your.json` to the local or cloud
command. Write expectations independently of the app's export. The fixed schema
is `source_row,customer_id,name,note`: up to 50 rows, 256 KB per file, valid UTF-8,
unique customer IDs and integer source rows starting at 2. Text is compared exactly.

Persistence means reloading the app's URL fragment; this does not test database
durability, formulas, or arbitrary importers. Reports include your input data and
are written under the ignored `output/` directory.

Exit codes: `0` match, `1` mismatch, `2` invalid arguments, `3` execution or cleanup
failure. Each run prints its report path.

## Run with Solari

The same workflow can run in a Solari sandbox with a cloud browser. Complete
`npm ci` and `npm run spreadsheet:install` above, then inspect the plan:

```sh
npm start -- --plan
```

Set `SOLARI_API_KEY` in your shell environment (`.env` files are not loaded).
For example, in PowerShell use `$env:SOLARI_API_KEY = 'your_key'`; in a POSIX shell
use `export SOLARI_API_KEY=your_key`. Each `--live` invocation creates one sandbox
and one browser, which are billed by Solari:

```sh
npm start -- --live
npm start -- --live --variant patched
```

Cloud work stops at 120 seconds, with cleanup allowed until 180 seconds. Failed or
unconfirmed cleanup prevents PASS. If interrupted, inspect the printed private
`.solari-state/` journal and use `npm run solari:recover -- --file <journal> --live`.
Recovery addresses recorded resources only; do not automatically retry failed runs.

## Check the code

After installing dependencies, Chromium, and the upstream source, run:

```sh
npm run check
```

This runs TypeScript checking, unit tests, and browser E2E tests in order. Tests
use local browsers and doubles, including an eight-case upstream/patched regression
matrix. The path-scoped GitHub Actions workflow runs the same checks on Ubuntu with
Node 22 and 24. It does not exercise the live Solari service.

Start with `index.ts`, `src/spreadsheet-adapter.ts` for the UI workflow, and
`src/compare.ts` for exact comparison. Remote ownership and cleanup are in
`src/solari.ts`.
