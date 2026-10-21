/**
 * Leave catalog rules for Settings → Leave Policy. The built-in codes drive
 * vacation earning and payroll (lib/map-rows.ts classifies types by code,
 * else by name); supabase/saas/03_company_settings.sql enforces the same.
 */
export const BUILT_IN_LEAVE_CODES = ["VACATION", "ANNUAL", "SICK", "PARENTAL", "UNPAID"] as const;

export const MAX_LEAVE_TYPE_DAYS = 365;

export function isBuiltInLeaveType(code: string | null | undefined): boolean {
  return (BUILT_IN_LEAVE_CODES as readonly string[]).includes((code ?? "").trim().toUpperCase());
}

// Names the app reads as annual, sick, parental or unpaid leave (map-rows
// classifiers and leaveTypeLabel in lib/i18n.tsx).
const RESERVED_NAMES =
  /annual|vacation|annuel|vacances|سنوي|sick|maladie|مرض|parental|paternel|paternity|maternity|maternit|paternit|أبوة|أمومة|unpaid|sans solde|بدون أجر|غير مدفوع/i;

/** A new or renamed custom type must not read as a built-in one. */
export function isReservedLeaveTypeName(name: string): boolean {
  return RESERVED_NAMES.test(name);
}

/** Unique per company; never one of the built-in codes. */
export function customLeaveCode(random: string): string {
  return `CUSTOM_${random.replace(/[^0-9a-z]/gi, "").slice(0, 8).toUpperCase()}`;
}

export function leaveTypeIssue(
  input: { name: string; defaultDays: string | number },
  options: { builtIn: boolean },
): string | null {
  const name = input.name.trim();
  if (!name) return "Leave type name is required";
  if (name.length > 80) return "Leave type name must be 80 characters or fewer";
  if (!options.builtIn && isReservedLeaveTypeName(name)) {
    return "This name is kept for the built-in annual, sick, parental or unpaid leave";
  }
  const days = Number(String(input.defaultDays).trim());
  if (!Number.isInteger(days) || days < 0 || days > MAX_LEAVE_TYPE_DAYS) {
    return `Enter whole default days from 0 to ${MAX_LEAVE_TYPE_DAYS}`;
  }
  return null;
}
