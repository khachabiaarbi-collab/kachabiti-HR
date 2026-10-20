export type GeoPoint = {
  latitude: number;
  longitude: number;
};

export type WorkLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
};

export const DEFAULT_LOCATION_RADIUS_METERS = 150;
export const MIN_LOCATION_RADIUS_METERS = 30;
export const MAX_LOCATION_RADIUS_METERS = 2000;
const EARTH_METERS = 6_371_000;
const MAX_ACCURACY_BONUS_METERS = 50;

export function isValidLatitude(value: number) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isValidCoordinate(point: GeoPoint) {
  return isValidLatitude(point.latitude) && isValidLongitude(point.longitude);
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in meters (Haversine). */
export function haversineMeters(from: GeoPoint, to: GeoPoint) {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const dLat = toRadians(to.latitude - from.latitude);
  const dLng = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function allowedDistanceMeters(radiusMeters: number, accuracyMeters = 0) {
  const radius = Math.max(0, radiusMeters);
  const bonus = Math.min(Math.max(0, accuracyMeters), MAX_ACCURACY_BONUS_METERS);
  return radius + bonus;
}

export function isInsideLocation(
  point: GeoPoint,
  location: Pick<WorkLocation, "latitude" | "longitude" | "radiusMeters">,
  accuracyMeters = 0,
) {
  const distance = haversineMeters(point, location);
  return distance <= allowedDistanceMeters(location.radiusMeters, accuracyMeters);
}

export function matchWorkLocation(
  point: GeoPoint,
  locations: WorkLocation[],
  accuracyMeters = 0,
): { location: WorkLocation; distanceMeters: number } | null {
  if (!isValidCoordinate(point)) return null;
  let best: { location: WorkLocation; distanceMeters: number } | null = null;
  for (const location of locations.filter((item) => item.isActive)) {
    const distanceMeters = haversineMeters(point, location);
    if (distanceMeters > allowedDistanceMeters(location.radiusMeters, accuracyMeters)) {
      continue;
    }
    if (!best || distanceMeters < best.distanceMeters) {
      best = { location, distanceMeters };
    }
  }
  return best;
}

export function parseFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pointFromPair(latitude: string, longitude: string): GeoPoint | null {
  const point = { latitude: Number(latitude), longitude: Number(longitude) };
  return isValidCoordinate(point) ? point : null;
}

export function googleMapsSearchUrl(query: string) {
  const text = query.trim();
  return text
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`
    : "https://www.google.com/maps";
}

export function googleMapsPinUrl(point: GeoPoint) {
  return `https://www.google.com/maps?q=${point.latitude},${point.longitude}`;
}

/** Reads coordinates from a Google Maps link, or from "lat, lng". */
export function coordsFromMapsText(value: string): GeoPoint | null {
  const text = value.trim();
  if (!text) return null;
  const pin = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (pin) return pointFromPair(pin[1], pin[2]);
  const at = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) return pointFromPair(at[1], at[2]);
  const query = text.match(
    /[?&](?:q|query|ll|center)=(-?\d+(?:\.\d+)?)(?:%2C|,)(-?\d+(?:\.\d+)?)/i,
  );
  if (query) return pointFromPair(query[1], query[2]);
  const pair = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (pair) return pointFromPair(pair[1], pair[2]);
  return null;
}
