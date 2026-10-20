import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AVATAR_MAX_BYTES,
  avatarFileIssue,
  avatarStoragePath,
  canChangeEmployeePhoto,
  extensionFor,
  isEmployeeId,
  resolveAvatarEmployeeId,
} from "./employee-avatar-file";

const employeeId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

test("extensionFor: maps known image types and defaults to jpg", () => {
  assert.equal(extensionFor("image/png"), "png");
  assert.equal(extensionFor("image/webp"), "webp");
  assert.equal(extensionFor("image/gif"), "gif");
  assert.equal(extensionFor("image/jpeg"), "jpg");
  assert.equal(extensionFor("image/unknown"), "jpg");
});

test("avatarStoragePath: stays under the employee folder", () => {
  assert.equal(avatarStoragePath(employeeId, "image/png"), `${employeeId}/avatar.png`);
});

test("avatarFileIssue: missing, wrong type, too large, and a valid file", () => {
  assert.equal(avatarFileIssue(null), "Choose a photo to upload");
  assert.equal(avatarFileIssue({ type: "image/jpeg", size: 0 }), "Choose a photo to upload");
  assert.equal(
    avatarFileIssue({ type: "application/pdf", size: 100 }),
    "Use a JPG, PNG, WEBP, or GIF photo",
  );
  assert.equal(
    avatarFileIssue({ type: "image/png", size: AVATAR_MAX_BYTES + 1 }),
    "Photo must be 5 MB or smaller",
  );
  assert.equal(avatarFileIssue({ type: "image/jpeg", size: 12 }), null);
});

test("canChangeEmployeePhoto: self, staff, and refusals", () => {
  assert.equal(
    canChangeEmployeePhoto({ id: employeeId, role: "employee", status: "active" }, employeeId),
    true,
  );
  assert.equal(
    canChangeEmployeePhoto({ id: employeeId, role: "admin", status: "active" }, otherId),
    true,
  );
  assert.equal(
    canChangeEmployeePhoto({ id: employeeId, role: "manager", status: "active" }, otherId),
    true,
  );
  assert.equal(
    canChangeEmployeePhoto({ id: employeeId, role: "employee", status: "active" }, otherId),
    false,
  );
  assert.equal(
    canChangeEmployeePhoto({ id: employeeId, role: "admin", status: "inactive" }, otherId),
    false,
  );
});

test("resolveAvatarEmployeeId: uses the request, falls back to self, rejects junk", () => {
  assert.equal(resolveAvatarEmployeeId(otherId, employeeId), otherId);
  assert.equal(resolveAvatarEmployeeId("", employeeId), employeeId);
  assert.equal(resolveAvatarEmployeeId("../etc/passwd", employeeId), null);
  assert.equal(isEmployeeId(employeeId), true);
  assert.equal(isEmployeeId("not-an-id"), false);
});
