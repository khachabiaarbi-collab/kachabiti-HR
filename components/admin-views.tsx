"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Palmtree,
  Eye,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type {
  Authorization,
  CompanyEvent,
  Department,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  ModalKind,
  NoticeFocus,
  RequestTab,
} from "@/lib/app-types";
import {
  Avatar,
  Button,
  Field,
  FilterBar,
  Header,
  LeaveTypeLabel,
  Metric,
  Pagination,
  RequestTabs,
  Status,
  paginate,
  pageForId,
} from "@/components/primitives";
import {
  AuthorizationDetail,
  ConfirmModal,
  DepartmentModal,
  RequestDetail,
} from "@/components/modals";
import {
  AdminAttendance,
  AdminAttendanceOverviewCard,
  AttendanceScheduleSettings,
} from "@/components/attendance-views";
import {
  approvedAuthorizationMinutes,
  authorizationBalance,
  authorizationMonthKey,
  authorizationVacationDaysToCharge,
  displayLeaveType,
  displayValue,
  DEFAULT_MONTHLY_LEAVE_DAYS,
  daysInMonth,
  employeeBalances,
  firstName,
  formatDisplayDate,
  isAnnualLeaveType,
  isParentalLeaveType,
  isSickLeaveType,
  overlapsDateRange,
  isUnpaidLeaveType,
  isoDate,
  leaveTypeTone,
  monthStartDate,
  requestedLeaveDays,
} from "@/lib/map-rows";
import { createClient } from "@/lib/supabase/client";
import { holidaysInMonth, loadTunisiaHolidays } from "@/lib/tunisia-holidays";
import {
  deleteDepartmentRecord,
  deleteEmployeeRecord,
} from "@/lib/delete-records";
import {
  formatDaysLabel,
  screenLabel,
  translateRole,
  useLanguage,
  useT,
} from "@/lib/i18n";

async function persistLeaveDecision(
  requestId: string,
  status: "approved" | "rejected",
  approverId: string,
) {
  const supabase = createClient();
  const { data: request, error: loadError } = await supabase
    .from("leave_requests")
    .select("id, employee_id, leave_type_id, start_date, end_date, status")
    .eq("id", requestId)
    .maybeSingle();
  if (loadError) return loadError.message;
  if (!request) return "Request not found";

  if (
    status === "approved" &&
    request.status !== "approved" &&
    request.leave_type_id
  ) {
    const days = requestedLeaveDays(request.start_date, request.end_date);
    const { data: leaveType, error: typeError } = await supabase
      .from("leave_types")
      .select("id, name, default_days, code")
      .eq("id", request.leave_type_id)
      .maybeSingle();
    if (typeError) return typeError.message;
    if (leaveType && isParentalLeaveType(leaveType)) {
      // Parental leave is not deducted from solde.
    } else if (
      leaveType &&
      isSickLeaveType(leaveType)
    ) {
      const { data: balance, error: balanceError } = await supabase
        .from("leave_balances")
        .select("days_remaining")
        .eq("employee_id", request.employee_id)
        .eq("leave_type_id", request.leave_type_id)
        .maybeSingle();
      if (balanceError) return balanceError.message;
      const sickRemaining = Number(balance?.days_remaining) || 0;
      const fromSick = Math.min(Math.max(sickRemaining, 0), days);
      const overflow = days - fromSick;
      const { error: sickError } = await supabase.from("leave_balances").upsert(
        {
          employee_id: request.employee_id,
          leave_type_id: request.leave_type_id,
          days_remaining: sickRemaining - fromSick,
        },
        { onConflict: "employee_id,leave_type_id" },
      );
      if (sickError) return sickError.message;
      if (overflow > 0) {
        const { data: types, error: typesError } = await supabase
          .from("leave_types")
          .select("id, name, code");
        if (typesError) return typesError.message;
        const annual = (types ?? []).find((type) => isAnnualLeaveType(type));
        if (annual) {
          const { data: annualBalance, error: annualLoadError } = await supabase
            .from("leave_balances")
            .select("days_remaining")
            .eq("employee_id", request.employee_id)
            .eq("leave_type_id", annual.id)
            .maybeSingle();
          if (annualLoadError) return annualLoadError.message;
          const { error: annualError } = await supabase
            .from("leave_balances")
            .upsert(
              {
                employee_id: request.employee_id,
                leave_type_id: annual.id,
                days_remaining:
                  (Number(annualBalance?.days_remaining) || 0) - overflow,
              },
              { onConflict: "employee_id,leave_type_id" },
            );
          if (annualError) return annualError.message;
        }
      }
    } else if (
      leaveType &&
      !isUnpaidLeaveType({
        name: leaveType.name,
        defaultDays: Number(leaveType.default_days) || 0,
      })
    ) {
      const { data: balance, error: balanceError } = await supabase
        .from("leave_balances")
        .select("days_remaining")
        .eq("employee_id", request.employee_id)
        .eq("leave_type_id", request.leave_type_id)
        .maybeSingle();
      if (balanceError) return balanceError.message;

      const next = (Number(balance?.days_remaining) || 0) - days;
      const { error: soldeError } = await supabase.from("leave_balances").upsert(
        {
          employee_id: request.employee_id,
          leave_type_id: request.leave_type_id,
          days_remaining: next,
        },
        { onConflict: "employee_id,leave_type_id" },
      );
      if (soldeError) return soldeError.message;
    }
  }

  const { error } = await supabase
    .from("leave_requests")
    .update({ status, approver_id: approverId })
    .eq("id", requestId);
  return error?.message ?? null;
}

async function deductAnnualLeaveDays(
  supabase: ReturnType<typeof createClient>,
  employeeId: string,
  days: number,
) {
  if (days <= 0) return null;
  const { data: types, error: typesError } = await supabase
    .from("leave_types")
    .select("id, name, code");
  if (typesError) return typesError.message;
  const annual = (types ?? []).find((type) => isAnnualLeaveType(type));
  if (!annual) return "Vacation leave type not found";

  const { data: annualBalance, error: annualLoadError } = await supabase
    .from("leave_balances")
    .select("days_remaining")
    .eq("employee_id", employeeId)
    .eq("leave_type_id", annual.id)
    .maybeSingle();
  if (annualLoadError) return annualLoadError.message;

  const { error: annualError } = await supabase.from("leave_balances").upsert(
    {
      employee_id: employeeId,
      leave_type_id: annual.id,
      days_remaining: (Number(annualBalance?.days_remaining) || 0) - days,
    },
    { onConflict: "employee_id,leave_type_id" },
  );
  return annualError?.message ?? null;
}

