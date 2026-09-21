"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function isStaff(role: string | null | undefined) {
  return role === "admin" || role === "manager";
}

async function currentEmployee() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, employee: null };
  const { data: employee } = await supabase
    .from("employees")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle();
  return { user, employee };
}

export async function deleteEmployeeRecord(id: string) {
  const { user, employee } = await currentEmployee();
  if (!user || !employee || !isStaff(employee.role)) {
    return "Not allowed";
  }
  if (id === user.id) {
    return "You cannot delete your own account";
  }

  try {
    const admin = createAdminClient();
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

    const { error: authError } = await admin.auth.admin.deleteUser(id);
    if (authError) return authError.message;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not delete employee";
  }
}

export async function deleteDepartmentRecord(id: string) {
  const { user, employee } = await currentEmployee();
  if (!user || !employee || !isStaff(employee.role)) {
    return "Not allowed";
  }

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
  const { user, employee } = await currentEmployee();
  if (!user || !employee) return "Not allowed";

  try {
    const admin = createAdminClient();
    const { data: request, error: loadError } = await admin
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
  const { user, employee } = await currentEmployee();
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

    const { error } = await admin.from("authorizations").delete().eq("id", id);
    if (error) return error.message;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not delete request";
  }
}
