"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const BUCKET = "leave-attachments";

function isStaff(role: string | null | undefined) {
  return role === "admin" || role === "manager";
}

export async function uploadLeaveAttachment(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "You must be signed in", path: null, name: null };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: null, path: null, name: null };
  }
  if (file.size > 10 * 1024 * 1024) {
    return {
      error: "Attachment must be 10 MB or smaller",
      path: null,
      name: null,
    };
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const path = `${user.id}/${crypto.randomUUID()}-${safeName}`;

  try {
    const admin = createAdminClient();
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (error) return { error: error.message, path: null, name: null };
    return { error: null, path, name: file.name };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Could not upload attachment",
      path: null,
      name: null,
    };
  }
}

export async function getLeaveAttachmentUrl(path: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: employee } = await supabase
    .from("employees")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle();
  if (!employee) return null;

  const ownerId = path.split("/")[0];
  if (!isStaff(employee.role) && ownerId !== user.id) return null;

  try {
    const admin = createAdminClient();
    const { data } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(path, 3600);
    return data?.signedUrl ?? null;
  } catch {
    return null;
  }
}
