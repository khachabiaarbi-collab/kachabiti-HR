import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedDistanceMeters,
  haversineMeters,
  isInsideLocation,
  isValidCoordinate,
  matchWorkLocation,
  coordsFromMapsText,
  googleMapsPinUrl,
  googleMapsSearchUrl,
  parseFiniteNumber,
  type WorkLocation,
} from "./geo";

const office: WorkLocation = {
  id: "loc-1",
  name: "HQ",
  latitude: 36.8065,
  longitude: 10.1815,
  radiusMeters: 150,
  isActive: true,
};

test("haversineMeters: same point is 0, nearby point is hundreds of meters", () => {
  assert.equal(haversineMeters(office, office), 0);
  const nearby = haversineMeters(office, { latitude: 36.8074, longitude: 10.1815 });
  assert.ok(nearby > 80 && nearby < 120);
});

test("isValidCoordinate: rejects out-of-range values", () => {
  assert.equal(isValidCoordinate({ latitude: 36, longitude: 10 }), true);
  assert.equal(isValidCoordinate({ latitude: 91, longitude: 10 }), false);
  assert.equal(isValidCoordinate({ latitude: 36, longitude: 190 }), false);
});

test("isInsideLocation: inside the radius, outside the radius", () => {
  assert.equal(isInsideLocation({ latitude: 36.8065, longitude: 10.1815 }, office), true);
  assert.equal(isInsideLocation({ latitude: 36.81, longitude: 10.19 }, office), false);
});

test("allowedDistanceMeters: GPS accuracy adds at most 50 m", () => {
  assert.equal(allowedDistanceMeters(150, 0), 150);
  assert.equal(allowedDistanceMeters(150, 20), 170);
  assert.equal(allowedDistanceMeters(150, 200), 200);
});

test("matchWorkLocation: nearest active site, or none", () => {
  const second: WorkLocation = {
    ...office,
    id: "loc-2",
    name: "Annex",
    latitude: 36.82,
    longitude: 10.18,
    isActive: false,
  };
  const hit = matchWorkLocation({ latitude: 36.8065, longitude: 10.1815 }, [office, second]);
  assert.equal(hit?.location.id, "loc-1");
  assert.equal(matchWorkLocation({ latitude: 35, longitude: 9 }, [office]), null);
});

test("coordsFromMapsText: Google Maps pin, @ camera, query, and a plain pair", () => {
  assert.deepEqual(
    coordsFromMapsText(
      "https://www.google.com/maps/place/Office/@36.8,10.2,17z/data=!3d36.8065!4d10.1815",
    ),
    { latitude: 36.8065, longitude: 10.1815 },
  );
  assert.deepEqual(coordsFromMapsText("https://www.google.com/maps/@36.8065,10.1815,17z"), {
    latitude: 36.8065,
    longitude: 10.1815,
  });
  assert.deepEqual(coordsFromMapsText("https://maps.google.com/?q=36.8065,10.1815"), {
    latitude: 36.8065,
    longitude: 10.1815,
  });
  assert.deepEqual(coordsFromMapsText("36.8065, 10.1815"), {
    latitude: 36.8065,
    longitude: 10.1815,
  });
  assert.equal(coordsFromMapsText("https://www.google.com/maps"), null);
});

test("googleMapsSearchUrl and googleMapsPinUrl", () => {
  assert.equal(
    googleMapsSearchUrl("Kachabiti Tunis"),
    "https://www.google.com/maps/search/?api=1&query=Kachabiti%20Tunis",
  );
  assert.equal(googleMapsPinUrl(office), "https://www.google.com/maps?q=36.8065,10.1815");
});

test("parseFiniteNumber: number, numeric string, and junk", () => {
  assert.equal(parseFiniteNumber(12.5), 12.5);
  assert.equal(parseFiniteNumber("12.5"), 12.5);
  assert.equal(parseFiniteNumber("nope"), null);
});
