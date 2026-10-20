import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * True when the signed-in user may act on this employee's company data:
 * row-level security only returns employees of the user's own company.
 * Server actions call this with the user's client before writing with the
 * service role, which ignores RLS.
 */
export async function sameCompanyEmployee(
  supabase: SupabaseClient,
  employeeId: string | null | undefined,
) {
  if (!employeeId) return false;
  const { data } = await supabase
    .from("employees")
    .select("id")
    .eq("id", employeeId)
    .maybeSingle();
  return Boolean(data);
}
