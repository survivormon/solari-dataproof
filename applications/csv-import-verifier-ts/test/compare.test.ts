import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { compare } from "../src/compare.js"
import { parseExport } from "../src/model.js"

const expected = parseExport(
  JSON.parse(await readFile(new URL("./support/fixtures/expected.json", import.meta.url), "utf8")),
)

test("record order is irrelevant and every field remains exact text", () => {
  const actual = structuredClone(expected)
  actual.accepted.reverse()
  assert.deepEqual(compare(expected, actual).differences, [])
  actual.accepted.find((r) => r.customer_id === "C-006")!.note = "keep spaces"
  assert.deepEqual(
    compare(expected, actual).differences.map((d) => [d.customerId, d.field]),
    [["C-006", "note"]],
  )
})

test("equal row counts cannot hide a duplicate replacing a missing customer", () => {
  const actual = structuredClone(expected)
  actual.accepted[2] = { ...actual.accepted[0]!, sourceRow: 4 }
  const result = compare(expected, actual)
  assert.equal(result.actualAccepted, result.expectedAccepted)
  assert.ok(result.differences.some((d) => d.code === "DUPLICATE_ID"))
  assert.ok(result.differences.some((d) => d.customerId === "C-003"))
})

test("lost leading zeros are explained with the original ID, source row, and field", () => {
  const actual = structuredClone(expected)
  actual.accepted[0]!.customer_id = "17"
  assert.deepEqual(compare(expected, actual).differences, [
    {
      code: "FIELD_CHANGED",
      customerId: "0017",
      sourceRow: 2,
      field: "customer_id",
      expected: "0017",
      actual: "17",
    },
  ])
})

test("a shifted surviving customer cannot be mistaken for a missing customer's ID mutation", () => {
  const wanted = { ...expected, accepted: expected.accepted.slice(0, 2), rejected: [] }
  const actual = { ...wanted, accepted: [{ ...wanted.accepted[1]!, sourceRow: 2 }] }
  assert.deepEqual(compare(wanted, actual).differences, [
    {
      code: "MISSING_RECORD",
      customerId: "0017",
      sourceRow: 2,
      field: "record",
      expected: "present",
      actual: null,
    },
    {
      code: "FIELD_CHANGED",
      customerId: "00042",
      sourceRow: 3,
      field: "sourceRow",
      expected: "3",
      actual: "2",
    },
  ])
})

test("reject policy is checked independently of accepted row count", () => {
  const actual = structuredClone(expected)
  actual.rejected = []
  assert.equal(compare(expected, actual).differences[0]?.code, "REJECTION_CHANGED")
})

test("missing, extra, and multiline changes are visible", () => {
  const actual = structuredClone(expected)
  actual.accepted.splice(0, 1)
  actual.accepted.push({ sourceRow: 9, customer_id: "EXTRA", name: "Unexpected", note: "" })
  actual.accepted.find((r) => r.customer_id === "C-003")!.note = "Line one Line two"
  const differences = compare(expected, actual).differences
  assert.ok(differences.some((d) => d.code === "MISSING_RECORD" && d.customerId === "0017"))
  assert.ok(differences.some((d) => d.code === "UNEXPECTED_RECORD" && d.customerId === "EXTRA"))
  assert.ok(differences.some((d) => d.field === "note" && d.expected === "Line one\nLine two"))
})

test("malformed exports cannot masquerade as completed data", () => {
  for (const value of [
    null,
    {},
    { schemaVersion: 1, accepted: [], rejected: null },
    { ...expected, accepted: [{ ...expected.accepted[0], customer_id: 17 }] },
    { ...expected, accepted: [{ ...expected.accepted[0], note: null }] },
    { ...expected, rejected: [{ ...expected.rejected[0], reason: "anything" }] },
    { ...expected, accepted: [expected.accepted[0], expected.accepted[0]] },
  ]) {
    assert.throws(() => parseExport(value), /INVALID_EXPORT/)
  }
})
