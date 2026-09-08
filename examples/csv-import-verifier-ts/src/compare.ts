import type { ImportExport } from "./model.js"

export interface Difference {
  code:
    | "MISSING_RECORD"
    | "UNEXPECTED_RECORD"
    | "DUPLICATE_ID"
    | "FIELD_CHANGED"
    | "REJECTION_CHANGED"
  customerId: string
  sourceRow: number
  field: string
  expected: string | null
  actual: string | null
}

export interface Comparison {
  expectedAccepted: number
  actualAccepted: number
  expectedRejected: number
  actualRejected: number
  differences: Difference[]
}

// No CSV parser or importer code is involved: the oracle is handwritten JSON.
export function compare(expected: ImportExport, actual: ImportExport): Comparison {
  const differences: Difference[] = []
  const expectedIds = new Set(expected.accepted.map((row) => row.customer_id))
  const consumed = new Set<number>()
  const countById = new Map<string, number>()
  for (const row of actual.accepted)
    countById.set(row.customer_id, (countById.get(row.customer_id) ?? 0) + 1)
  for (const [id, count] of countById) {
    if (count > 1)
      differences.push({
        code: "DUPLICATE_ID",
        customerId: id,
        sourceRow: actual.accepted.find((r) => r.customer_id === id)!.sourceRow,
        field: "occurrences",
        expected: "1",
        actual: String(count),
      })
  }
  for (const row of expected.accepted) {
    // Reserve known IDs before using a source row to explain an ID mutation.
    let index = actual.accepted.findIndex(
      (r, i) => !consumed.has(i) && r.customer_id === row.customer_id,
    )
    if (index < 0)
      index = actual.accepted.findIndex(
        (r, i) =>
          !consumed.has(i) && r.sourceRow === row.sourceRow && !expectedIds.has(r.customer_id),
      )
    const observed = actual.accepted[index]
    if (!observed) {
      differences.push({
        code: "MISSING_RECORD",
        customerId: row.customer_id,
        sourceRow: row.sourceRow,
        field: "record",
        expected: "present",
        actual: null,
      })
      continue
    }
    consumed.add(index)
    for (const field of ["sourceRow", "customer_id", "name", "note"] as const) {
      if (row[field] !== observed[field])
        differences.push({
          code: "FIELD_CHANGED",
          customerId: row.customer_id,
          sourceRow: row.sourceRow,
          field,
          expected: String(row[field]),
          actual: String(observed[field]),
        })
    }
  }
  actual.accepted.forEach((row, index) => {
    if (!consumed.has(index))
      differences.push({
        code: "UNEXPECTED_RECORD",
        customerId: row.customer_id,
        sourceRow: row.sourceRow,
        field: "record",
        expected: null,
        actual: "present",
      })
  })
  const rejectedRows = new Set([...expected.rejected, ...actual.rejected].map((r) => r.sourceRow))
  for (const sourceRow of rejectedRows) {
    const wanted = expected.rejected.find((r) => r.sourceRow === sourceRow)
    const observed = actual.rejected.find((r) => r.sourceRow === sourceRow)
    const summarize = (row: typeof wanted) => (row ? `${row.customer_id}: ${row.reason}` : null)
    if (summarize(wanted) !== summarize(observed))
      differences.push({
        code: "REJECTION_CHANGED",
        customerId: wanted?.customer_id ?? observed!.customer_id,
        sourceRow,
        field: "rejection",
        expected: summarize(wanted),
        actual: summarize(observed),
      })
  }
  return {
    expectedAccepted: expected.accepted.length,
    actualAccepted: actual.accepted.length,
    expectedRejected: expected.rejected.length,
    actualRejected: actual.rejected.length,
    differences,
  }
}
