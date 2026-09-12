/**
 * Safe, fixed guidance for operators. Never include an exception message or user-supplied path.
 */
export function describeError(code: string, stage?: string): string {
  switch (code) {
    case "SPREADSHEET_NOT_INSTALLED":
      return "The pinned spreadsheet source is missing. Run npm run spreadsheet:install, then run the demonstration again."
    case "BROWSER_NOT_INSTALLED":
      return "The pinned Chromium browser is missing. Run npm run browser:install, then run the demonstration again."
    case "UPSTREAM_HASH_MISMATCH":
      return "Cached spreadsheet source differs from the pinned manifest. Preserve the cache for inspection; do not edit the manifest or silently replace changed files."
    case "UPSTREAM_PATCH_MISMATCH":
      return "The documented patch does not match the pinned source. Inspect the source and patch together before running the patched case."
    case "INVALID_UPSTREAM_MANIFEST":
      return "The spreadsheet source manifest is invalid. Restore the reviewed manifest for this version before installing or running the demonstration."
    case "UPSTREAM_DOWNLOAD_FAILED":
    case "SPREADSHEET_INSTALL_FAILED":
      return "The pinned spreadsheet source could not be installed. Check network access and local write permissions, then run npm run spreadsheet:install."
    case "CSV_FILE_NOT_FOUND":
      return "The CSV input file was not found. Check the file supplied with --input."
    case "CSV_FILE_UNREADABLE":
      return "The CSV input must be a readable file. Check the file supplied with --input and its permissions."
    case "EXPECTED_FILE_NOT_FOUND":
      return "The expectation file was not found. Check the independent JSON expectation supplied with --expected."
    case "EXPECTED_FILE_UNREADABLE":
      return "The independent JSON expectation must be a readable file. Check the file supplied with --expected and its permissions."
    case "INVALID_ARGUMENTS":
      return "The command arguments are invalid. Use --help for supported options; custom input requires both --input and --expected."
    case "INPUT_TOO_LARGE":
      return "Each input file must be at most 256,000 bytes. Use a smaller CSV and its independently authored JSON expectation."
    case "INVALID_EXPECTED_JSON":
      return "The expectation file is not valid JSON. Correct its JSON syntax while preserving the independently authored expected records."
    case "INVALID_JSON":
      return stage === "preflight"
        ? "The expectation file is not valid JSON. Correct its JSON syntax before running the verification."
        : "A verification artifact is not valid JSON. Preserve the evidence and inspect the failed checkpoint."
    case "INVALID_UTF8":
      return "The input or exported data contains invalid UTF-8 bytes. Preserve the original bytes and provide valid UTF-8 data before interpreting the result."
    case "INVALID_SPREADSHEET_EXPORT":
      return "CSV data is malformed or does not match the source_row, customer_id, name, note schema. Inspect the input CSV or the export at the failed checkpoint."
    case "INVALID_EXPORT":
      return stage === "preflight"
        ? "The expectation does not match the required schemaVersion 1 JSON structure. Check accepted records, source rows, and rejection records."
        : "The exported records do not match the verification schema. Preserve the evidence; malformed exports cannot establish an integrity verdict."
    case "UNSUPPORTED_SPREADSHEET_INPUT":
      return "This demonstration supports at most 50 customer rows with unique IDs and a nonempty independent expectation. Duplicate rejection is outside the supported spreadsheet policy."
    case "TIMEOUT":
    case "DEADLINE_EXCEEDED":
      return "The operation exceeded its time limit. Preserve the report and inspect the failed stage before rerunning; increasing the limit does not establish correctness."
    case "EXPORT_TIMEOUT":
      return "The browser export did not finish within its time limit. Preserve the report and inspect the failed export checkpoint before rerunning."
    case "EXPORT_FAILED":
    case "EXPORT_TRANSFER_FAILED":
    case "EXPORT_EMPTY":
      return "The browser did not provide a complete export. Preserve the report and inspect the export checkpoint; an incomplete download cannot establish an integrity verdict."
    case "EXPORT_TOO_LARGE":
      return "The CSV data exceeds the 256,000-byte verification limit. Inspect the input or export at the failed checkpoint."
    case "UNEXPECTED_EXPORT_URL":
      return "The export came from an unexpected origin. Inspect the pinned application and export flow before rerunning."
    case "PAGE_UNAVAILABLE":
    case "RELOAD_FAILED":
      return "The spreadsheet page could not be loaded or reloaded. Inspect the local browser and fixture server before rerunning."
    case "BROWSER_DISCONNECTED":
      return "The browser disconnected before verification finished. Preserve the available evidence and inspect the browser environment."
    case "CLEANUP_FAILED":
    case "CLEANUP_UNCONFIRMED":
      return "Resource shutdown failed or could not be confirmed. Completed comparisons remain evidence, but the run is incomplete and cannot be PASS. Chromium shutdown has a known Windows limitation; use the supported Ubuntu environment for release evidence."
    case "DEMO_INTERRUPTED":
    case "INTERRUPTED":
    case "RUN_ENDED":
      return "The run was interrupted. Preserve any available evidence; an interrupted run cannot be treated as a completed verification."
    case "DEMO_INPUT_CHANGED":
      return "The bundled demonstration input or expectation differs from its frozen hash. Preserve the changed files and restore the reviewed sample before running the demonstration."
    case "DEMO_RUN_FAILED":
      return "The demonstration could not finish. Preserve its available reports and inspect the failed case before rerunning."
    case "DEMO_UNEXPECTED_RESULT":
      return "The demonstration did not meet its expected comparison, source, input, or cleanup contract. Inspect both case reports and preserve the evidence; do not change the expected result to force success."
    case "OUTPUT_DIRECTORY_FAILED":
    case "OUTPUT_WRITE_FAILED":
    case "REPORT_WRITE_FAILED":
      return "The evidence output could not be written completely. Check free space and output-directory permissions; preserve partial files and use a new run directory after resolving the problem."
    default:
      return "The verification could not finish. Preserve any available evidence and inspect the reported stage and error code before rerunning."
  }
}
