"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canDeleteEmployee, isHrRole } from "@/lib/roles";

async function currentEmployee() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, employee: null };
  const { data: employee } = await supabase
    .from("employees")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle();
  return { supabase, user, employee };
}

/**
 * Error codes returned by deleteEmployeeRecord; the UI turns them into text
 * (deleteEmployeeErrorText). Other strings are raw database messages.
 */
export type DeleteEmployeeError =
  | "delete.notAllowed"
  | "delete.self"
  | "delete.noServiceKey"
  | "delete.hasPayslips"
  | `delete.linked:${string}`;

export async function deleteEmployeeRecord(id: string): Promise<DeleteEmployeeError | string | null> {
  const { supabase, user, employee } = await currentEmployee();
  if (!user || !employee) {
    return "delete.notAllowed";
  }
  if (id === user.id) {
    return "delete.self";
  }
  // RLS only returns colleagues of the same company. Owner and admins
  // delete; never the owner; an admin only by the owner.
  const { data: target } = await supabase
    .from("employees")
    .select("id, role")
    .eq("id", id)
    .maybeSingle();
  if (!target || !canDeleteEmployee({ id: user.id, role: employee.role }, target)) {
    return "delete.notAllowed";
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return "delete.noServiceKey";
  }

  try {
    // Payslips are accounting records and are never deleted with a person.
    const payslips = await admin
      .from("payslips")
      .select("id", { count: "exact", head: true })
      .eq("employee_id", id);
    if (!payslips.error && (payslips.count ?? 0) > 0) return "delete.hasPayslips";

    const { error: managerError } = await admin
      .from("departments")
      .update({ manager_id: null })
      .eq("manager_id", id);
    if (managerError) return managerError.message;

    const { error: approverError } = await admin
      .from("leave_requests")
      .update({ approver_id: null })
      .eq("approver_id", id);
    if (approverError) return approverError.message;

    // Delete the profile first: unlike Auth's generic "Database error deleting
    // user", Postgres names the table that still points at the employee.
    const { error: rowError } = await admin.from("employees").delete().eq("id", id);
    if (rowError) {
      const table =
        rowError.message.match(/on table "([^"]+)"/g)?.pop()?.match(/"([^"]+)"/)?.[1] ??
        rowError.details?.match(/table "([^"]+)"/)?.[1];
      if (rowError.code === "23503" && table) return `delete.linked:${table}`;
      return rowError.message;
    }

    const { error: authError } = await admin.auth.admin.deleteUser(id);
    if (authError && !/not found/i.test(authError.message)) return authError.message;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not delete employee";
  }
}

export async function deleteDepartmentRecord(id: string) {
  const { supabase, user, employee } = await currentEmployee();
  if (!user || !employee || !isHrRole(employee.role)) {
    return "Not allowed";
  }
  // RLS only shows departments of the caller's company.
  const { data: department } = await supabase
    .from("departments")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!department) return "Department not found";

  try {
    const admin = createAdminClient();
    const { error: unlinkError } = await admin
      .from("employees")
      .update({ department_id: null })
      .eq("department_id", id);
    if (unlinkError) return unlinkError.message;

    const { error } = await admin.from("departments").delete().eq("id", id);
    if (error) return error.message;
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Could not delete department";
  }
}

// Requests are deleted with the caller's own client: RLS lets people
// withdraw their own pending request and approvers delete the requests they
// manage (can_manage_employee in 01_foundation.sql).
async function deleteRequestRow(table: "leave_requests" | "authorizations", id: string) {
  const { supabase, user } = await currentEmployee();
  if (!user) return "Not allowed";

  const { data: request, error: loadError } = await supabase
    .from(table)
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (loadError) return loadError.message;
  if (!request) return "Request not found";

  const { data: deleted, error } = await supabase.from(table).delete().eq("id", id).select("id");
  if (error) return error.message;
  if (!deleted?.length) return "Not allowed";
  return null;
}

export async function deleteLeaveRequestRecord(id: string) {
  return deleteRequestRow("leave_requests", id);
}

export async function deleteAuthorizationRecord(id: string) {
  return deleteRequestRow("authorizations", id);
}
