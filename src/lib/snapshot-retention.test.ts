import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSnapshotRetentionDays } from "./snapshot-retention";

// Retention is destructive, so anything other than a clean positive whole number
// of days must mean "keep everything" (the pre-retention behavior).

test("positive whole days are accepted", () => {
  assert.equal(parseSnapshotRetentionDays("30"), 30);
  assert.equal(parseSnapshotRetentionDays(" 7 "), 7);
  assert.equal(parseSnapshotRetentionDays("1"), 1);
});

test("blank or missing keeps all history", () => {
  assert.equal(parseSnapshotRetentionDays(undefined), null);
  assert.equal(parseSnapshotRetentionDays(null), null);
  assert.equal(parseSnapshotRetentionDays(""), null);
  assert.equal(parseSnapshotRetentionDays("   "), null);
});

test("zero, negative, fractional, and non-numeric values keep all history", () => {
  for (const raw of ["0", "-5", "1.5", "abc", "30d", "Infinity", "NaN"]) {
    assert.equal(parseSnapshotRetentionDays(raw), null, raw);
  }
});
