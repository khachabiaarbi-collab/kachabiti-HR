export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

const EMPLOYEE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEmployeeId(value: string): boolean {
  return EMPLOYEE_ID.test(value);
}

export function extensionFor(type: string): string {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

export function avatarStoragePath(employeeId: string, type: string): string {
  return `${employeeId}/avatar.${extensionFor(type)}`;
}

export function avatarFileIssue(
  file: { type: string; size: number } | null,
): string | null {
  if (!file || file.size === 0) return "Choose a photo to upload";
  if (!AVATAR_TYPES.includes(file.type as (typeof AVATAR_TYPES)[number])) {
    return "Use a JPG, PNG, WEBP, or GIF photo";
  }
  if (file.size > AVATAR_MAX_BYTES) return "Photo must be 5 MB or smaller";
  return null;
}

export function canChangeEmployeePhoto(
  actor: { id: string; role: string; status: string },
  targetEmployeeId: string,
): boolean {
  if (actor.status === "inactive") return false;
  if (actor.id === targetEmployeeId) return true;
  return actor.role === "admin" || actor.role === "manager";
}

export function resolveAvatarEmployeeId(
  requestedId: string,
  actorId: string,
): string | null {
  const target = requestedId.trim() || actorId;
  return isEmployeeId(target) ? target : null;
}
