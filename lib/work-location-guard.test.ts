import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guardPunchLocation,
  parsePunchCoords,
  parseWorkLocationDraft,
} from "./work-location-guard";
import type { WorkLocation } from "./geo";

const office: WorkLocation = {
  id: "loc-1",
  name: "HQ",
  latitude: 36.8065,
  longitude: 10.1815,
  radiusMeters: 150,
  isActive: true,
};

test("parsePunchCoords: reads a valid body and rejects junk", () => {
  assert.deepEqual(
    parsePunchCoords({ latitude: 36.8, longitude: 10.18, accuracyMeters: 12 }),
    { latitude: 36.8, longitude: 10.18, accuracyMeters: 12 },
  );
  assert.equal(parsePunchCoords({ latitude: 36.8 }), null);
  assert.equal(parsePunchCoords({ latitude: 99, longitude: 10 }), null);
});

test("guardPunchLocation: no site configured lets any punch through", () => {
  const result = guardPunchLocation([], null);
  assert.equal(result.ok, true);
});

test("guardPunchLocation: a configured site requires coordinates", () => {
  const result = guardPunchLocation([office], null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "LOCATION_REQUIRED");
});

test("parseWorkLocationDraft: happy path and missing name", () => {
  const draft = parseWorkLocationDraft({
    name: "  HQ  ",
    latitude: 36.8,
    longitude: 10.18,
  });
  assert.equal(draft?.name, "HQ");
  assert.equal(draft?.radiusMeters, 150);
  assert.equal(parseWorkLocationDraft({ name: "", latitude: 36.8, longitude: 10.18 }), null);
});

test("guardPunchLocation: inside HQ is accepted, far away is refused", () => {
  const inside = guardPunchLocation([office], {
    latitude: 36.8065,
    longitude: 10.1815,
    accuracyMeters: 10,
  });
  assert.equal(inside.ok, true);
  if (inside.ok) assert.equal(inside.location?.id, "loc-1");

  const outside = guardPunchLocation([office], {
    latitude: 36.9,
    longitude: 10.3,
    accuracyMeters: 10,
  });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.equal(outside.code, "OUTSIDE_WORK_LOCATION");
});
