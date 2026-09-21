"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const BUCKET = "avatars";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

function extensionFor(type: string) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

async function ensureAvatarsBucket(
  admin: ReturnType<typeof createAdminClient>,
) {
  const { data: buckets, error: listError } = await admin.storage.listBuckets();
  if (listError) throw listError;
  const existing = buckets?.find((bucket) => bucket.id === BUCKET);
  if (!existing) {
    const { error } = await admin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_BYTES,
      allowedMimeTypes: [...ALLOWED],
    });
    if (error && !/exist/i.test(error.message)) throw error;
    return;
  }
  if (!existing.public) {
    const { error } = await admin.storage.updateBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_BYTES,
      allowedMimeTypes: [...ALLOWED],
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
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a photo to upload", url: null };
  }
  if (!ALLOWED.includes(file.type as (typeof ALLOWED)[number])) {
    return { error: "Use a JPG, PNG, WEBP, or GIF photo", url: null };
  }
  if (file.size > MAX_BYTES) {
    return { error: "Photo must be 5 MB or smaller", url: null };
  }

  const path = `${user.id}/avatar.${extensionFor(file.type)}`;

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
      .eq("id", user.id);
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
