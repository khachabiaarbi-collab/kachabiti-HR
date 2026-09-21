"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { openingDaysForLeaveType, parseMonthlyLeaveDays, toDbRole } from "@/lib/map-rows";

function isStaff(role: string | null | undefined) {
  return role === "admin" || role === "manager";
}

function appOrigin(headerList: Headers) {
  const origin = headerList.get("origin");
  if (origin) return origin;
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  if (!host) return "http://localhost:3000";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function inviteEmployee(input: {
  name: string;
  email: string;
  jobTitle: string;
  departmentId: string;
  startDate: string;
  monthlyLeaveDays: string;
  role: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "You must be signed in";

  const { data: employee } = await supabase
    .from("employees")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!employee || !isStaff(employee.role)) {
    return "Not allowed";
  }

  const name = input.name.trim();
  const email = input.email.trim();
  if (!name || !email) return "Name and work email are required";

  const origin = appOrigin(await headers());
  const jobTitle = input.jobTitle.trim() || null;
  const departmentId = input.departmentId.trim() || null;
  const startDate = input.startDate.trim() || null;
  const monthlyLeaveDays = parseMonthlyLeaveDays(input.monthlyLeaveDays);
  const role = toDbRole(input.role);

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: name },
      redirectTo: `${origin}/reset-password?welcome=1`,
    });
    if (error) return error.message;
    if (!data.user) return "Could not invite employee";
    const userId = data.user.id;
    const userEmail = data.user.email ?? email;

    const employeeRow = {
      id: userId,
      full_name: name,
      email: userEmail,
      job_title: jobTitle,
      department_id: departmentId,
      start_date: startDate,
      monthly_leave_days: monthlyLeaveDays,
      role,
      status: "active",
    };
    let { error: upsertError } = await admin
      .from("employees")
      .upsert(employeeRow, { onConflict: "id" });
    if (upsertError?.message?.includes("monthly_leave_days")) {
      const { monthly_leave_days: _ignored, ...withoutMonthly } = employeeRow;
      upsertError = (
        await admin.from("employees").upsert(withoutMonthly, { onConflict: "id" })
      ).error;
    }
    if (upsertError) return upsertError.message;

    type LeaveTypeSeed = {
      id: string;
      name: string;
      default_days: number;
      code?: string | null;
    };
    let leaveTypes: LeaveTypeSeed[] | null = null;
    let { data: typedLeaveTypes, error: typesError } = await admin
      .from("leave_types")
      .select("id, name, default_days, code");
    leaveTypes = typedLeaveTypes;
    if (typesError) {
      const retry = await admin
        .from("leave_types")
        .select("id, name, default_days");
      leaveTypes = retry.data;
      typesError = retry.error;
    }
    if (typesError) return typesError.message;
    if (leaveTypes?.length) {
      const { error: soldeError } = await admin.from("leave_balances").upsert(
        leaveTypes.map((type) => ({
          employee_id: userId,
          leave_type_id: type.id,
          days_remaining: openingDaysForLeaveType(
            {
              name: type.name,
              defaultDays: Number(type.default_days) || 0,
              code: type.code ?? null,
            },
            startDate,
            monthlyLeaveDays,
          ),
        })),
        { onConflict: "employee_id,leave_type_id" },
      );
      if (soldeError) return soldeError.message;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not invite employee";
  }
}
