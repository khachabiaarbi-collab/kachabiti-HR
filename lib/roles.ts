/**
 * Company roles (SaaS step 4), from most to least access. The database
 * enforces the same rules (supabase/saas/01_foundation.sql: is_org_hr,
 * can_manage_employee, employees_guard, transfer_ownership); the app uses
 * these to decide what to show and what server actions accept.
 *
 *   owner    one per company; cannot be demoted, deactivated or deleted
 *   admin    company profile; gives the hr, manager and employee roles
 *   hr       people, balances, leave policy, settings, every approval, payroll
 *   manager  approves for the departments they manage
 *   employee self-service
 */
export const DB_ROLES = ["owner", "admin", "hr", "manager", "employee"] as const;
export type DbRole = (typeof DB_ROLES)[number];

export function normalizeRole(role: string | null | undefined): DbRole {
  const value = (role ?? "").trim().toLowerCase();
  if (value === "administrator") return "admin";
  return (DB_ROLES as readonly string[]).includes(value) ? (value as DbRole) : "employee";
}

/** Opens the admin workspace (/admin). */
export function isWorkspaceRole(role: string | null | undefined): boolean {
  return normalizeRole(role) !== "employee";
}

/** Owner, admin or hr: people, settings, payroll, every approval. */
export function isHrRole(role: string | null | undefined): boolean {
  const value = normalizeRole(role);
  return value === "owner" || value === "admin" || value === "hr";
}

/** Owner or admin: company profile, roles, sign-in accounts. */
export function isAdminRole(role: string | null | undefined): boolean {
  const value = normalizeRole(role);
  return value === "owner" || value === "admin";
}

/** Roles this person may give (the owner role only moves by transfer). */
export function assignableRoles(actorRole: string | null | undefined): DbRole[] {
  const actor = normalizeRole(actorRole);
  if (actor === "owner") return ["admin", "hr", "manager", "employee"];
  if (actor === "admin") return ["hr", "manager", "employee"];
  return [];
}

/** Whether actor may change target's role at all (not their own). */
export function canChangeRoleOf(
  actor: { id: string; role: string | null | undefined },
  target: { id: string; role: string | null | undefined },
): boolean {
  if (actor.id === target.id) return false;
  const targetRole = normalizeRole(target.role);
  if (targetRole === "owner") return false;
  return assignableRoles(actor.role).includes(targetRole);
}

/** Sign-in email and password: owner and admins; admins' own only by the owner. */
export function canManageAccountOf(
  actor: { id: string; role: string | null | undefined },
  target: { id: string; role: string | null | undefined },
): boolean {
  if (!isAdminRole(actor.role)) return false;
  if (actor.id === target.id) return true;
  const targetRole = normalizeRole(target.role);
  if (targetRole === "owner") return false;
  return targetRole !== "admin" || normalizeRole(actor.role) === "owner";
}

/** Deleting a person: owner and admins; never the owner; an admin only by the owner. */
export function canDeleteEmployee(
  actor: { id: string; role: string | null | undefined },
  target: { id: string; role: string | null | undefined },
): boolean {
  if (actor.id === target.id || !isAdminRole(actor.role)) return false;
  const targetRole = normalizeRole(target.role);
  if (targetRole === "owner") return false;
  return targetRole !== "admin" || normalizeRole(actor.role) === "owner";
}
