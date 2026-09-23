import { NextResponse } from "next/server";

import {
  attendanceErrorResponse,
  invalidRequest,
  readJsonObject,
  throwAttendanceDatabaseError,
} from "@/lib/attendance-api";
import {
  isIsoDate,
  isUuid,
  type AttendancePunchType,
  type CorrectionOperation,
} from "@/lib/attendance";
import {
  listCorrectionRequests,
  requireAttendanceAuth,
} from "@/lib/attendance-server";

const OPERATIONS: CorrectionOperation[] = ["add", "change", "void"];
const PUNCH_TYPES: AttendancePunchType[] = ["entry", "exit"];

function isPunchType(value: unknown): value is AttendancePunchType {
  return PUNCH_TYPES.includes(value as AttendancePunchType);
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const status = params.get("status");
    const limit = Number(params.get("limit") ?? "50");
    if (
      (status && !["pending", "approved", "rejected"].includes(status)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return invalidRequest("The correction request filters are invalid.");
    }
    const auth = await requireAttendanceAuth();
    return NextResponse.json({
      items: await listCorrectionRequests(auth, status, limit),
    });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (!body) return invalidRequest("A JSON request body is required.");

    const operation = body.operation as CorrectionOperation;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const workDate = body.workDate;
    const targetPunchId = body.targetPunchId;
    const proposedType = body.proposedType as AttendancePunchType | undefined;
    const proposedOccurredAt = body.proposedOccurredAt;

    if (
      !OPERATIONS.includes(operation) ||
      !isIsoDate(workDate) ||
      reason.length < 3 ||
      reason.length > 2000
    ) {
      return invalidRequest(
        "Operation, work date, and a reason of at least 3 characters are required.",
      );
    }
    if (
      (operation === "add" &&
        (targetPunchId != null ||
          !isPunchType(proposedType) ||
          typeof proposedOccurredAt !== "string")) ||
      (operation === "change" &&
        (!isUuid(targetPunchId) ||
          !isPunchType(proposedType) ||
          typeof proposedOccurredAt !== "string")) ||
      (operation === "void" &&
        (!isUuid(targetPunchId) ||
          proposedType != null ||
          proposedOccurredAt != null))
    ) {
      return invalidRequest("The correction proposal is incomplete or invalid.");
    }
    if (
      proposedOccurredAt != null &&
      Number.isNaN(Date.parse(String(proposedOccurredAt)))
    ) {
      return invalidRequest("The proposed timestamp is invalid.");
    }

    const auth = await requireAttendanceAuth();
    const requestedEmployeeId =
      typeof body.employeeId === "string" ? body.employeeId : auth.userId;
    if (!isUuid(requestedEmployeeId) || (!auth.isStaff && requestedEmployeeId !== auth.userId)) {
      return invalidRequest("The employee is invalid.");
    }

    const { data, error } = await auth.supabase
      .from("attendance_correction_requests")
      .insert({
        requester_id: auth.userId,
        employee_id: requestedEmployeeId,
        work_date: workDate,
        operation,
        target_punch_id: targetPunchId ?? null,
        proposed_type: proposedType ?? null,
        proposed_occurred_at: proposedOccurredAt ?? null,
        reason,
      })
      .select("id")
      .single();
    if (error) throwAttendanceDatabaseError(error);
    return NextResponse.json({ id: data.id, status: "pending" }, { status: 201 });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
