"use server";

import { createClient } from "@/lib/supabase/server";
import {
  customLeaveCode,
  isBuiltInLeaveType,
  leaveTypeIssue,
} from "@/lib/leave-policy-file";
import { isHrRole } from "@/lib/roles";

// Raised by leave_types_policy_guard (supabase/saas/03_company_settings.sql).
function databaseMessage(message: string) {
  if (message.includes("LEAVE_TYPE_IN_USE")) {
    return "This leave type is used by leave requests. Make it inactive instead.";
  }
  if (message.includes("LEAVE_TYPE_BUILT_IN")) {
    return "Built-in leave types cannot be deleted.";
  }
  return message;
}

/**
 * The signed-in active owner, admin or hr. Writes go through their own
 * client, so RLS keeps them to their company's catalog.
 */
async function catalogAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in" } as const;
  const { data: me } = await supabase
    .from("employees")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();
  if (!me || !isHrRole(me.role) || me.status === "inactive") {
    return { error: "Only the owner, administrators and HR can change the leave policy" } as const;
  }
  return { supabase } as const;
}

export async function createLeaveType(input: { name: string; defaultDays: string }) {
  const issue = leaveTypeIssue(input, { builtIn: false });
  if (issue) return issue;
  const access = await catalogAdmin();
  if ("error" in access) return access.error;
  const { supabase } = access;
  const defaultDays = Number(input.defaultDays);

  const { data: created, error } = await supabase
    .from("leave_types")
    .insert({
      name: input.name.trim(),
      default_days: defaultDays,
      code: customLeaveCode(crypto.randomUUID()),
    })
    .select("id")
    .single();
  if (error) return databaseMessage(error.message);

  // Everyone in the company starts with the default allowance.
  const { data: people, error: peopleError } = await supabase.from("employees").select("id");
  if (peopleError) return peopleError.message;
  if (people?.length) {
    const { error: balanceError } = await supabase.from("leave_balances").upsert(
      people.map((person) => ({
        employee_id: person.id,
        leave_type_id: created.id,
        days_remaining: defaultDays,
      })),
      { onConflict: "employee_id,leave_type_id" },
    );
    if (balanceError) return balanceError.message;
  }
  return null;
}

export async function updateLeaveType(input: {
  id: string;
  name: string;
  defaultDays: string;
  active: boolean;
}) {
  const access = await catalogAdmin();
  if ("error" in access) return access.error;
  const { supabase } = access;

  const { data: current } = await supabase
    .from("leave_types")
    .select("code")
    .eq("id", input.id)
    .maybeSingle();
  if (!current) return "Leave type not found";
  const builtIn = isBuiltInLeaveType(current.code);
  const issue = leaveTypeIssue(input, { builtIn });
  if (issue) return issue;

  // Existing balances keep their days; the new default applies to new hires.
  const { error } = await supabase
    .from("leave_types")
    .update({
      name: input.name.trim(),
      default_days: Number(input.defaultDays),
      active: builtIn ? true : input.active,
    })
    .eq("id", input.id);
  return error ? databaseMessage(error.message) : null;
}

export async function deleteLeaveType(id: string) {
  const access = await catalogAdmin();
  if ("error" in access) return access.error;
  const { data, error } = await access.supabase
    .from("leave_types")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return databaseMessage(error.message);
  if (!data?.length) return "Leave type not found";
  return null;
}
