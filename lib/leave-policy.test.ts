import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customLeaveCode,
  isBuiltInLeaveType,
  isReservedLeaveTypeName,
  leaveTypeIssue,
} from "./leave-policy-file";

test("isBuiltInLeaveType: built-in codes only, any case", () => {
  assert.equal(isBuiltInLeaveType("VACATION"), true);
  assert.equal(isBuiltInLeaveType("sick"), true);
  assert.equal(isBuiltInLeaveType("UNPAID"), true);
  assert.equal(isBuiltInLeaveType("EXCEPTIONAL_MARRIAGE_EMPLOYEE"), false);
  assert.equal(isBuiltInLeaveType("CUSTOM_AB12CD34"), false);
  assert.equal(isBuiltInLeaveType(null), false);
});

test("isReservedLeaveTypeName: names read as built-in types", () => {
  assert.equal(isReservedLeaveTypeName("Annual bonus"), true);
  assert.equal(isReservedLeaveTypeName("Congé maladie"), true);
  assert.equal(isReservedLeaveTypeName("إجازة سنوية"), true);
  assert.equal(isReservedLeaveTypeName("Training leave"), false);
  assert.equal(isReservedLeaveTypeName("Congé de formation"), false);
});

test("customLeaveCode: CUSTOM_ plus 8 upper-case characters", () => {
  assert.equal(customLeaveCode("ab12cd34-ef56"), "CUSTOM_AB12CD34");
  assert.equal(isBuiltInLeaveType(customLeaveCode("anything")), false);
});

test("leaveTypeIssue: name, reserved names and whole days", () => {
  const custom = { builtIn: false };
  assert.equal(leaveTypeIssue({ name: "Training", defaultDays: "5" }, custom), null);
  assert.equal(leaveTypeIssue({ name: " ", defaultDays: 5 }, custom), "Leave type name is required");
  assert.match(leaveTypeIssue({ name: "Annual extra", defaultDays: 5 }, custom) ?? "", /kept for the built-in/);
  assert.equal(leaveTypeIssue({ name: "Annual leave", defaultDays: 21 }, { builtIn: true }), null);
  assert.match(leaveTypeIssue({ name: "Training", defaultDays: "1.5" }, custom) ?? "", /whole default days/);
  assert.match(leaveTypeIssue({ name: "Training", defaultDays: 400 }, custom) ?? "", /whole default days/);
});
