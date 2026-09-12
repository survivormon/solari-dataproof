# Solari DataProof

Import a customer CSV into a real spreadsheet, export it, reload the page, and
compare both exports with independently written expectations. The bundled demo
reproduces two data-preservation bugs in Spreadsheet Live, then passes with two
small source patches. An HTML report shows the exact changed values, screenshots,
and exported CSVs. Both exports must match for PASS.

[Download the recorded demo](https://github.com/survivormon/solari-dataproof/releases/tag/dataproof-v0.2.1) for an install-free walkthrough. Extract the ZIP and open `dataproof-demo/index.html`; it includes the dated reports, raw CSVs, screenshots, and artifact hashes.

## Run the local demo

Use Ubuntu 24.04 with Node 22 or 24 and npm for the supported local path. Installation needs network access; installing browser system libraries may request sudo. No Solari account or API key is needed. Windows browser shutdown remains intermittently unreliable; use the recorded demo there.
From the repository root of tag `dataproof-v0.2.1`:

```sh
cd applications/csv-import-verifier-ts
npm ci
npm run spreadsheet:install
npm run browser:install -- --with-deps
npm run demo
```

One command runs the original and patched app, then prints a `file://` link to
`output/demo/<run-id>/index.html`. Open it in your browser; it does not open automatically.
Exit `0` means **Demo verified**: the exact original defects
were reproduced, the patched exports matched at both checkpoints, the input and
source hashes matched the frozen demo, and all resources closed. The original
case retains its expected `FAIL` verdict inside the report.

Use `npm run demo -- --headed` to watch the browser on a desktop. The installed
demo runs locally without external service calls.

Each attempt keeps a new report under `output/demo/`. Cancellation, incomplete
cleanup, or an unexpected result stops the sequence and retains completed
evidence. The summary never treats partial execution as a verified demonstration.
If reload or the second export fails, the report still shows the completed
first comparison while retaining an execution-failure verdict.
Local browser work has a 120-second deadline per case, followed by a separate
48-second cleanup budget. Browser shutdown remains capped at 35 seconds.

For individual runs, use `npm run local` (original, expected exit `1`) or
`npm run local -- --variant patched` (expected exit `0`).

The target is MIT-licensed [Spreadsheet Live](https://github.com/supunlakmal/spreadsheet),
pinned to `fdad288df3de36fc6c235c6bc24d94fa8a30bf5d`. Installation fetches 33
hash-verified source files. The lockfile fixes npm dependency versions, and the
pinned Playwright package selects the Chromium revision used by the demo and tests.
Installation needs network access; the local demo uses the verified source cache.

The demo exposes two defects: ampersands become literal `&amp;` after reload in
certain notes, and export replaces nonbreaking spaces. `--variant patched` applies
two in-memory fixes from `src/spreadsheet-source.ts`; the verified upstream cache
stays unchanged. Embedded CRLF still becomes LF, and the tests retain that failure.

### Windows limitation

On the Windows validation host, pinned Chromium intermittently exceeded the
35-second browser cleanup deadline, including the small README demo. The full
Windows matrix and that demo failed with `INFRA_ERROR`; successful data comparison
did not override incomplete cleanup. Windows local-browser reliability is not
release-validated. Use Ubuntu 24.04 with Node 22 or 24 for the validated local path.
The benchmark now honors test cancellation and stops starting new cases after a
deadline; the current case keeps its existing cleanup path.

## Custom data and limits

Use the [demo CSV](demo/customers.csv) and [expected JSON](demo/expected.json) as
templates, then pass `--input your.csv --expected your.json` to the local or cloud
command. Write expectations independently of the app's export. The fixed schema
is `source_row,customer_id,name,note`: up to 50 rows, 256 KB per file, valid UTF-8,
unique customer IDs and integer source rows starting at 2. Text is compared exactly.

Persistence means reloading the app's URL fragment; this does not test database
durability, formulas, or arbitrary importers. Reports include your input data and
are written under the ignored `output/` directory.

Individual-run exit codes: `0` match, `1` mismatch, `2` invalid arguments, `3` execution or cleanup
failure. Each run prints its report path. The paired demo uses `0` for a verified
demonstration, `1` for an unexpected result, `2` for invalid arguments, and `3`
for incomplete execution.

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
unconfirmed cleanup prevents PASS. A separate process watchdog forcibly stops an
unresponsive worker at 200 seconds. Interruption remains a failed run even when it
arrives during cleanup. If interrupted or forcibly stopped, inspect the printed private
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
After the checks, CI also runs `npm run demo` and retains its comparison report,
raw exports, and screenshots as a downloadable artifact for each Node version.

Start with `index.ts`, `src/spreadsheet-adapter.ts` for the UI workflow, and
`src/compare.ts` for exact comparison. Remote ownership and cleanup are in
`src/solari.ts`.
