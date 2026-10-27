"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  companyLogoPath,
  companyProfileIssue,
  logoFileIssue,
  normalizeBrandColor,
  type CompanyProfileInput,
} from "@/lib/company-profile-file";
import { isAdminRole } from "@/lib/roles";

const BUCKET = "company-logos";

/** The signed-in active owner's or admin's company; others get an error. */
async function companyAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in" } as const;

  const { data: me } = await supabase
    .from("employees")
    .select("role, status, organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!me || !isAdminRole(me.role) || me.status === "inactive" || !me.organization_id) {
    return { error: "Only the owner and administrators can change the company profile" } as const;
  }
  return { supabase, organizationId: String(me.organization_id) } as const;
}

export async function saveCompanyProfile(input: CompanyProfileInput) {
  const issue = companyProfileIssue(input);
  if (issue) return issue;
  const access = await companyAdmin();
  if ("error" in access) return access.error;

  // RLS and the organizations_guard trigger keep the admin to their own
  // company and away from its status.
  const { error } = await access.supabase
    .from("organizations")
    .update({
      name: input.name.trim(),
      brand_color: normalizeBrandColor(input.brandColor),
      monthly_leave_days: Number(String(input.monthlyLeaveDays).trim()),
    })
    .eq("id", access.organizationId);
  return error ? error.message : null;
}

async function removeLogoFiles(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
) {
  const { data } = await admin.storage.from(BUCKET).list(organizationId);
  const paths = (data ?? []).map((file) => `${organizationId}/${file.name}`);
  if (paths.length) await admin.storage.from(BUCKET).remove(paths);
}

export async function uploadCompanyLogo(formData: FormData) {
  const file = formData.get("file");
  const fileIssue = logoFileIssue(
    file instanceof File ? { type: file.type, size: file.size } : null,
  );
  if (fileIssue || !(file instanceof File)) {
    return { error: fileIssue ?? "Choose a logo to upload", url: null };
  }
  const access = await companyAdmin();
  if ("error" in access) return { error: access.error, url: null };

  try {
    const admin = createAdminClient();
    // One logo per company: drop the old one, whatever its extension.
    await removeLogoFiles(admin, access.organizationId);
    const path = companyLogoPath(access.organizationId, file.type);
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: true,
      });
    if (uploadError) {
      if (/bucket/i.test(uploadError.message)) {
        return {
          error: "The logo storage is missing. Run supabase/saas/03_company_settings.sql.",
          url: null,
        };
      }
      return { error: uploadError.message, url: null };
    }

    const { data } = admin.storage.from(BUCKET).getPublicUrl(path);
    const url = `${data.publicUrl}?v=${Date.now()}`;
    const { error: updateError } = await access.supabase
      .from("organizations")
      .update({ logo_url: url })
      .eq("id", access.organizationId);
    if (updateError) return { error: updateError.message, url: null };
    return { error: null, url };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not upload logo",
      url: null,
    };
  }
}

export async function removeCompanyLogo() {
  const access = await companyAdmin();
  if ("error" in access) return access.error;

  const { error } = await access.supabase
    .from("organizations")
    .update({ logo_url: null })
    .eq("id", access.organizationId);
  if (error) return error.message;
  try {
    await removeLogoFiles(createAdminClient(), access.organizationId);
  } catch {
    // The logo is already unlinked; a leftover file is harmless.
  }
  return null;
}