async function persistAuthorizationDecision(
  requestId: string,
  status: "approved" | "rejected",
  approverId: string,
): Promise<{ error: string | null; vacationDaysTaken: number }> {
  const supabase = createClient();
  const { data: request, error: loadError } = await supabase
    .from("authorizations")
    .select("id, employee_id, duration_minutes, status, date")
    .eq("id", requestId)
    .maybeSingle();
  if (loadError) return { error: loadError.message, vacationDaysTaken: 0 };
  if (!request) return { error: "Request not found", vacationDaysTaken: 0 };

  let vacationDaysTaken = 0;

  if (status === "approved" && request.status !== "approved") {
    const monthKey = authorizationMonthKey(String(request.date ?? ""));
    const chargedSelect = await supabase
      .from("authorizations")
      .select("duration_minutes, leave_days_charged, date")
      .eq("employee_id", request.employee_id)
      .eq("status", "approved");
    const tracked = !chargedSelect.error;
    let approvedRows: Array<{
      duration_minutes: number | string;
      leave_days_charged?: number | string | null;
      date?: string | null;
    }> = chargedSelect.data ?? [];
    if (!tracked) {
      if (!/leave_days_charged/i.test(chargedSelect.error.message)) {
        return { error: chargedSelect.error.message, vacationDaysTaken: 0 };
      }
      const fallback = await supabase
        .from("authorizations")
        .select("duration_minutes, date")
        .eq("employee_id", request.employee_id)
        .eq("status", "approved");
      if (fallback.error) {
        return { error: fallback.error.message, vacationDaysTaken: 0 };
      }
      approvedRows = fallback.data ?? [];
    }
    approvedRows = approvedRows.filter(
      (row) => authorizationMonthKey(String(row.date ?? "")) === monthKey,
    );

    const usedBefore = approvedRows.reduce(
      (sum, row) => sum + (Number(row.duration_minutes) || 0),
      0,
    );
    const additional = Number(request.duration_minutes) || 0;
    const expected = authorizationBalance(usedBefore + additional).daysCharged;
    const alreadyCharged = tracked
      ? approvedRows.reduce(
          (sum, row) =>
            sum + (Number(row.leave_days_charged) || 0),
          0,
        )
      : authorizationBalance(usedBefore).daysCharged;
    vacationDaysTaken = Math.max(0, expected - alreadyCharged);

    const chargeError = await deductAnnualLeaveDays(
      supabase,
      request.employee_id,
      vacationDaysTaken,
    );
    if (chargeError) return { error: chargeError, vacationDaysTaken: 0 };
  }

  const payload: {
    status: "approved" | "rejected";
    approver_id: string;
    leave_days_charged?: number;
  } = { status, approver_id: approverId };
  if (status === "approved") {
    payload.leave_days_charged = vacationDaysTaken;
  }

  const { error } = await supabase
    .from("authorizations")
    .update(payload)
    .eq("id", requestId);
  if (error && /leave_days_charged/i.test(error.message)) {
    const retry = await supabase
      .from("authorizations")
      .update({ status, approver_id: approverId })
      .eq("id", requestId);
    return { error: retry.error?.message ?? null, vacationDaysTaken };
  }
  return { error: error?.message ?? null, vacationDaysTaken };
}

async function decideRequest(
  requestId: string,
  status: "approved" | "rejected",
  currentEmployee: Employee | null,
  flash: (message: string) => void,
  reload: () => Promise<void>,
  setBusyId: (id: string | null) => void,
  t: ReturnType<typeof useT>,
) {
  if (!currentEmployee) {
    flash(t("profile.mustSignIn"));
    return;
  }
  setBusyId(requestId);
  const message = await persistLeaveDecision(
    requestId,
    status,
    currentEmployee.id,
  );
  if (message) {
    flash(message);
    setBusyId(null);
    return;
  }
  await reload();
  flash(status === "approved" ? t("admin.approved") : t("admin.rejected"));
  setBusyId(null);
}

async function decideAuthorization(
  requestId: string,
  status: "approved" | "rejected",
  currentEmployee: Employee | null,
  flash: (message: string) => void,
  reload: () => Promise<void>,
  setBusyId: (id: string | null) => void,
  t: ReturnType<typeof useT>,
) {
  if (!currentEmployee) {
    flash(t("profile.mustSignIn"));
    return;
  }
  setBusyId(requestId);
  const result = await persistAuthorizationDecision(
    requestId,
    status,
    currentEmployee.id,
  );
  if (result.error) {
    flash(result.error);
    setBusyId(null);
    return;
  }
  await reload();
  if (status === "approved" && result.vacationDaysTaken > 0) {
    flash(
      result.vacationDaysTaken === 1
        ? t("admin.approvedOneDay")
        : t("admin.approvedDays", { count: result.vacationDaysTaken }),
    );
  } else {
    flash(status === "approved" ? t("admin.approved") : t("admin.rejected"));
  }
  setBusyId(null);
}

export function AdminView({
  active,
  setActive,
  requests,
  authorizations,
  setRequests,
  employees,
  setEmployees,
  departments,
  setDepartments,
  setSelected,
  navigate,
  flash,
  setModal,
  globalSearch,
  currentEmployee,
  events,
  balances,
  setBalances,
  leaveTypes,
  noticeFocus = null,
  onNoticeFocusHandled,
  reload,
}: {
  active: string;
  setActive: (label: string) => void;
  requests: LeaveRequest[];
  authorizations: Authorization[];
  setRequests: (requests: LeaveRequest[]) => void;
  employees: Employee[];
  setEmployees: (employees: Employee[]) => void;
  departments: Department[];
  setDepartments: (departments: Department[]) => void;
  setSelected: (employee: Employee | null) => void;
  navigate: (path: string) => void;
  flash: (message: string) => void;
  setModal: (modal: ModalKind) => void;
  globalSearch: string;
  currentEmployee: Employee | null;
  events: CompanyEvent[];
  balances: LeaveBalance[];
  setBalances: (balances: LeaveBalance[]) => void;
  leaveTypes: LeaveType[];
  noticeFocus?: NoticeFocus | null;
  onNoticeFocusHandled?: () => void;
  reload: () => Promise<void>;
}) {
  if (active === "People") {
    return (
      <People
        employees={employees}
        setEmployees={setEmployees}
        setSelected={setSelected}
        setModal={setModal}
        globalSearch={globalSearch}
        balances={balances}
        setBalances={setBalances}
        setRequests={setRequests}
        setDepartments={setDepartments}
        departments={departments}
        requests={requests}
        currentEmployee={currentEmployee}
        flash={flash}
      />
    );
  }
  if (active === "Departments") {
    return (
      <Departments
        departments={departments}
        setDepartments={setDepartments}
        employees={employees}
        setEmployees={setEmployees}
        setModal={setModal}
        flash={flash}
        reload={reload}
      />
    );
  }
  if (active === "Leave requests") {
    return (
      <Requests
        requests={requests}
        authorizations={authorizations}
        employees={employees}
        currentEmployee={currentEmployee}
        balances={balances}
        leaveTypes={leaveTypes}
        flash={flash}
        reload={reload}
        noticeFocus={noticeFocus}
        onNoticeFocusHandled={onNoticeFocusHandled}
      />
    );
  }
  if (active === "Team calendar") {
    return (
      <Calendar
        setModal={setModal}
        events={events}
        requests={requests}
        authorizations={authorizations}
        employees={employees}
        departments={departments}
        canAddEvent
      />
    );
  }
  if (active === "Attendance") {
    return (
      <AdminAttendance
        employees={employees}
        departments={departments}
        flash={flash}
        focusCorrectionId={
          noticeFocus?.tab === "attendance" ? noticeFocus.id : null
        }
        onNoticeFocusHandled={onNoticeFocusHandled}
      />
    );
  }
  if (active === "Analytics") {
    return <Analytics requests={requests} employees={employees} />;
  }
  if (active === "Settings") {
    return (
      <SettingsView
        leaveTypes={leaveTypes}
        departments={departments}
        employees={employees}
        flash={flash}
      />
    );
  }
  return (
    <Dashboard
      pending={
        requests.filter((request) => request.status === "Pending").length
      }
      navigate={navigate}
      requests={requests}
      currentEmployee={currentEmployee}
      employees={employees}
      flash={flash}
      reload={reload}
      onOpenAttendance={() => setActive("Attendance")}
    />
  );
}

