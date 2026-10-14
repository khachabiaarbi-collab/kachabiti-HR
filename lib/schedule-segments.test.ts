import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cloneSegment,
  insertAfter,
  moveSegment,
  parseCopiedSegment,
  withSegmentPositions,
} from "./schedule-segments";

test("moveSegment: moves an item down the list", () => {
  assert.deepEqual(moveSegment(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
});

test("moveSegment: moves an item up the list", () => {
  assert.deepEqual(moveSegment(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
});

test("moveSegment: same index or out of range is a no-op", () => {
  const list = ["a", "b"];
  assert.equal(moveSegment(list, 1, 1), list);
  assert.equal(moveSegment(list, -1, 0), list);
  assert.equal(moveSegment(list, 0, 9), list);
});

test("withSegmentPositions: rewrites position from 1", () => {
  assert.deepEqual(
    withSegmentPositions([
      { id: "b", position: 9 },
      { id: "a", position: 1 },
    ]),
    [
      { id: "b", position: 1 },
      { id: "a", position: 2 },
    ],
  );
});

test("cloneSegment: drops extra fields and trims clock seconds", () => {
  assert.deepEqual(
    cloneSegment({ isoWeekday: 2, kind: "break", startTime: "12:00:00", endTime: "13:00:00" }),
    { isoWeekday: 2, kind: "break", startTime: "12:00", endTime: "13:00" },
  );
});

test("parseCopiedSegment: accepts a valid row and rejects junk", () => {
  const row = { isoWeekday: 1, kind: "work", startTime: "08:00", endTime: "13:00" };
  assert.deepEqual(parseCopiedSegment(JSON.stringify(row)), row);
  assert.equal(parseCopiedSegment("not-json"), null);
  assert.equal(parseCopiedSegment(JSON.stringify({ ...row, kind: "pause" })), null);
  assert.equal(parseCopiedSegment(JSON.stringify({ ...row, startTime: "17:00", endTime: "08:00" })), null);
});

test("insertAfter: inserts just after the index", () => {
  assert.deepEqual(insertAfter(["a", "c"], 0, "b"), ["a", "b", "c"]);
  assert.deepEqual(insertAfter(["a"], 9, "b"), ["a", "b"]);
});
