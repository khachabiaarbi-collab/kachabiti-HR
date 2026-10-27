import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignableRoles,
  canChangeRoleOf,
  canDeleteEmployee,
  canManageAccountOf,
  isAdminRole,
  isHrRole,
  isWorkspaceRole,
  normalizeRole,
} from "./roles";

const owner = { id: "o", role: "owner" };
const admin = { id: "a", role: "admin" };
const otherAdmin = { id: "a2", role: "admin" };
const hr = { id: "h", role: "hr" };
const manager = { id: "m", role: "manager" };
const employee = { id: "e", role: "employee" };

test("normalizeRole: known roles, Administrator, anything else is employee", () => {
  assert.equal(normalizeRole("OWNER"), "owner");
  assert.equal(normalizeRole("Administrator"), "admin");
  assert.equal(normalizeRole("hr"), "hr");
  assert.equal(normalizeRole("intern"), "employee");
  assert.equal(normalizeRole(null), "employee");
});

test("role groups", () => {
  assert.deepEqual(
    ["owner", "admin", "hr", "manager", "employee"].map(isWorkspaceRole),
    [true, true, true, true, false],
  );
  assert.deepEqual(
    ["owner", "admin", "hr", "manager", "employee"].map(isHrRole),
    [true, true, true, false, false],
  );
  assert.deepEqual(
    ["owner", "admin", "hr", "manager", "employee"].map(isAdminRole),
    [true, true, false, false, false],
  );
});

test("assignableRoles: owner adds admin, admin up to hr, others none", () => {
  assert.deepEqual(assignableRoles("owner"), ["admin", "hr", "manager", "employee"]);
  assert.deepEqual(assignableRoles("admin"), ["hr", "manager", "employee"]);
  assert.deepEqual(assignableRoles("hr"), []);
  assert.deepEqual(assignableRoles("manager"), []);
});

test("canChangeRoleOf: never self or the owner; admins only by the owner", () => {
  assert.equal(canChangeRoleOf(owner, admin), true);
  assert.equal(canChangeRoleOf(admin, otherAdmin), false);
  assert.equal(canChangeRoleOf(admin, employee), true);
  assert.equal(canChangeRoleOf(admin, owner), false);
  assert.equal(canChangeRoleOf(owner, owner), false);
  assert.equal(canChangeRoleOf(hr, employee), false);
});

test("canManageAccountOf and canDeleteEmployee protect the owner and admins", () => {
  assert.equal(canManageAccountOf(admin, admin), true);
  assert.equal(canManageAccountOf(admin, otherAdmin), false);
  assert.equal(canManageAccountOf(owner, admin), true);
  assert.equal(canManageAccountOf(admin, owner), false);
  assert.equal(canManageAccountOf(hr, employee), false);
  assert.equal(canDeleteEmployee(admin, employee), true);
  assert.equal(canDeleteEmployee(admin, otherAdmin), false);
  assert.equal(canDeleteEmployee(owner, admin), true);
  assert.equal(canDeleteEmployee(owner, owner), false);
  assert.equal(canDeleteEmployee(hr, employee), false);
  assert.equal(canDeleteEmployee(manager, employee), false);
});
