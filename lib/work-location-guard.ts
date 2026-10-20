import {
  DEFAULT_LOCATION_RADIUS_METERS,
  MAX_LOCATION_RADIUS_METERS,
  MIN_LOCATION_RADIUS_METERS,
  isValidCoordinate,
  matchWorkLocation,
  parseFiniteNumber,
  type GeoPoint,
  type WorkLocation,
} from "./geo";

export type PunchCoords = GeoPoint & { accuracyMeters: number };

export type LocationGuardResult =
  | { ok: true; location: WorkLocation | null; coords: PunchCoords | null }
  | { ok: false; code: "LOCATION_REQUIRED" | "OUTSIDE_WORK_LOCATION" | "INVALID_LOCATION" };

export function parsePunchCoords(body: Record<string, unknown>): PunchCoords | null {
  const latitude = parseFiniteNumber(body.latitude);
  const longitude = parseFiniteNumber(body.longitude);
  if (latitude == null || longitude == null) return null;
  const accuracy = parseFiniteNumber(body.accuracyMeters);
  const point = {
    latitude,
    longitude,
    accuracyMeters: accuracy != null && accuracy >= 0 ? accuracy : 0,
  };
  return isValidCoordinate(point) ? point : null;
}

export function parseWorkLocationDraft(body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim();
  const latitude = parseFiniteNumber(body.latitude);
  const longitude = parseFiniteNumber(body.longitude);
  const radius = parseFiniteNumber(body.radiusMeters);
  if (!name || name.length > 80 || latitude == null || longitude == null) return null;
  if (!isValidCoordinate({ latitude, longitude })) return null;
  const radiusMeters = radius == null ? DEFAULT_LOCATION_RADIUS_METERS : Math.round(radius);
  if (
    radiusMeters < MIN_LOCATION_RADIUS_METERS ||
    radiusMeters > MAX_LOCATION_RADIUS_METERS
  ) {
    return null;
  }
  return {
    name,
    latitude,
    longitude,
    radiusMeters,
    isActive: body.isActive !== false,
  };
}

export function guardPunchLocation(
  locations: WorkLocation[],
  coords: PunchCoords | null,
): LocationGuardResult {
  const active = locations.filter((location) => location.isActive);
  if (active.length === 0) return { ok: true, location: null, coords };
  if (!coords) return { ok: false, code: "LOCATION_REQUIRED" };
  const match = matchWorkLocation(coords, active, coords.accuracyMeters);
  if (!match) return { ok: false, code: "OUTSIDE_WORK_LOCATION" };
  return { ok: true, location: match.location, coords };
}
