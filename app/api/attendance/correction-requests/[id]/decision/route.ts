import { NextResponse } from "next/server";

import {
  attendanceErrorResponse,
  invalidRequest,
  readJsonObject,
} from "@/lib/attendance-api";
import { isUuid } from "@/lib/attendance";
import {
  decideCorrection,
  requireAttendanceAuth,
} from "@/lib/attendance-server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await readJsonObject(request);
    const decision = body?.decision;
    const note =
      typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : null;
    if (
      !isUuid(id) ||
      (decision !== "approved" && decision !== "rejected")
    ) {
      return invalidRequest("A valid request and decision are required.");
    }

    const auth = await requireAttendanceAuth(true);
    return NextResponse.json(
      await decideCorrection(auth, id, decision, note || null),
    );
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
