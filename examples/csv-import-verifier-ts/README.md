# CSV import verifier

Upload customer data into a real spreadsheet, export it, reload the page, and
compare both exports with independently written expectations. Solari
hosts the app in a sandbox and drives it with a cloud browser. The HTML report
shows which differences appear before or after reload, screenshots, and the actual
CSV downloads. Both exports must match for PASS.

## Run

Requires Node 22+ and a Solari API key in your shell environment.

```sh
cd examples/csv-import-verifier-ts
npm install
npm run spreadsheet:install
export SOLARI_API_KEY=your_key
npm start -- --plan
npm start -- --live
```

Each `--live` invocation creates one sandbox and one browser; resources are billed
by Solari. The plan command needs no key. `.env` files are not loaded.

The target is MIT-licensed [Spreadsheet Live](https://github.com/supunlakmal/spreadsheet),
pinned to `fdad288df3de36fc6c235c6bc24d94fa8a30bf5d`. Installation fetches 33
hash-verified source files. The demo exposes two defects: ampersands become literal
`&amp;` after reload in certain notes, and export replaces nonbreaking spaces.
Run again with `--variant patched` to apply two small in-memory source fixes.
The verified upstream cache stays unchanged. Embedded CRLF still becomes LF;
the tests retain that failure.

## Local check and custom data

The same workflow can run with a local browser, without a Solari account:

```sh
npm run browser:install
npm run local
npm run local -- --variant patched
```

Use the [demo CSV](demo/customers.csv) and [expected JSON](demo/expected.json) as
templates, then pass `--input your.csv --expected your.json` to either command.
Write expectations independently of the app's export. The fixed schema
is `source_row,customer_id,name,note`: up to 50 rows, 256 KB per file, valid UTF-8,
unique customer IDs and integer source rows starting at 2. Text is compared exactly.
Persistence means reloading the app's URL fragment; this does not test database
durability, formulas, or arbitrary importers. Add `--headed` to watch a local run.

Exit codes: `0` match, `1` mismatch, `2` invalid arguments, `3` execution or cleanup
failure. Each run prints its `output/` report path. Reports include your input data.

Cloud work stops at 120 seconds, with cleanup allowed until 180 seconds. Failed or
unconfirmed cleanup prevents PASS. If interrupted, inspect the printed private
`.solari-state/` journal and use `npm run solari:recover -- --file <journal> --live`.
Recovery addresses recorded resources only; do not automatically retry failed runs.

## Check the code

```sh
npm run typecheck
npm test
npm run test:e2e
```

Tests use local browsers and doubles, including an eight-case upstream/patched
regression matrix. Start with `index.ts`, `src/spreadsheet-adapter.ts` for the UI
workflow, and `src/compare.ts` for exact comparison. Remote ownership and cleanup
are in `src/solari.ts`.
