"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

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
  if (!me || me.role !== "admin" || me.status === "inactive") {
    return "Only administrators can change an employee's account.";
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
