import { isUtf8 } from "node:buffer"

export interface Customer {
  sourceRow: number
  customer_id: string
  name: string
  note: string
}

export interface Rejection {
  sourceRow: number
  customer_id: string
  reason: "DUPLICATE_ID"
}

export interface ImportExport {
  schemaVersion: 1
  accepted: Customer[]
  rejected: Rejection[]
}

export type Outcome = "PASS" | "FAIL" | "INFRA_ERROR"

export class RunError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function decodeUtf8(bytes: Buffer): string {
  if (!isUtf8(bytes)) throw new RunError("INVALID_UTF8")
  return bytes.toString("utf8")
}

// Runtime validation prevents a failed/partial download from looking like an empty successful import.
export function parseExport(value: unknown): ImportExport {
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.accepted) ||
    !Array.isArray(value.rejected)
  ) {
    throw new RunError("INVALID_EXPORT")
  }
  const sourceRows = new Set<number>()
  const checkRow = (row: unknown): row is Record<string, unknown> => {
    if (
      !object(row) ||
      !Number.isSafeInteger(row.sourceRow) ||
      Number(row.sourceRow) < 2 ||
      typeof row.customer_id !== "string" ||
      row.customer_id.length === 0 ||
      sourceRows.has(Number(row.sourceRow))
    )
      return false
    sourceRows.add(Number(row.sourceRow))
    return true
  }
  for (const row of value.accepted) {
    if (!checkRow(row) || typeof row.name !== "string" || typeof row.note !== "string")
      throw new RunError("INVALID_EXPORT")
  }
  for (const row of value.rejected) {
    if (!checkRow(row) || row.reason !== "DUPLICATE_ID") throw new RunError("INVALID_EXPORT")
  }
  return value as unknown as ImportExport
}