function Dashboard({
  pending,
  navigate,
  requests,
  currentEmployee,
  employees,
  flash,
  reload,
  onOpenAttendance,
}: {
  pending: number;
  navigate: (path: string) => void;
  requests: LeaveRequest[];
  currentEmployee: Employee | null;
  employees: Employee[];
  flash: (message: string) => void;
  reload: () => Promise<void>;
  onOpenAttendance: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingApprove, setPendingApprove] = useState<LeaveRequest | null>(
    null,
  );
  const { t, dateLocale } = useLanguage();
  const now = new Date();
  const today = isoDate(now);
  const year = String(now.getFullYear());
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  const weekAgoIso = weekAgo.toISOString();
  const hello = currentEmployee ? firstName(currentEmployee.name) : "";
  const hour = now.getHours();
  const greeting =
    hour < 12
      ? t("admin.greetingMorning")
      : hour < 18
        ? t("admin.greetingAfternoon")
        : t("admin.greetingEvening");
  const onLeave = requests.filter(
    (request) =>
      request.status === "Approved" &&
      request.startDate <= today &&
      request.endDate >= today,
  ).length;
  const pendingThisWeek = requests.filter(
    (request) =>
      request.status === "Pending" &&
      request.createdAt &&
      request.createdAt >= weekAgoIso,
  ).length;
  const twoWeeksAgo = new Date(now);
  twoWeeksAgo.setDate(now.getDate() - 14);
  const twoWeeksIso = twoWeeksAgo.toISOString();
  const pendingLastWeek = requests.filter(
    (request) =>
      request.status === "Pending" &&
      request.createdAt &&
      request.createdAt >= twoWeeksIso &&
      request.createdAt < weekAgoIso,
  ).length;
  const pendingTrend =
    pendingLastWeek > 0
      ? (() => {
          const pct =
            ((pendingThisWeek - pendingLastWeek) / pendingLastWeek) * 100;
          return {
            label: `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`,
            tone:
              pct > 0 ? ("warning" as const) : pct < 0 ? ("positive" as const) : ("info" as const),
          };
        })()
      : undefined;
  const daysTaken = requests
    .filter(
      (request) =>
        request.status === "Approved" && request.startDate.startsWith(year),
    )
    .reduce(
      (total, request) =>
        total + requestedLeaveDays(request.startDate, request.endDate),
      0,
    );
  const lastYear = String(now.getFullYear() - 1);
  const ytdCutoff = isoDate(now).slice(5);
  const daysTakenLastYtd = requests
    .filter(
      (request) =>
        request.status === "Approved" &&
        request.startDate.startsWith(lastYear) &&
        request.startDate.slice(5) <= ytdCutoff,
    )
    .reduce(
      (total, request) =>
        total + requestedLeaveDays(request.startDate, request.endDate),
      0,
    );
  const leaveTakenTrend =
    daysTakenLastYtd > 0
      ? (() => {
          const pct = ((daysTaken - daysTakenLastYtd) / daysTakenLastYtd) * 100;
          return {
            label: `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`,
            tone: "info" as const,
          };
        })()
      : undefined;
  const recent = [...requests]
    .sort((left, right) => {
      const a = left.createdAt ?? left.startDate;
      const b = right.createdAt ?? right.startDate;
      return b.localeCompare(a);
    })
    .slice(0, 8);
  const dateLabel = now.toLocaleDateString(dateLocale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="dashboard-page">
      <section className="welcome-row">
        <div>
          <p className="eyebrow">{dateLabel}</p>
          <h1>
            {greeting}
            {hello ? `, ${hello}` : ""}
          </h1>
          <p className="page-subtitle">{t("admin.subtitle")}</p>
        </div>
      </section>
      <section className="metric-grid">
        <Metric
          label={t("admin.teamMembers")}
          value={String(employees.length)}
          note={t("admin.inWorkspace")}
          tone="indigo"
          icon={<Users size={19} />}
        />
        <Metric
          label={t("admin.onLeaveToday")}
          value={String(onLeave)}
          note={
            onLeave === 1
              ? t("admin.onLeaveOne")
              : t("admin.onLeaveMany", { count: onLeave })
          }
          tone="teal"
          icon={<Palmtree size={19} />}
        />
        <Metric
          label={t("admin.pendingApprovals")}
          value={String(pending)}
          note={
            pendingThisWeek === 1
              ? t("admin.submittedOne")
              : t("admin.submittedMany", { count: pendingThisWeek })
          }
          tone="amber"
          icon={<Clock3 size={19} />}
          trend={pendingTrend}
        />
        <Metric
          label={t("admin.leaveTaken")}
          value={String(daysTaken)}
          note={
            daysTaken === 1
              ? t("admin.takenOne")
              : t("admin.takenMany", { count: daysTaken })
          }
          tone="rose"
          icon={<Activity size={19} />}
          trend={leaveTakenTrend}
        />
      </section>
      <AdminAttendanceOverviewCard onOpen={onOpenAttendance} />
      <div className="card table-card">
        <div className="card-heading">
          <h2>{t("admin.recent")}</h2>
          <button type="button" onClick={() => navigate("/admin")}>
            {t("admin.viewAll")} <ChevronRight size={14} />
          </button>
        </div>
        {recent.map((request) => {
          const person = employees.find(
            (employee) => employee.id === request.employeeId,
          );
          return (
            <div className="request-row" key={request.id}>
              <Avatar
                e={
                  person ?? {
                    initials: request.name
                      .split(" ")
                      .map((part) => part[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase() || "?",
                    color: "avatar-slate",
                    avatarUrl: null,
                  }
                }
              />
              <div className="request-person">
                <p>{request.name}</p>
                <LeaveTypeLabel type={displayLeaveType(request.type)} />
              </div>
              <div className="request-date">
                <p>{request.dates}</p>
                <span>{request.days}</span>
              </div>
              <Status status={request.status} />
              {request.status === "Pending" && (
                <button
                  type="button"
                  className="row-menu"
                  disabled={busyId === request.id}
                  onClick={() => setPendingApprove(request)}
                >
                  <Check size={16} />
                </button>
              )}
            </div>
          );
        })}
        {recent.length === 0 && (
          <div className="table-empty">{t("requests.emptyLeaves")}</div>
        )}
      </div>
      {pendingApprove && (
        <ConfirmModal
          title={t("admin.approveTitle")}
          message={t("admin.approveLeave", {
            name: pendingApprove.name,
            type: pendingApprove.type,
            dates: pendingApprove.dates,
          })}
          confirmLabel={t("common.approve")}
          cancelLabel={t("admin.goBack")}
          danger={false}
          close={() => setPendingApprove(null)}
          confirm={async () => {
            await decideRequest(
              pendingApprove.id,
              "approved",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            );
            setPendingApprove(null);
          }}
        />
      )}
    </div>
  );
}

function People({
  employees,
  setEmployees,
  setSelected,
  setModal,
  globalSearch,
  balances,
  setBalances,
  setRequests,
  setDepartments,
  departments,
  requests,
  currentEmployee,
  flash,
}: {
  employees: Employee[];
  setEmployees: (employees: Employee[]) => void;
  setSelected: (employee: Employee | null) => void;
  setModal: (modal: ModalKind) => void;
  globalSearch: string;
  balances: LeaveBalance[];
  setBalances: (balances: LeaveBalance[]) => void;
  setRequests: (requests: LeaveRequest[]) => void;
  setDepartments: (departments: Department[]) => void;
  departments: Department[];
  requests: LeaveRequest[];
  currentEmployee: Employee | null;
  flash: (message: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("All");
  const [page, setPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<Employee | null>(null);
  const filtered = employees.filter(
    (employee) =>
      (
        employee.name +
        employee.email +
        employee.department +
        (employee.jobTitle ?? "") +
        (employee.phone ?? "") +
        employee.role
      )
        .toLowerCase()
        .includes((query || globalSearch).toLowerCase()) &&
      (department === "All" || employee.department === department),
  );
  const paged = paginate(filtered, page);

  useEffect(() => {
    setPage(1);
  }, [query, department, globalSearch]);

  return (
    <>
      <Header
        eyebrow={t("admin.directory")}
        title={t("admin.employees")}
        action={
          <Button onClick={() => setModal("employee")}>
            <UserPlus size={16} /> {t("admin.addEmployee")}
          </Button>
        }
      />
      <div className="card table-card">
        <FilterBar
          search={query}
          setSearch={setQuery}
          filters={[
            {
              value: department,
              setValue: setDepartment,
              options: [
                "All",
                ...Array.from(
                  new Set(employees.map((employee) => employee.department)),
                ),
              ],
            },
          ]}
        />
        {filtered.length > 0 && (
          <div className="employee-row people-row people-head">
            <span>{t("admin.colEmployee")}</span>
            <span>{t("admin.colEmail")}</span>
            <span>{t("admin.colPhone")}</span>
            <span>{t("filter.department")}</span>
            <span>{t("admin.colVacation")}</span>
            <span />
          </div>
        )}
        {paged.items.map((employee) => {
          const solde = employeeBalances(balances, employee.id).filter(
            (balance) => isAnnualLeaveType({ name: balance.typeName }),
          );
          return (
            <div className="employee-row people-row" key={employee.id}>
              <div className="table-member">
                <Avatar e={employee} />
                <div>
                  <b>{employee.name}</b>
                  <span>
                    {translateRole(t, employee.role)}
                    {employee.jobTitle ? ` · ${employee.jobTitle}` : ""}
                  </span>
                </div>
              </div>
              <span>{employee.email}</span>
              <span>{displayValue(employee.phone)}</span>
              <span>
                {employee.department === "Unassigned"
                  ? t("department.unassigned")
                  : employee.department}
              </span>
              <div className="leave-balance-list">
                {solde.length === 0 ? (
                  <span className="leave-balance-empty">{t("admin.notSet")}</span>
                ) : (
                  solde.map((balance) => (
                    <span
                      key={balance.leaveTypeId}
                      className={`leave-balance-chip ${
                        balance.daysRemaining < 0
                          ? "is-negative"
                          : balance.daysRemaining === 0
                            ? "is-empty"
                            : ""
                      }`}
                      title={t("admin.balanceTitle", {
                        type: displayLeaveType(balance.typeName),
                        days: balance.daysRemaining,
                      })}
                    >
                      <span>
                        {displayLeaveType(balance.typeName)
                          .replace(/leave/i, "")
                          .trim()}
                      </span>
                      <b>
                        {balance.daysRemaining}
                        <small>d</small>
                      </b>
                    </span>
                  ))
                )}
              </div>
              <div className="row-actions">
              <button type="button" onClick={() => setSelected(employee)}>
                <Pencil size={14} />
              </button>
              {currentEmployee?.id !== employee.id && (
                <button type="button" onClick={() => setPendingDelete(employee)}>
                  <Trash2 size={14} />
                </button>
              )}
              </div>
            </div>
          );
        })}
        <Pagination
          page={paged.page}
          pageCount={paged.pageCount}
          total={paged.total}
          start={paged.start}
          end={paged.end}
          onPage={setPage}
        />
      </div>
      {pendingDelete && (
        <ConfirmModal
          title={t("admin.deleteEmployee")}
          message={t("admin.deleteEmployeeMsg", { name: pendingDelete.name })}
          confirmLabel={t("common.delete")}
          close={() => setPendingDelete(null)}
          confirm={async () => {
            const message = await deleteEmployeeRecord(pendingDelete.id);
            if (message) {
              flash(message);
              return;
            }
            const nextEmployees = employees.filter(
              (item) => item.id !== pendingDelete.id,
            );
            setEmployees(nextEmployees);
            setRequests(
              requests.filter((item) => item.employeeId !== pendingDelete.id),
            );
            setBalances(
              balances.filter((item) => item.employeeId !== pendingDelete.id),
            );
            setDepartments(
              departments.map((department) => ({
                ...department,
                managerId:
                  department.managerId === pendingDelete.id
                    ? null
                    : department.managerId,
                manager:
                  department.managerId === pendingDelete.id ||
                  department.manager === pendingDelete.name
                    ? "Unassigned"
                    : department.manager,
                count: nextEmployees.filter(
                  (item) => item.departmentId === department.id,
                ).length,
              })),
            );
            setSelected(null);
            setPendingDelete(null);
            flash(t("admin.employeeRemoved"));
          }}
        />
      )}
    </>
  );
}

function Requests({
  requests,
  authorizations,
  employees,
  currentEmployee,
  balances,
  leaveTypes,
  flash,
  reload,
  noticeFocus = null,
  onNoticeFocusHandled,
}: {
  requests: LeaveRequest[];
  authorizations: Authorization[];
  employees: Employee[];
  currentEmployee: Employee | null;
  balances: LeaveBalance[];
  leaveTypes: LeaveType[];
  flash: (message: string) => void;
  reload: () => Promise<void>;
  noticeFocus?: NoticeFocus | null;
  onNoticeFocusHandled?: () => void;
}) {
  const { t, dateLocale } = useLanguage();
  const [tab, setTab] = useState<RequestTab>("leaves");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [status, setStatus] = useState("All");
  const [type, setType] = useState("All");
  const [query, setQuery] = useState("");
  const [startFrom, setStartFrom] = useState("");
  const [endTo, setEndTo] = useState("");
  const [page, setPage] = useState(1);
  const [pendingApprove, setPendingApprove] = useState<LeaveRequest | null>(
    null,
  );
  const [pendingReject, setPendingReject] = useState<LeaveRequest | null>(null);
  const [pendingApproveAuthz, setPendingApproveAuthz] =
    useState<Authorization | null>(null);
  const [pendingRejectAuthz, setPendingRejectAuthz] =
    useState<Authorization | null>(null);
  const needle = query.toLowerCase();
  const rows = requests.filter(
    (request) =>
      (status === "All" || request.status === status) &&
      (type === "All" || request.type === type) &&
      overlapsDateRange(request.startDate, request.endDate, startFrom, endTo) &&
      (request.name.toLowerCase().includes(needle) ||
        request.type.toLowerCase().includes(needle) ||
        request.department.toLowerCase().includes(needle)),
  );
  const authzRows = authorizations.filter(
    (request) =>
      (status === "All" || request.status === status) &&
      overlapsDateRange(request.date, request.date, startFrom, endTo) &&
      (request.name.toLowerCase().includes(needle) ||
        request.reason.toLowerCase().includes(needle) ||
        request.department.toLowerCase().includes(needle)),
  );
  const paged = paginate(rows, page);
  const pagedAuthz = paginate(authzRows, page);
  const selected = requests.find((request) => request.id === selectedId) ?? null;
  const selectedAuthz =
    authorizations.find((request) => request.id === selectedId) ?? null;
  const pendingAuthzVacationDays = pendingApproveAuthz
    ? authorizationVacationDaysToCharge(
        approvedAuthorizationMinutes(
          authorizations,
          pendingApproveAuthz.employeeId,
          authorizationMonthKey(pendingApproveAuthz.date),
        ),
        pendingApproveAuthz.durationMinutes,
      )
    : 0;
  const selectedEmployee = (tab === "leaves" ? selected : selectedAuthz)
    ? (employees.find(
        (employee) =>
          employee.id ===
          (tab === "leaves" ? selected?.employeeId : selectedAuthz?.employeeId),
      ) ?? null)
    : null;
  const selectedApproverId =
    tab === "leaves" ? selected?.approverId : selectedAuthz?.approverId;
  const approverName = selectedApproverId
    ? (employees.find((employee) => employee.id === selectedApproverId)?.name ??
      null)
    : null;

  const skipClear = useRef(false);

  useEffect(() => {
    setPage(1);
    if (skipClear.current) {
      skipClear.current = false;
      return;
    }
    setSelectedId(null);
  }, [query, status, type, startFrom, endTo, tab]);

  useEffect(() => {
    if (!noticeFocus || noticeFocus.tab === "attendance") return;
    skipClear.current = true;
    setQuery("");
    setStatus("All");
    setType("All");
    setStartFrom("");
    setEndTo("");
    setTab(noticeFocus.tab);
    setPage(
      noticeFocus.tab === "authorizations"
        ? pageForId(authorizations, noticeFocus.id)
        : pageForId(requests, noticeFocus.id),
    );
    setSelectedId(noticeFocus.id);
    setHighlightId(noticeFocus.id);
    const timer = window.setTimeout(() => onNoticeFocusHandled?.(), 50);
    return () => window.clearTimeout(timer);
  }, [noticeFocus]);

  useEffect(() => {
    if (!highlightId) return;
    const row = document.querySelector(`[data-row-id="${highlightId}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = window.setTimeout(() => setHighlightId(null), 2400);
    return () => window.clearTimeout(timer);
  }, [highlightId, page, tab]);

  return (
    <>
      <Header
        eyebrow={t("admin.manage")}
        title={screenLabel(t, "Leave requests")}
        action={null}
      />
      <div className="request-tabs-row">
        <RequestTabs value={tab} onChange={setTab} />
      </div>
      {tab === "leaves" ? (
      <div className="card table-card">
        <FilterBar
          search={query}
          setSearch={setQuery}
          filters={[
            {
              label: "Status",
              value: status,
              setValue: setStatus,
              options: ["All", "Pending", "Approved", "Rejected"],
            },
            {
              label: "Leave type",
              value: type,
              setValue: setType,
              options: [
                "All",
                ...leaveTypes.map((item) => displayLeaveType(item.name)),
                ...Array.from(new Set(requests.map((request) => request.type))),
              ].filter((option, index, list) => list.indexOf(option) === index),
            },
          ]}
          startDate={startFrom}
          setStartDate={setStartFrom}
          endDate={endTo}
          setEndDate={setEndTo}
          onReset={() => {
            setQuery("");
            setStatus("All");
            setType("All");
            setStartFrom("");
            setEndTo("");
          }}
        />
        {rows.length > 0 && (
          <div className="employee-row requests-row people-head">
            <span>{t("admin.colEmployee")}</span>
            <span>{t("admin.colType")}</span>
            <span>{t("admin.colDates")}</span>
            <span>{t("admin.colDuration")}</span>
            <span>{t("filter.department")}</span>
            <span>{t("filter.status")}</span>
            <span />
          </div>
        )}
        {paged.items.map((request) => {
          const employee =
            employees.find((item) => item.id === request.employeeId) ?? null;
          return (
            <div
              className={`employee-row requests-row${selectedId === request.id ? " is-selected" : ""}${highlightId === request.id ? " is-notice-focus" : ""}`}
              data-row-id={request.id}
              key={request.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(request.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedId(request.id);
                }
              }}
            >
              <div className="table-member">
                <Avatar
                  e={
                    employee ?? {
                      initials: request.name
                        .split(" ")
                        .map((part) => part[0])
                        .join(""),
                      color: "avatar-indigo",
                    }
                  }
                />
                <div>
                  <b>{request.name}</b>
                  <span>{employee?.jobTitle || request.department}</span>
                </div>
              </div>
              <LeaveTypeLabel type={request.type} />
              <span>{request.dates}</span>
              <span>{request.days}</span>
              <span>
                {request.department === "Unassigned"
                  ? t("department.unassigned")
                  : request.department}
              </span>
              <Status status={request.status} />
              <div
                className="row-actions"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  aria-label={t("admin.viewRequest", { name: request.name })}
                  onClick={() => setSelectedId(request.id)}
                >
                  <Eye size={14} />
                </button>
                {request.status === "Pending" && (
                  <>
                    <button
                      type="button"
                      aria-label={t("admin.approveName", { name: request.name })}
                      disabled={busyId === request.id}
                      onClick={() => setPendingApprove(request)}
                    >
                      <Check size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("admin.rejectName", { name: request.name })}
                      disabled={busyId === request.id}
                      onClick={() => setPendingReject(request)}
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="table-empty">
            {requests.length === 0
              ? t("requests.emptyLeaves")
              : t("requests.emptyLeavesFiltered")}
          </div>
        )}
        <Pagination
          page={paged.page}
          pageCount={paged.pageCount}
          total={paged.total}
          start={paged.start}
          end={paged.end}
          onPage={setPage}
        />
      </div>
      ) : (
      <div className="card table-card">
        <FilterBar
          search={query}
          setSearch={setQuery}
          filters={[
            {
              label: "Status",
              value: status,
              setValue: setStatus,
              options: ["All", "Pending", "Approved", "Rejected"],
            },
          ]}
          startDate={startFrom}
          setStartDate={setStartFrom}
          endDate={endTo}
          setEndDate={setEndTo}
          onReset={() => {
            setQuery("");
            setStatus("All");
            setType("All");
            setStartFrom("");
            setEndTo("");
          }}
        />
        {authzRows.length > 0 && (
          <div className="employee-row authz-requests-row people-head">
            <span>{t("admin.colEmployee")}</span>
            <span>{t("admin.colDuration")}</span>
            <span>{t("att.colDate")}</span>
            <span>{t("admin.colTimes")}</span>
            <span>{t("admin.colReason")}</span>
            <span>{t("filter.status")}</span>
            <span />
          </div>
        )}
        {pagedAuthz.items.map((request) => {
          const employee =
            employees.find((item) => item.id === request.employeeId) ?? null;
          return (
            <div
              className={`employee-row authz-requests-row${selectedId === request.id ? " is-selected" : ""}${highlightId === request.id ? " is-notice-focus" : ""}`}
              data-row-id={request.id}
              key={request.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(request.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedId(request.id);
                }
              }}
            >
              <div className="table-member">
                <Avatar
                  e={
                    employee ?? {
                      initials: request.name
                        .split(" ")
                        .map((part) => part[0])
                        .join(""),
                      color: "avatar-indigo",
                    }
                  }
                />
                <div>
                  <b>{request.name}</b>
                  <span>{employee?.jobTitle || request.department}</span>
                </div>
              </div>
              <span>{request.durationLabel}</span>
              <span>{formatDisplayDate(request.date, dateLocale)}</span>
              <span>{request.timesLabel}</span>
              <span className="authz-reason">{request.reason}</span>
              <Status status={request.status} />
              <div
                className="row-actions"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  aria-label={t("admin.viewAuthz", { name: request.name })}
                  onClick={() => setSelectedId(request.id)}
                >
                  <Eye size={14} />
                </button>
                {request.status === "Pending" && (
                  <>
                    <button
                      type="button"
                      aria-label={t("admin.approveName", { name: request.name })}
                      disabled={busyId === request.id}
                      onClick={() => setPendingApproveAuthz(request)}
                    >
                      <Check size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("admin.rejectName", { name: request.name })}
                      disabled={busyId === request.id}
                      onClick={() => setPendingRejectAuthz(request)}
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {authzRows.length === 0 && (
          <div className="table-empty">
            {authorizations.length === 0
              ? t("requests.emptyAuthz")
              : t("requests.emptyAuthzFiltered")}
          </div>
        )}
        <Pagination
          page={pagedAuthz.page}
          pageCount={pagedAuthz.pageCount}
          total={pagedAuthz.total}
          start={pagedAuthz.start}
          end={pagedAuthz.end}
          onPage={setPage}
        />
      </div>
      )}
      {pendingApprove && (
        <ConfirmModal
          title={t("admin.approveTitle")}
          message={t("admin.approveLeave", {
            name: pendingApprove.name,
            type: pendingApprove.type,
            dates: pendingApprove.dates,
          })}
          confirmLabel={t("common.approve")}
          cancelLabel={t("admin.goBack")}
          danger={false}
          close={() => setPendingApprove(null)}
          confirm={async () => {
            await decideRequest(
              pendingApprove.id,
              "approved",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            );
            setPendingApprove(null);
          }}
        />
      )}
      {pendingReject && (
        <ConfirmModal
          title={t("admin.rejectTitle")}
          message={t("admin.rejectLeave", {
            name: pendingReject.name,
            type: pendingReject.type,
            dates: pendingReject.dates,
          })}
          confirmLabel={t("common.reject")}
          cancelLabel={t("admin.goBack")}
          close={() => setPendingReject(null)}
          confirm={async () => {
            await decideRequest(
              pendingReject.id,
              "rejected",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            );
            setPendingReject(null);
          }}
        />
      )}
      {pendingApproveAuthz && (
        <ConfirmModal
          title={t("admin.approveTitle")}
          message={
            pendingAuthzVacationDays > 0
              ? t("admin.approveAuthzDays", {
                  name: pendingApproveAuthz.name,
                  date: formatDisplayDate(pendingApproveAuthz.date, dateLocale),
                  duration: pendingApproveAuthz.durationLabel,
                  days: pendingAuthzVacationDays,
                })
              : t("admin.approveAuthz", {
                  name: pendingApproveAuthz.name,
                  date: formatDisplayDate(pendingApproveAuthz.date, dateLocale),
                  duration: pendingApproveAuthz.durationLabel,
                })
          }
          confirmLabel={t("common.approve")}
          cancelLabel={t("admin.goBack")}
          danger={false}
          close={() => setPendingApproveAuthz(null)}
          confirm={async () => {
            await decideAuthorization(
              pendingApproveAuthz.id,
              "approved",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            );
            setPendingApproveAuthz(null);
          }}
        />
      )}
      {pendingRejectAuthz && (
        <ConfirmModal
          title={t("admin.rejectTitle")}
          message={t("admin.rejectAuthz", {
            name: pendingRejectAuthz.name,
            date: formatDisplayDate(pendingRejectAuthz.date, dateLocale),
            duration: pendingRejectAuthz.durationLabel,
          })}
          confirmLabel={t("common.reject")}
          cancelLabel={t("admin.goBack")}
          close={() => setPendingRejectAuthz(null)}
          confirm={async () => {
            await decideAuthorization(
              pendingRejectAuthz.id,
              "rejected",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            );
            setPendingRejectAuthz(null);
          }}
        />
      )}
      {tab === "leaves" && selected && (
        <RequestDetail
          request={selected}
          employee={selectedEmployee}
          approverName={approverName}
          balances={balances}
          leaveTypes={leaveTypes}
          busy={busyId === selected.id}
          close={() => setSelectedId(null)}
          onApprove={() =>
            decideRequest(
              selected.id,
              "approved",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            )
          }
          onReject={() =>
            decideRequest(
              selected.id,
              "rejected",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            )
          }
        />
      )}
      {tab === "authorizations" && selectedAuthz && (
        <AuthorizationDetail
          request={selectedAuthz}
          employee={selectedEmployee}
          approverName={approverName}
          usedMinutes={approvedAuthorizationMinutes(
            authorizations,
            selectedAuthz.employeeId,
            authorizationMonthKey(selectedAuthz.date),
          )}
          busy={busyId === selectedAuthz.id}
          close={() => setSelectedId(null)}
          onApprove={() =>
            decideAuthorization(
              selectedAuthz.id,
              "approved",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            )
          }
          onReject={() =>
            decideAuthorization(
              selectedAuthz.id,
              "rejected",
              currentEmployee,
              flash,
              reload,
              setBusyId,
              t,
            )
          }
        />
      )}
    </>
  );
}

function Departments({
  departments,
  setDepartments,
  employees,
  setEmployees,
  setModal,
  flash,
  reload,
}: {
  departments: Department[];
  setDepartments: (departments: Department[]) => void;
  employees: Employee[];
  setEmployees: (employees: Employee[]) => void;
  setModal: (modal: ModalKind) => void;
  flash: (message: string) => void;
  reload: () => Promise<void>;
}) {
  const t = useT();
  const [pendingDelete, setPendingDelete] = useState<Department | null>(null);
  const [editing, setEditing] = useState<Department | null>(null);

  return (
    <>
      <Header
        eyebrow={t("admin.departmentsEyebrow")}
        title={screenLabel(t, "Departments")}
        action={
          <Button onClick={() => setModal("department")}>
            <Plus size={16} /> {t("admin.addDepartment")}
          </Button>
        }
      />
      <div className="people-grid">
        {departments.map((department) => (
          <div className="card person-card" key={department.id}>
            <div className="person-card-top">
              <div className="person-icon">
                <Building2 size={18} />
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  aria-label={t("modal.editDeptTitle")}
                  onClick={() => setEditing(department)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(department)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <h3>{department.name}</h3>
            <p>{t("admin.employeeCount", { count: department.count })}</p>
            <div className="department-manager">
              <span>{t("admin.manager")}</span>
              <b>
                {department.manager === "Unassigned"
                  ? t("department.unassigned")
                  : department.manager}
              </b>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <DepartmentModal
          department={editing}
          employees={employees}
          close={() => setEditing(null)}
          flash={flash}
          onSaved={async () => {
            setEditing(null);
            await reload();
            flash(t("toast.departmentUpdated"));
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmModal
          title={t("admin.deleteDepartment")}
          message={t("admin.deleteDepartmentMsg", { name: pendingDelete.name })}
          confirmLabel={t("common.delete")}
          close={() => setPendingDelete(null)}
          confirm={async () => {
            const message = await deleteDepartmentRecord(pendingDelete.id);
            if (message) {
              flash(message);
              return;
            }
            setEmployees(
              employees.map((employee) =>
                employee.departmentId === pendingDelete.id
                  ? {
                      ...employee,
                      departmentId: null,
                      department: "Unassigned",
                    }
                  : employee,
              ),
            );
            setDepartments(
              departments.filter((item) => item.id !== pendingDelete.id),
            );
            setPendingDelete(null);
            flash(t("admin.departmentRemoved"));
          }}
        />
      )}
    </>
  );
}

export function Calendar({
  setModal,
  events = [],
  requests = [],
  authorizations = [],
  employees = [],
  departments = [],
  canAddEvent = false,
  eyebrow = "Admin / Planning",
}: {
  setModal: (modal: ModalKind) => void;
  events?: CompanyEvent[];
  requests?: LeaveRequest[];
  authorizations?: Authorization[];
  employees?: Employee[];
  departments?: Department[];
  canAddEvent?: boolean;
  eyebrow?: string;
}) {
  const { t, dateLocale } = useLanguage();
  const [cursor, setCursor] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [department, setDepartment] = useState("All");
  const [yearHolidays, setYearHolidays] = useState<
    Awaited<ReturnType<typeof loadTunisiaHolidays>>
  >([]);
  const year = cursor.getFullYear();
  const monthIndex = cursor.getMonth();
  const dayCount = daysInMonth(year, monthIndex);
  const monthStart = monthStartDate(year, monthIndex);
  const monthStartIso = isoDate(monthStart);
  const monthEndIso = isoDate(addMonthDay(monthStart, dayCount - 1));
  const todayIso = isoDate();

  useEffect(() => {
    let cancelled = false;
    void loadTunisiaHolidays(year).then((list) => {
      if (!cancelled) setYearHolidays(list);
    });
    return () => {
      cancelled = true;
    };
  }, [year]);

  const monthHolidays = holidaysInMonth(yearHolidays, year, monthIndex + 1);
  const holidayByDate = new Map<string, string>();
  for (const holiday of monthHolidays) {
    const label =
      holiday.localName && holiday.localName !== holiday.name
        ? `${holiday.name} (${holiday.localName})`
        : holiday.name;
    const current = holidayByDate.get(holiday.date);
    holidayByDate.set(holiday.date, current ? `${current} · ${label}` : label);
  }
  const approvedLeaves = requests.filter(
    (request) =>
      request.status === "Approved" &&
      overlapsDateRange(
        request.startDate,
        request.endDate,
        monthStartIso,
        monthEndIso,
      ) &&
      inDepartment(request.department, request.employeeId, employees, department),
  );
  const approvedAuthz = authorizations.filter(
    (item) =>
      item.status === "Approved" &&
      overlapsDateRange(item.date, item.date, monthStartIso, monthEndIso) &&
      inDepartment(item.department, item.employeeId, employees, department),
  );
  const monthEvents = events.filter((event) =>
    overlapsDateRange(event.startDate, event.endDate, monthStartIso, monthEndIso),
  );
  const lead = (monthStart.getDay() + 6) % 7;
  const cells = Array.from({ length: lead + dayCount }, (_, index) => {
    if (index < lead) return null;
    const date = addMonthDay(monthStart, index - lead);
    return { iso: isoDate(date), day: index - lead + 1 };
  });
  const trail = (7 - (cells.length % 7)) % 7;
  const grid = [...cells, ...Array.from({ length: trail }, () => null)];
  const monthLabel = cursor.toLocaleDateString(dateLocale, {
    month: "long",
    year: "numeric",
  });
  const weekdays = [
    t("cal.mon"),
    t("cal.tue"),
    t("cal.wed"),
    t("cal.thu"),
    t("cal.fri"),
    t("cal.sat"),
    t("cal.sun"),
  ];
  const eyebrowLabel =
    eyebrow === "Admin / Planning"
      ? t("admin.planning")
      : eyebrow === "My workspace"
        ? t("employee.workspace")
        : eyebrow;

  return (
    <>
      <Header
        eyebrow={eyebrowLabel}
        title={screenLabel(t, "Team calendar")}
        action={
          canAddEvent ? (
            <Button onClick={() => setModal("event")}>
              <Plus size={16} /> {t("admin.addEvent")}
            </Button>
          ) : null
        }
      />
      <div className="card full-calendar">
        <div className="filter-bar">
          <button
            type="button"
            className="calendar-nav"
            aria-label={t("cal.prevMonth")}
            onClick={() => setCursor(new Date(year, monthIndex - 1, 1))}
          >
            <ChevronLeft size={16} />
          </button>
          <b className="calendar-month-label">{monthLabel}</b>
          <button
            type="button"
            className="calendar-nav"
            aria-label={t("cal.nextMonth")}
            onClick={() => setCursor(new Date(year, monthIndex + 1, 1))}
          >
            <ChevronRight size={16} />
          </button>
          {departments.length > 0 && (
            <select
              className="filter-select"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            >
              <option value="All">{t("admin.allDepartments")}</option>
              {departments.map((item) => (
                <option key={item.id} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
          <span className="calendar-legend">
            <i className="legend-leave" />
            {t("admin.legendLeave")} <i className="legend-authz" />
            {t("admin.legendAuthz")} <i className="legend-event" />
            {t("admin.legendHoliday")}
          </span>
        </div>
        <div className="month-weekdays">
          {weekdays.map((label) => (
            <div key={label}>{label}</div>
          ))}
        </div>
        <div className="month-grid">
          {grid.map((cell, index) => {
            if (!cell) {
              return <div className="month-cell is-outside" key={`empty-${index}`} />;
            }
            const holiday = holidayByDate.get(cell.iso);
            const dayEvents = monthEvents.filter((event) =>
              overlapsDateRange(event.startDate, event.endDate, cell.iso, cell.iso),
            );
            const chips = dayAwayChips(
              cell.iso,
              approvedLeaves,
              approvedAuthz,
              employees,
              t("admin.legendAuthz"),
            );
            return (
              <div
                key={cell.iso}
                className={`month-cell${cell.iso === todayIso ? " is-today" : ""}${holiday ? " is-holiday" : ""}`}
              >
                <div className="month-cell-head">
                  <b>{cell.day}</b>
                  {holiday && <span title={holiday}>{holiday}</span>}
                </div>
                {dayEvents.map((event) => (
                  <span className="calendar-chip event-bar" key={event.id}>
                    {event.title}
                  </span>
                ))}
                {chips.map((chip) => (
                  <span
                    key={chip.id}
                    className={`calendar-chip ${chip.className}`}
                    title={chip.title}
                  >
                    {chip.label}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function addMonthDay(start: Date, days: number) {
  const next = new Date(start);
  next.setDate(next.getDate() + days);
  return next;
}

function inDepartment(
  fallback: string,
  employeeId: string,
  employees: Employee[],
  department: string,
) {
  if (department === "All") return true;
  const employee = employees.find((item) => item.id === employeeId);
  return (employee?.department ?? fallback) === department;
}

function dayAwayChips(
  iso: string,
  leaves: LeaveRequest[],
  auths: Authorization[],
  employees: Employee[],
  authzLabel: string,
) {
  const leaveChips = leaves
    .filter((request) => request.startDate <= iso && request.endDate >= iso)
    .map((request) => {
      const name =
        employees.find((item) => item.id === request.employeeId)?.name ??
        request.name;
      return {
        id: `leave-${request.id}`,
        className: `leave-bar ${leaveTypeTone(request.type)}`,
        label: `${firstName(name)} · ${request.type}`,
        title: `${name} · ${request.type} · ${request.dates}`,
      };
    });
  const authzChips = auths
    .filter((item) => item.date === iso)
    .map((item) => {
      const name =
        employees.find((person) => person.id === item.employeeId)?.name ??
        item.name;
      return {
        id: `authz-${item.id}`,
        className: "authz-bar",
        label: `${firstName(name)} · ${item.durationLabel}`,
        title: `${name} · ${authzLabel} · ${item.durationLabel}`,
      };
    });
  return [...leaveChips, ...authzChips];
}

function Analytics({
  requests,
  employees,
}: {
  requests: LeaveRequest[];
  employees: Employee[];
}) {
  const { t, dateLocale } = useLanguage();
  const year = new Date().getFullYear();
  const yearPrefix = String(year);
  const thisYear = requests.filter((request) =>
    request.startDate.startsWith(yearPrefix),
  );
  const approved = thisYear.filter((request) => request.status === "Approved");
  const decided = thisYear.filter((request) => request.status !== "Pending");
  const daysTaken = approved.reduce(
    (total, request) =>
      total + requestedLeaveDays(request.startDate, request.endDate),
    0,
  );
  const entitlement = employees
    .filter((employee) => employee.status === "Active")
    .reduce((total, employee) => {
      const monthly = employee.monthlyLeaveDays ?? DEFAULT_MONTHLY_LEAVE_DAYS;
      return total + monthly * 12;
    }, 0);
  const utilization =
    entitlement > 0 ? Math.round((daysTaken / entitlement) * 100) : 0;
  const average =
    approved.length > 0 ? daysTaken / approved.length : 0;
  const approvalRate =
    decided.length > 0
      ? Math.round((approved.length / decided.length) * 100)
      : 0;
  const pending = requests.filter(
    (request) => request.status === "Pending",
  ).length;
  const monthDays = Array.from({ length: 12 }, (_, index) => {
    const month = `${yearPrefix}-${String(index + 1).padStart(2, "0")}`;
    return approved
      .filter((request) => request.startDate.startsWith(month))
      .reduce(
        (total, request) =>
          total + requestedLeaveDays(request.startDate, request.endDate),
        0,
      );
  });
  const maxMonth = Math.max(...monthDays, 1);
  const monthNames = Array.from({ length: 12 }, (_, index) =>
    new Date(year, index, 1).toLocaleDateString(dateLocale, { month: "short" }),
  );

  return (
    <>
      <Header
        eyebrow={t("admin.insights")}
        title={screenLabel(t, "Analytics")}
        action={null}
      />
      <div className="metric-grid">
        <Metric
          label={t("admin.utilization")}
          value={`${utilization}%`}
          note={t("admin.utilizationNote", {
            taken: daysTaken,
            entitled: Math.round(entitlement),
          })}
          tone="indigo"
          icon={<Activity size={19} />}
        />
        <Metric
          label={t("admin.average")}
          value={approved.length === 0 ? "0d" : `${average.toFixed(1)}d`}
          note={t("admin.averageNote", { count: approved.length })}
          tone="teal"
          icon={<Clock3 size={19} />}
        />
        <Metric
          label={t("admin.approvalRate")}
          value={`${approvalRate}%`}
          note={t("admin.approvalRateNote", {
            approved: approved.length,
            decided: decided.length,
          })}
          tone="amber"
          icon={<Check size={19} />}
        />
        <Metric
          label={t("admin.pendingApprovals")}
          value={String(pending)}
          note={t("admin.openRequests")}
          tone="rose"
          icon={<Activity size={19} />}
        />
      </div>
      <div className="card chart-card">
        <div className="card-heading">
          <h2>{t("admin.daysByMonth")}</h2>
          <span>{year}</span>
        </div>
        {daysTaken === 0 ? (
          <div className="table-empty">{t("admin.noApproved")}</div>
        ) : (
          <div className="month-chart" role="img" aria-label={t("admin.daysByMonth")}>
            {monthDays.map((days, index) => (
              <div
                key={`${year}-${index}`}
                title={`${monthNames[index]}: ${formatDaysLabel(t, days)}`}
              >
                <span style={{ height: `${Math.max(6, (days / maxMonth) * 100)}%` }} />
                <small>
                  {monthNames[index]}
                  {days > 0 ? ` · ${days}` : ""}
                </small>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function SettingsView({
  leaveTypes,
  departments,
  employees,
  flash,
}: {
  leaveTypes: LeaveType[];
  departments: Department[];
  employees: Employee[];
  flash: (message: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState("Company Profile");
  const settingsTabs = [
    { id: "Company Profile", label: t("admin.companyProfile") },
    { id: "Leave Policy", label: t("admin.leavePolicy") },
    { id: "Attendance", label: t("nav.attendance") },
    { id: "Departments", label: screenLabel(t, "Departments") },
    { id: "Roles & Permissions", label: t("admin.roles") },
  ];
  const tabLabel =
    settingsTabs.find((item) => item.id === tab)?.label ?? tab;

  return (
    <>
      <Header
        eyebrow={t("admin.settingsEyebrow")}
        title={screenLabel(t, "Settings")}
        action={null}
      />
      <div className="card settings-card">
        <nav className="settings-nav">
          {settingsTabs.map((item) => (
            <button
              className={tab === item.id ? "active" : ""}
              key={item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-form">
          <p className="eyebrow">{t("admin.configuration")}</p>
          <h2>{tabLabel}</h2>
          {tab === "Company Profile" && (
            <>
              <Field label={t("admin.companyName")} value="Kachabiti" readOnly />
              <p className="page-subtitle">{t("admin.brandingFixed")}</p>
            </>
          )}
          {tab === "Leave Policy" &&
            (leaveTypes.length === 0 ? (
              <p className="page-subtitle">{t("admin.noLeaveTypes")}</p>
            ) : (
              leaveTypes.map((type) => (
                <Field
                  key={type.id}
                  label={displayLeaveType(type.name)}
                  value={t("admin.policyDays", { days: type.defaultDays })}
                  readOnly
                />
              ))
            ))}
          {tab === "Attendance" && (
            <AttendanceScheduleSettings employees={employees} flash={flash} />
          )}
          {tab === "Roles & Permissions" &&
            [
              t("admin.roleAdmin"),
              t("admin.roleManager"),
              t("admin.roleEmployee"),
            ].map((item) => (
              <div className="permission-row" key={item}>
                <ShieldCheck size={16} />
                {item}
              </div>
            ))}
          {tab === "Departments" &&
            (departments.length === 0 ? (
              <p className="page-subtitle">{t("admin.noDepartments")}</p>
            ) : (
              departments.map((department) => (
                <Field
                  key={department.id}
                  label={department.name}
                  value={t("admin.deptRow", {
                    count: department.count,
                    manager:
                      department.manager === "Unassigned"
                        ? t("department.unassigned")
                        : department.manager,
                  })}
                  readOnly
                />
              ))
            ))}
        </div>
      </div>
    </>
  );
}
