export type Role = "Employee" | "Admin" | "Manager";

export type Employee = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  department: string;
  departmentId: string | null;
  jobTitle: string | null;
  role: string;
  status: string;
  startDate: string | null;
  monthlyLeaveDays: number | null;
  avatarUrl: string | null;
  initials: string;
  color: string;
};

export type LeaveRequest = {
  id: string;
  employeeId: string;
  leaveTypeId: string | null;
  name: string;
  type: string;
  dates: string;
  days: string;
  department: string;
  status: "Pending" | "Approved" | "Rejected";
  startDate: string;
  endDate: string;
  reason: string | null;
  createdAt: string | null;
  approverId: string | null;
  attachmentPath: string | null;
  attachmentName: string | null;
};

export type Authorization = {
  id: string;
  employeeId: string;
  name: string;
  department: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  durationLabel: string;
  timesLabel: string;
  reason: string;
  status: "Pending" | "Approved" | "Rejected";
  createdAt: string | null;
  approverId: string | null;
};

export type RequestTab = "leaves" | "authorizations";

export type Department = {
  id: string;
  name: string;
  manager: string;
  managerId: string | null;
  count: number;
};

export type Notice = {
  id: string;
  kind: "approved" | "rejected" | "pending" | "reminder";
  text: string;
  time: string;
  read?: boolean;
  createdAt?: string;
  leaveRequestId?: string | null;
  authorizationId?: string | null;
  attendanceCorrectionId?: string | null;
};

export type NoticeFocus = {
  tab: RequestTab | "attendance";
  id: string | null;
};

export type LeaveBalance = {
  employeeId: string;
  leaveTypeId: string;
  typeName: string;
  daysRemaining: number;
};

export type LeaveType = {
  id: string;
  name: string;
  defaultDays: number;
  code?: string | null;
};

export type CompanyEvent = {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  type: string;
};

export type ModalKind = "request" | "authorization" | "event" | "department" | "employee";

export type {
  AttendanceCorrectionRequest,
  AttendanceDaySummary,
  AttendanceReportItem,
  AttendanceSettings,
  WorkSchedule,
} from "@/lib/attendance";
