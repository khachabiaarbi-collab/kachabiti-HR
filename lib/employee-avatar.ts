"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sameCompanyEmployee } from "@/lib/org-access";
import {
  AVATAR_MAX_BYTES,
  AVATAR_TYPES,
  avatarFileIssue,
  avatarStoragePath,
  canChangeEmployeePhoto,
  resolveAvatarEmployeeId,
} from "@/lib/employee-avatar-file";

const BUCKET = "avatars";

async function ensureAvatarsBucket(
  admin: ReturnType<typeof createAdminClient>,
) {
  const { data: buckets, error: listError } = await admin.storage.listBuckets();
  if (listError) throw listError;
  const existing = buckets?.find((bucket) => bucket.id === BUCKET);
  if (!existing) {
    const { error } = await admin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: AVATAR_MAX_BYTES,
      allowedMimeTypes: [...AVATAR_TYPES],
    });
    if (error && !/exist/i.test(error.message)) throw error;
    return;
  }
  if (!existing.public) {
    const { error } = await admin.storage.updateBucket(BUCKET, {
      public: true,
      fileSizeLimit: AVATAR_MAX_BYTES,
      allowedMimeTypes: [...AVATAR_TYPES],
    });
    if (error) throw error;
  }
}

export async function uploadEmployeeAvatar(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "You must be signed in", url: null };
  }

  const file = formData.get("file");
  const fileIssue = avatarFileIssue(
    file instanceof File ? { type: file.type, size: file.size } : null,
  );
  if (fileIssue || !(file instanceof File)) {
    return { error: fileIssue ?? "Choose a photo to upload", url: null };
  }

  const targetId = resolveAvatarEmployeeId(
    String(formData.get("employeeId") ?? ""),
    user.id,
  );
  if (!targetId) {
    return { error: "Employee not found", url: null };
  }

  const { data: me } = await supabase
    .from("employees")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();
  if (
    !me ||
    !canChangeEmployeePhoto(
      { id: user.id, role: String(me.role), status: String(me.status) },
      targetId,
    )
  ) {
    return { error: "You cannot change this photo", url: null };
  }
  if (targetId !== user.id && !(await sameCompanyEmployee(supabase, targetId))) {
    return { error: "Employee not found", url: null };
  }

  const path = avatarStoragePath(targetId, file.type);

  try {
    const admin = createAdminClient();
    await ensureAvatarsBucket(admin);
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: true,
      });
    if (uploadError) return { error: uploadError.message, url: null };

    const { data } = admin.storage.from(BUCKET).getPublicUrl(path);
    const url = `${data.publicUrl}?v=${Date.now()}`;
    const { error: updateError } = await admin
      .from("employees")
      .update({ avatar_url: url })
      .eq("id", targetId);
    if (updateError) return { error: updateError.message, url: null };
    return { error: null, url };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Could not upload photo",
      url: null,
    };
  }
}
