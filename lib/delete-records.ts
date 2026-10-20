"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sameCompanyEmployee } from "@/lib/org-access";

function isStaff(role: string | null | undefined) {
  return role === "admin" || role === "manager";
}

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
  if (!user || !employee || !isStaff(employee.role)) {
    return "delete.notAllowed";
  }
  if (id === user.id) {
    return "delete.self";
  }
  if (!(await sameCompanyEmployee(supabase, id))) {
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
  if (!user || !employee || !isStaff(employee.role)) {
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

export async function deleteLeaveRequestRecord(id: string) {
  const { supabase, user, employee } = await currentEmployee();
  if (!user || !employee) return "Not allowed";

  try {
    const admin = createAdminClient();
    // Read with the caller's client: RLS limits it to their company.
    const { data: request, error: loadError } = await supabase
      .from("leave_requests")
      .select("id, employee_id, status")
      .eq("id", id)
      .maybeSingle();
    if (loadError) return loadError.message;
    if (!request) return "Request not found";

    const ownPending =
      request.employee_id === user.id && request.status === "pending";
    if (!isStaff(employee.role) && !ownPending) {
      return "Not allowed";
    }

    const { error } = await admin.from("leave_requests").delete().eq("id", id);
    if (error) return error.message;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not delete request";
  }
}

export async function deleteAuthorizationRecord(id: string) {
  const { supabase, user, employee } = await currentEmployee();
  if (!user || !employee) return "Not allowed";

  try {
    const admin = createAdminClient();
    const { data: request, error: loadError } = await admin
      .from("authorizations")
      .select("id, employee_id, status")
      .eq("id", id)
      .maybeSingle();
    if (loadError) return loadError.message;
    if (!request) return "Request not found";

    const ownPending =
      request.employee_id === user.id && request.status === "pending";
    if (!isStaff(employee.role) && !ownPending) {
      return "Not allowed";
    }
    if (!(await sameCompanyEmployee(supabase, request.employee_id))) {
      return "Request not found";
    }

    const { error } = await admin.from("authorizations").delete().eq("id", id);
    if (error) return error.message;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not delete request";
  }
}
