import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { AttendanceAuth } from "@/lib/attendance-server";
import type { WorkLocation } from "@/lib/geo";
import type { PunchCoords } from "@/lib/work-location-guard";
import { parseWorkLocationDraft } from "@/lib/work-location-guard";

export { parseWorkLocationDraft };

type LocationRow = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  is_active: boolean;
};

function mapLocation(row: LocationRow): WorkLocation {
  return {
    id: row.id,
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusMeters: Number(row.radius_meters),
    isActive: Boolean(row.is_active),
  };
}

export async function listWorkLocations(auth: AttendanceAuth): Promise<WorkLocation[]> {
  const { data, error } = await auth.supabase
    .from("work_locations")
    .select("id, name, latitude, longitude, radius_meters, is_active")
    .order("name");
  if (error) {
    if (/work_locations|schema cache/i.test(error.message)) return [];
    throw error;
  }
  return ((data ?? []) as LocationRow[]).map(mapLocation);
}

export async function saveWorkLocation(
  auth: AttendanceAuth,
  draft: NonNullable<ReturnType<typeof parseWorkLocationDraft>> & { id?: string },
) {
  const row = {
    name: draft.name,
    latitude: draft.latitude,
    longitude: draft.longitude,
    radius_meters: draft.radiusMeters,
    is_active: draft.isActive,
  };
  const query = draft.id
    ? auth.supabase.from("work_locations").update(row).eq("id", draft.id).select("id").maybeSingle()
    : auth.supabase.from("work_locations").insert(row).select("id").maybeSingle();
  const { error } = await query;
  if (error) throw error;
}

export async function deleteWorkLocation(auth: AttendanceAuth, id: string) {
  const { error } = await auth.supabase.from("work_locations").delete().eq("id", id);
  if (error) throw error;
}

export async function recordPunchLocation(
  punchId: string,
  coords: PunchCoords,
  locationId: string | null,
) {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("attendance_punches")
      .update({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy_meters: coords.accuracyMeters,
        work_location_id: locationId,
      })
      .eq("id", punchId);
    if (error && !/column|schema cache|work_location/i.test(error.message)) {
      throw error;
    }
  } catch {
    // Location columns may be missing until work_locations.sql is run.
  }
}
