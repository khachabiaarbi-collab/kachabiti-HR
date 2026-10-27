"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sameCompanyEmployee } from "@/lib/org-access";
import { canManageAccountOf, isAdminRole, isHrRole } from "@/lib/roles";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Admin only: change an employee's sign-in email and/or password (Supabase
 * Auth). Returns an error message, or null when it worked.
 */
export async function updateEmployeeAccount(input: {
  employeeId: string;
  email?: string;
  password?: string;
}): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "You must be signed in.";

  const { data: me } = await supabase
    .from("employees")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();
  if (!me || !isAdminRole(me.role) || me.status === "inactive") {
    return "Only the owner and administrators can change an employee's account.";
  }
  // RLS only returns colleagues of the same company.
  const { data: target } = await supabase
    .from("employees")
    .select("id, role")
    .eq("id", input.employeeId)
    .maybeSingle();
  if (!target) return "Employee not found.";
  if (!canManageAccountOf({ id: user.id, role: me.role }, target)) {
    return "Only the owner can change an administrator's or the owner's account.";
  }

  const email = input.email?.trim().toLowerCase();
  const password = input.password ?? "";
  if (!email && !password) return null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return "Account changes need SUPABASE_SERVICE_ROLE_KEY on the server.";
  }

  const { error } = await admin.auth.admin.updateUserById(input.employeeId, {
    ...(email ? { email, email_confirm: true } : {}),
    ...(password ? { password } : {}),
  });
  return error?.message ?? null;
}

/**
 * Admin or manager: save an employee's opening leave balances. Written with
 * the service role because the upsert also inserts the leave types the
 * employee has no row for yet, which the browser's RLS policy refuses.
 * Returns an error message, or null when it worked.
 */
export async function saveEmployeeSolde(input: {
  employeeId: string;
  rows: { leaveTypeId: string; daysRemaining: number }[];
}): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "You must be signed in.";

  const { data: me } = await supabase
    .from("employees")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();
  if (!me || !isHrRole(me.role) || me.status === "inactive") {
    return "Only the owner, administrators and HR can change leave balances.";
  }
  if (!(await sameCompanyEmployee(supabase, input.employeeId))) {
    return "Employee not found.";
  }

  const rows = input.rows.filter((row) => row.leaveTypeId);
  if (!rows.length) return null;
  if (rows.some((row) => !Number.isFinite(row.daysRemaining))) {
    return "Enter a valid number of days.";
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return "Saving balances needs SUPABASE_SERVICE_ROLE_KEY on the server.";
  }

  const { error } = await admin.from("leave_balances").upsert(
    rows.map((row) => ({
      employee_id: input.employeeId,
      leave_type_id: row.leaveTypeId,
      days_remaining: row.daysRemaining,
    })),
    { onConflict: "employee_id,leave_type_id" },
  );
  return error?.message ?? null;
}
