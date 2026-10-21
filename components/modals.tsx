"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Maximize2, Minimize2, Minus, Paperclip, Pencil, Plus, X } from "lucide-react";
import type {
  Authorization,
  Department,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
} from "@/lib/app-types";
import { EmployeeAttendance } from "@/components/attendance-views";
import { ContractSection, EmployeePayslips } from "@/components/payroll-views";
import { Avatar, Button, Field, ModernSelect, Status, useCompany } from "@/components/primitives";
import { formatLeaveDayCount } from "@/lib/leave-hours";
import { createClient } from "@/lib/supabase/client";
import {
  getLeaveAttachmentUrl,
  uploadLeaveAttachment,
} from "@/lib/leave-attachments";
import {
  authorizationBalance,
  authorizationMonthKey,
  approvedAuthorizationMinutes,
  DEFAULT_MONTHLY_LEAVE_DAYS,
  displayLeaveType,
  displayValue,
  FIRST_PARENTAL_MONTHS,
  firstParentalLeave,
  formatClock,
  formatDisplayDate,
  formatDurationMinutes,
  initialsFromName,
  isoDate,
  isAnnualLeaveType,
  isParentalLeaveType,
  isSickLeaveType,
  isUnpaidLeaveType,
  leaveEndFromStart,
  minutesBetweenTimes,
  nextIsoDate,
  openingEmployeeSolde,
  parseMonthlyLeaveDays,
  requestedLeaveDays,
  SECOND_PARENTAL_MONTHS,
  shiftCalendarMonths,
  sickLeaveMinIsoDate,
  soldeFromStartDate,
  soldeGoesNegative,
  toDbRole,
  toDbStatus,
} from "@/lib/map-rows";
import { inviteEmployee } from "@/lib/invite-employee";
import { saveEmployeeSolde, updateEmployeeAccount } from "@/lib/employee-account";
import { uploadEmployeeAvatar } from "@/lib/employee-avatar";
import type { VacationFigure } from "@/lib/use-leave-hours";
import {
  formatDaysLabel,
  translateRole,
  translateStatus,
  useLanguage,
  useT,
  leaveTypeLabel,
} from "@/lib/i18n";

export function RequestModal({
  leaveTypes,
  balances,
  requests = [],
  employeeId,
  close,
  flash,
  onSubmitted,
}: {
  leaveTypes: LeaveType[];
  balances: LeaveBalance[];
  requests?: LeaveRequest[];
  employeeId: string | null;
  close: () => void;
  flash: (message: string, tone?: "success" | "error") => void;
  onSubmitted: () => void | Promise<void>;
}) {
  const [leaveTypeId, setLeaveTypeId] = useState(
    () =>
      leaveTypes.find((type) => isAnnualLeaveType(type))?.id ??
      leaveTypes[0]?.id ??
      "",
  );
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const t = useT();
  const leaveType = leaveTypes.find((type) => type.id === leaveTypeId) ?? null;
  const sick = Boolean(leaveType && isSickLeaveType(leaveType));
  const parental = Boolean(leaveType && isParentalLeaveType(leaveType));
  const firstParental = firstParentalLeave(requests, employeeId);
  const secondParental =
    parental && firstParental?.status === "Approved";
  const remaining =
    employeeId && leaveType
      ? (balances.find(
          (item) =>
            item.employeeId === employeeId && item.leaveTypeId === leaveType.id,
        )?.daysRemaining ?? 0)
      : 0;
  const requested =
    startDate && endDate && endDate >= startDate
      ? requestedLeaveDays(startDate, endDate)
      : 0;
  const advance =
    leaveType &&
    !isUnpaidLeaveType(leaveType) &&
    !sick &&
    !parental &&
    requested > 0 &&
    soldeGoesNegative(remaining, requested);
  const nextSolde = remaining - requested;
  const sickMin = sick ? sickLeaveMinIsoDate() : undefined;
  const parentalEnd = startDate
    ? leaveEndFromStart(
        startDate,
        secondParental ? SECOND_PARENTAL_MONTHS : FIRST_PARENTAL_MONTHS,
      )
    : "";
  const secondStart = firstParental
    ? nextIsoDate(firstParental.endDate)
    : "";

  useEffect(() => {
    if (!parental || !startDate) return;
    const maxEnd = leaveEndFromStart(
      startDate,
      secondParental ? SECOND_PARENTAL_MONTHS : FIRST_PARENTAL_MONTHS,
    );
    if (secondParental) {
      setEndDate((current) =>
        !current || current > maxEnd || current < startDate ? maxEnd : current,
      );
      return;
    }
    setEndDate(maxEnd);
  }, [parental, secondParental, startDate]);

  const chooseType = (id: string) => {
    setLeaveTypeId(id);
    const type = leaveTypes.find((item) => item.id === id);
    if (type && isSickLeaveType(type)) {
      const min = sickLeaveMinIsoDate();
      setStartDate((value) => (value && value < min ? "" : value));
      setEndDate((value) => (value && value < min ? "" : value));
    } else {
      setFile(null);
    }
    if (type && isParentalLeaveType(type)) {
      const existing = firstParentalLeave(requests, employeeId);
      if (existing?.status === "Approved") {
        setStartDate(nextIsoDate(existing.endDate));
      }
    }
  };

  const submit = async () => {
    if (saving) return;
    if (!leaveTypeId) {
      flash(t("modal.chooseType"), "error");
      return;
    }
    if (!startDate || !endDate) {
      flash(t("modal.chooseDates"), "error");
      return;
    }
    if (endDate < startDate) {
      flash(t("modal.endAfterStart"), "error");
      return;
    }
    if (sick && startDate < sickLeaveMinIsoDate()) {
      flash(t("modal.sick48h"), "error");
      return;
    }
    if (parental && firstParental?.status === "Pending") {
      flash(t("modal.parentalPending"), "error");
      return;
    }
    if (secondParental) {
      if (startDate !== secondStart) {
        flash(t("modal.parentalSecondStart"), "error");
        return;
      }
      if (endDate > parentalEnd) {
        flash(t("modal.parentalSecondMax"), "error");
        return;
      }
      const deadline = shiftCalendarMonths(firstParental.endDate, -1);
      if (deadline && isoDate() > deadline) {
        flash(t("modal.parentalDeadline"), "error");
        return;
      }
    }

    setSaving(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      flash(t("profile.mustSignIn"), "error");
      return;
    }

    let attachmentPath: string | null = null;
    let attachmentName: string | null = null;
    if (sick && file) {
      const payload = new FormData();
      payload.append("file", file);
      const uploaded = await uploadLeaveAttachment(payload);
      if (uploaded.error) {
        setSaving(false);
        flash(uploaded.error, "error");
        return;
      }
      attachmentPath = uploaded.path;
      attachmentName = uploaded.name;
    }

    const { error } = await supabase.from("leave_requests").insert({
      employee_id: user.id,
      leave_type_id: leaveTypeId,
      start_date: startDate,
      end_date: endDate,
      reason: reason.trim() || null,
      status: "pending",
      attachment_path: attachmentPath,
      attachment_name: attachmentName,
    });

    if (error) {
      setSaving(false);
      flash(error.message, "error");
      return;
    }

    await onSubmitted();
    setSaving(false);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Close when the press starts on the backdrop itself, not inside the dialog.
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="modal card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <p className="eyebrow">{t("modal.timeAway")}</p>
        <h2>{t("modal.requestLeave")}</h2>
        {advance && (
          <p className="solde-alert" role="alert">
            {remaining <= 0
              ? t("modal.noSolde", { remaining, next: nextSolde })
              : t("modal.exceedsSolde", { remaining, next: nextSolde })}
          </p>
        )}
        {sick && (
          <p className="leave-policy-alert" role="status">
            <b>{t("modal.sickPolicy")}</b>
            {t("modal.sickBody", { remaining })}
          </p>
        )}
        {parental && (
          <p className="leave-policy-alert" role="status">
            <b>{t("modal.parentalPolicy")}</b>
            {t("modal.parentalBody")}
          </p>
        )}
        <label className="form-label">
          {t("modal.leaveType")}
          <ModernSelect
            block
            ariaLabel={t("modal.leaveType")}
            value={leaveTypeId}
            onChange={chooseType}
            options={
              leaveTypes.length === 0
                ? [{ value: "", label: t("modal.noTypes") }]
                : leaveTypes
                    .filter((type) => type.active !== false || type.id === leaveTypeId)
                    .map((type) => ({
                      value: type.id,
                      label: leaveTypeLabel(t, type.name),
                    }))
            }
          />
        </label>
        <div className="form-row">
          <Field
            label={t("modal.startDate")}
            name="start_date"
            type="date"
            value={startDate}
            min={sick ? sickMin : secondParental ? secondStart : undefined}
            max={secondParental ? secondStart : undefined}
            readOnly={secondParental}
            onChange={setStartDate}
          />
          <Field
            label={t("modal.endDate")}
            name="end_date"
            type="date"
            value={endDate}
            min={sick ? sickMin : parental ? startDate || undefined : undefined}
            max={parental ? parentalEnd || undefined : undefined}
            readOnly={parental && !secondParental}
            onChange={setEndDate}
          />
        </div>
        <label className="form-label">
          {t("modal.reason")}
          <textarea
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("modal.reasonPlaceholder")}
          />
        </label>
        {sick && (
          <label className="form-label">
            {t("modal.attachment")}
            <input
              type="file"
              accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <small>
              <Paperclip size={12} />{" "}
              {file ? file.name : t("modal.attachmentHint")}
            </small>
          </label>
        )}
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button>{saving ? t("modal.submitting") : t("modal.submitRequest")}</Button>
        </div>
      </form>
    </div>
  );
}

export function AuthorizationModal({
  close,
  flash,
  onSubmitted,
  authorizations,
  currentEmployeeId,
}: {
  close: () => void;
  flash: (message: string, tone?: "success" | "error") => void;
  onSubmitted: () => void | Promise<void>;
  authorizations: Authorization[];
  currentEmployeeId: string | null;
}) {
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const { t, dateLocale } = useLanguage();
  const durationMinutes =
    startTime && endTime ? minutesBetweenTimes(startTime, endTime) : 0;
  const usedMinutes = currentEmployeeId
    ? approvedAuthorizationMinutes(
        authorizations,
        currentEmployeeId,
        date ? authorizationMonthKey(date) : undefined,
      )
    : 0;
  const monthBalance = authorizationBalance(usedMinutes);

  const submit = async () => {
    if (saving) return;
    if (!date) {
      flash(t("modal.chooseDate"), "error");
      return;
    }
    if (!startTime || !endTime) {
      flash(t("modal.chooseTimes"), "error");
      return;
    }
    if (durationMinutes <= 0) {
      flash(t("modal.endTimeAfter"), "error");
      return;
    }
    if (!reason.trim()) {
      flash(t("modal.addReason"), "error");
      return;
    }

    setSaving(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      flash(t("profile.mustSignIn"), "error");
      return;
    }

    const { error } = await supabase.from("authorizations").insert({
      employee_id: user.id,
      date,
      start_time: startTime,
      end_time: endTime,
      duration_minutes: durationMinutes,
      reason: reason.trim(),
      status: "pending",
    });

    if (error) {
      setSaving(false);
      flash(error.message, "error");
      return;
    }

    await onSubmitted();
    setSaving(false);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Close when the press starts on the backdrop itself, not inside the dialog.
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="modal card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <p className="eyebrow">{t("modal.authzEyebrow")}</p>
        <h2>{t("modal.authzTitle")}</h2>
        <p className="page-subtitle">{t("modal.authzSubtitle")}</p>
        <div className="request-solde">
          <div>
            <span>{t("employee.used")}</span>
            <b>{monthBalance.usedDurationLabel}</b>
          </div>
          <div>
            <span>{t("employee.ifNotPunched")}</span>
            <b>
              {durationMinutes > 0
                ? formatLeaveDayCount(durationMinutes / 480, dateLocale)
                : t("common.dash")}
            </b>
          </div>
          <div>
            <span>{t("modal.thisRequest")}</span>
            <b>
              {durationMinutes > 0
                ? formatDurationMinutes(durationMinutes)
                : t("common.dash")}
            </b>
          </div>
        </div>
        <Field
          label={t("modal.whichDay")}
          name="date"
          type="date"
          value={date}
          onChange={setDate}
        />
        <div className="form-row">
          <Field
            label={t("modal.from")}
            name="start_time"
            type="time"
            value={startTime}
            onChange={setStartTime}
          />
          <Field
            label={t("modal.until")}
            name="end_time"
            type="time"
            value={endTime}
            onChange={setEndTime}
          />
        </div>
        <label className="form-label">
          {t("modal.whyLeave")}
          <textarea
            name="reason"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("modal.authzPlaceholder")}
          />
        </label>
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button>{saving ? t("modal.sending") : t("modal.submitAuthz")}</Button>
        </div>
      </form>
    </div>
  );
}

export function EventModal({
  close,
  flash,
  onSaved,
}: {
  close: () => void;
  flash: (message: string, tone?: "success" | "error") => void;
  onSaved: () => void | Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [type, setType] = useState("Company Holiday");
  const [saving, setSaving] = useState(false);
  const t = useT();

  const submit = async () => {
    if (saving) return;
    if (!title.trim()) {
      flash(t("modal.addEventTitle"), "error");
      return;
    }
    if (!startDate || !endDate) {
      flash(t("modal.chooseDates"), "error");
      return;
    }
    if (endDate < startDate) {
      flash(t("modal.endAfterStart"), "error");
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from("events").insert({
      title: title.trim(),
      start_date: startDate,
      end_date: endDate,
      type,
    });
    if (error) {
      setSaving(false);
      flash(error.message, "error");
      return;
    }
    await onSaved();
    setSaving(false);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Close when the press starts on the backdrop itself, not inside the dialog.
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="modal card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <p className="eyebrow">{t("modal.eventEyebrow")}</p>
        <h2>{t("modal.eventTitle")}</h2>
        <Field label={t("modal.eventName")} value={title} onChange={setTitle} />
        <div className="form-row">
          <Field
            label={t("modal.startDate")}
            type="date"
            value={startDate}
            onChange={setStartDate}
          />
          <Field
            label={t("modal.endDate")}
            type="date"
            value={endDate}
            onChange={setEndDate}
          />
        </div>
        <label className="form-label">
          {t("modal.eventType")}
          <ModernSelect
            block
            ariaLabel={t("modal.eventType")}
            value={type}
            onChange={setType}
            options={[
              { value: "Company Holiday", label: t("modal.companyHoliday") },
              { value: "Team Event", label: t("modal.teamEvent") },
              { value: "Other", label: t("modal.other") },
            ]}
          />
        </label>
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button>{saving ? t("modal.saving") : t("modal.saveEvent")}</Button>
        </div>
      </form>
    </div>
  );
}

export function DepartmentModal({
  employees,
  department = null,
  close,
  flash,
  onSaved,
}: {
  employees: Employee[];
  department?: Department | null;
  close: () => void;
  flash: (message: string, tone?: "success" | "error") => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(department?.name ?? "");
  const [managerId, setManagerId] = useState(department?.managerId ?? "");
  const [saving, setSaving] = useState(false);
  const t = useT();
  const editing = Boolean(department);

  const submit = async () => {
    if (saving) return;
    if (!name.trim()) {
      flash(t("modal.addDeptName"), "error");
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const payload = {
      name: name.trim(),
      manager_id: managerId || null,
    };
    const { error } = department
      ? await supabase.from("departments").update(payload).eq("id", department.id)
      : await supabase.from("departments").insert(payload);
    if (error) {
      setSaving(false);
      flash(error.message, "error");
      return;
    }
    await onSaved();
    setSaving(false);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Close when the press starts on the backdrop itself, not inside the dialog.
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="modal card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <p className="eyebrow">{t("modal.deptEyebrow")}</p>
        <h2>{editing ? t("modal.editDeptTitle") : t("modal.deptTitle")}</h2>
        <label className="form-label">
          {t("modal.deptName")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("modal.deptName")}
          />
        </label>
        <label className="form-label">
          {t("modal.assignManager")}
          <ModernSelect
            block
            ariaLabel={t("modal.assignManager")}
            value={managerId}
            onChange={setManagerId}
            options={[
              { value: "", label: t("department.unassigned") },
              ...employees.map((employee) => ({
                value: employee.id,
                label: employee.name,
              })),
            ]}
          />
        </label>
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button>
            {saving
              ? editing
                ? t("modal.saving")
                : t("modal.adding")
              : editing
                ? t("common.save")
                : t("modal.deptTitle")}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function EmployeeModal({
  departments,
  close,
  flash,
  onInvited,
}: {
  departments: Department[];
  close: () => void;
  flash: (message: string, tone?: "success" | "error") => void;
  onInvited: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [startDate, setStartDate] = useState("");
  const company = useCompany();
  const [monthlyLeaveDays, setMonthlyLeaveDays] = useState(
    String(company?.monthlyLeaveDays ?? DEFAULT_MONTHLY_LEAVE_DAYS),
  );
  const [role, setRole] = useState("Employee");
  const [saving, setSaving] = useState(false);
  const t = useT();

  const submit = async () => {
    if (saving) return;
    if (!name.trim() || !email.trim()) {
      flash(t("modal.nameEmailRequired"), "error");
      return;
    }

    setSaving(true);
    const error = await inviteEmployee({
      name,
      email,
      jobTitle,
      departmentId,
      startDate,
      monthlyLeaveDays,
      role,
    });
    if (error) {
      setSaving(false);
      flash(error, "error");
      return;
    }

    await onInvited();
    setSaving(false);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Close when the press starts on the backdrop itself, not inside the dialog.
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="modal card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <p className="eyebrow">{t("modal.inviteEyebrow")}</p>
        <h2>{t("modal.inviteTitle")}</h2>
        <Field
          label={t("profile.fullName")}
          name="full_name"
          value={name}
          onChange={setName}
        />
        <Field
          label={t("profile.workEmail")}
          name="email"
          type="email"
          value={email}
          onChange={setEmail}
        />
        <Field
          label={t("profile.jobTitle")}
          name="job_title"
          value={jobTitle}
          onChange={setJobTitle}
        />
        <div className="form-row">
          <label className="form-label">
            {t("profile.department")}
            <ModernSelect
              block
              ariaLabel={t("profile.department")}
              value={departmentId}
              onChange={setDepartmentId}
              options={[
                { value: "", label: t("department.unassigned") },
                ...departments.map((department) => ({
                  value: department.id,
                  label: department.name,
                })),
              ]}
            />
          </label>
          <label className="form-label">
            {t("profile.role")}
            <ModernSelect
              block
              ariaLabel={t("profile.role")}
              value={role}
              onChange={setRole}
              options={[
                { value: "Employee", label: translateRole(t, "Employee") },
                { value: "Manager", label: translateRole(t, "Manager") },
                { value: "Administrator", label: translateRole(t, "Administrator") },
              ]}
            />
          </label>
        </div>
        <Field
          label={t("profile.startDate")}
          name="start_date"
          type="date"
          value={startDate}
          onChange={setStartDate}
        />
        <Field
          label={t("profile.monthlyDays")}
          name="monthly_leave_days"
          type="number"
          step="0.01"
          value={monthlyLeaveDays}
          onChange={setMonthlyLeaveDays}
        />
        <p className="page-subtitle">{t("modal.inviteNote")}</p>
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button>{saving ? t("modal.sending") : t("modal.sendInvite")}</Button>
        </div>
      </form>
    </div>
  );
}

export function EmployeeDetail({
  employee,
  departments,
  leaveTypes,
  balances = [],
  vacation = null,
  canManagePayroll = false,
  canManageAccounts = false,
  close,
  flash,
  onSaved,
}: {
  employee: Employee;
  departments: Department[];
  leaveTypes: LeaveType[];
  balances?: LeaveBalance[];
  /** Ledger + time-clock accrual, from the vacation balance service. */
  vacation?: VacationFigure | null;
  canManagePayroll?: boolean;
  /** Admin: change the sign-in email and password. */
  canManageAccounts?: boolean;
  close: () => void;
  flash: (message: string, tone?: "success" | "error") => void;
  onSaved: (employee: Employee, balances: LeaveBalance[]) => void;
}) {
  const [name, setName] = useState(employee.name);
  const [email, setEmail] = useState(employee.email);
  const [phone, setPhone] = useState(employee.phone ?? "");
  const [jobTitle, setJobTitle] = useState(employee.jobTitle ?? "");
  const [departmentId, setDepartmentId] = useState(employee.departmentId ?? "");
  const [role, setRole] = useState(
    employee.role === "Administrator"
      ? "Administrator"
      : employee.role === "Manager"
        ? "Manager"
        : "Employee",
  );
  const [status, setStatus] = useState(
    employee.status === "Inactive" ? "Inactive" : "Active",
  );
  const [startDate, setStartDate] = useState(employee.startDate ?? "");
  const [monthlyLeaveDays, setMonthlyLeaveDays] = useState(
    String(employee.monthlyLeaveDays ?? DEFAULT_MONTHLY_LEAVE_DAYS),
  );
  const [solde, setSolde] = useState(() =>
    openingEmployeeSolde(
      leaveTypes,
      balances,
      employee.id,
      employee.startDate,
      employee.monthlyLeaveDays,
    ),
  );
  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const t = useT();
  const { dateLocale } = useLanguage();
  const [errors, setErrors] = useState<{
    name: string | null;
    email: string | null;
    monthly: string | null;
  }>({ name: null, email: null, monthly: null });
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [tab, setTab] = useState<EmployeeTab>("overview");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(DRAWER_EXPANDED_KEY) === "1") setExpanded(true);
    } catch {
      // Storage blocked: keep the side panel.
    }
  }, []);
  const toggleExpanded = () => {
    setExpanded((value) => {
      try {
        window.localStorage.setItem(DRAWER_EXPANDED_KEY, value ? "0" : "1");
      } catch {
        // Private mode: the choice just isn't remembered.
      }
      return !value;
    });
  };
  const snapshot = JSON.stringify([
    name,
    email,
    phone,
    jobTitle,
    departmentId,
    role,
    status,
    startDate,
    monthlyLeaveDays,
    solde,
  ]);
  const [baseline, setBaseline] = useState(snapshot);
  const dirty = snapshot !== baseline;
  const requestClose = () => {
    if (dirty) setConfirmingDiscard(true);
    else close();
  };

  useEffect(() => {
    if (!dirty) setConfirmingDiscard(false);
  }, [dirty]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dirty) setConfirmingDiscard(true);
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, close]);

  const uploadPhoto = async (file: File | null) => {
    if (!file || uploadingPhoto || saving) return;
    setUploadingPhoto(true);
    const payload = new FormData();
    payload.append("file", file);
    payload.append("employeeId", employee.id);
    try {
      const uploaded = await uploadEmployeeAvatar(payload);
      if (uploaded.error) {
        flash(uploaded.error, "error");
        return;
      }
      onSaved({ ...employee, avatarUrl: uploaded.url }, solde);
      flash(t("profile.photoUpdated"));
    } finally {
      setUploadingPhoto(false);
    }
  };

  const changePassword = async () => {
    if (savingPassword) return;
    if (newPassword.length < 8) return flash(t("panel.passwordShort"), "error");
    if (newPassword !== confirmPassword) return flash(t("panel.passwordMismatch"), "error");
    setSavingPassword(true);
    const message = await updateEmployeeAccount({ employeeId: employee.id, password: newPassword });
    setSavingPassword(false);
    if (message) return flash(message, "error");
    setNewPassword("");
    setConfirmPassword("");
    flash(t("panel.passwordChanged", { name: employee.name }));
  };

  const applyHireSolde = (nextStart: string, nextMonthly: string) => {
    setStartDate(nextStart);
    setMonthlyLeaveDays(nextMonthly);
    setSolde(
      soldeFromStartDate(
        leaveTypes,
        employee.id,
        nextStart || null,
        parseMonthlyLeaveDays(nextMonthly),
      ),
    );
  };

  const bumpSolde = (index: number, delta: number) => {
    setSolde((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index
          ? { ...row, daysRemaining: row.daysRemaining + delta }
          : row,
      ),
    );
  };

  const setSoldeValue = (index: number, value: string) => {
    const parsed = Number(value);
    setSolde((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index
          ? {
              ...row,
              daysRemaining: Number.isFinite(parsed) ? parsed : 0,
            }
          : row,
      ),
    );
  };

  const save = async () => {
    if (saving) return;
    const nextErrors = {
      name: name.trim() ? null : t("drawer.nameRequired"),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : t("drawer.emailInvalid"),
      monthly: Number.isFinite(Number(monthlyLeaveDays)) && Number(monthlyLeaveDays) > 0
        ? null
        : t("drawer.rateInvalid"),
    };
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.email) return setTab("profile");
    if (nextErrors.monthly) return setTab("employment");
    setSaving(true);
    // The sign-in email lives in Supabase Auth: change it there first.
    if (canManageAccounts && email.trim().toLowerCase() !== employee.email.trim().toLowerCase()) {
      const message = await updateEmployeeAccount({ employeeId: employee.id, email: email.trim() });
      if (message) {
        setSaving(false);
        flash(message, "error");
        return;
      }
    }
    const supabase = createClient();
    const departmentName =
      departments.find((department) => department.id === departmentId)?.name ??
      "Unassigned";
    const monthly = parseMonthlyLeaveDays(monthlyLeaveDays);
    const employeePatch = {
      full_name: name.trim(),
      email: email.trim(),
      phone: phone.trim() || null,
      job_title: jobTitle.trim() || null,
      department_id: departmentId || null,
      role: toDbRole(role),
      status: toDbStatus(status),
      start_date: startDate || null,
      monthly_leave_days: monthly,
    };
    let { error: employeeError } = await supabase
      .from("employees")
      .update(employeePatch)
      .eq("id", employee.id);

    if (employeeError?.message?.includes("monthly_leave_days")) {
      const { monthly_leave_days: _ignored, ...withoutMonthly } = employeePatch;
      employeeError = (
        await supabase
          .from("employees")
          .update(withoutMonthly)
          .eq("id", employee.id)
      ).error;
    }

    if (employeeError) {
      setSaving(false);
      flash(employeeError.message, "error");
      return;
    }

    if (solde.length) {
      const soldeError = await saveEmployeeSolde({
        employeeId: employee.id,
        rows: solde.map((row) => ({
          leaveTypeId: row.leaveTypeId,
          daysRemaining: row.daysRemaining,
        })),
      });

      if (soldeError) {
        setSaving(false);
        flash(soldeError, "error");
        return;
      }
    }

    const nextEmployee: Employee = {
      ...employee,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim() || null,
      jobTitle: jobTitle.trim() || null,
      department: departmentName,
      departmentId: departmentId || null,
      role,
      status,
      startDate: startDate || null,
      monthlyLeaveDays: monthly,
      initials: initialsFromName(name.trim()),
    };
    onSaved(nextEmployee, solde);
    setBaseline(snapshot);
    flash(t("panel.saved"));
    setSaving(false);
  };

  const departmentName =
    departments.find((department) => department.id === departmentId)?.name ??
    employee.department;
  const departmentLabel =
    departmentName === "Unassigned" ? t("department.unassigned") : departmentName;
  const tabs: { id: EmployeeTab; label: string; invalid?: boolean }[] = [
    { id: "overview", label: t("drawer.tabOverview") },
    { id: "profile", label: t("drawer.profile"), invalid: Boolean(errors.name || errors.email) },
    { id: "employment", label: t("profile.employment"), invalid: Boolean(errors.monthly) },
    { id: "balance", label: t("drawer.tabBalance") },
    { id: "attendance", label: t("drawer.tabAttendance") },
    ...(canManagePayroll
      ? [
          { id: "payslips" as const, label: t("drawer.tabPayslips") },
          { id: "contract" as const, label: t("drawer.tabContract") },
        ]
      : []),
  ];
  const panelProps = (id: EmployeeTab) => ({
    role: "tabpanel",
    id: `employee-panel-${id}`,
    "aria-labelledby": `employee-tab-${id}`,
    hidden: tab !== id,
  });
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((item) => item.id === tab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + tabs.length) %
            tabs.length;
    setTab(tabs[next].id);
    document.getElementById(`employee-tab-${tabs[next].id}`)?.focus();
  };

  return (
    <>
      <div className="side-panel-backdrop" onMouseDown={requestClose} aria-hidden="true" />
      <aside
        className={`side-panel drawer${expanded ? " is-expanded" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="employee-drawer-title"
      >
        <header className="drawer-header">
          <EmployeeProfileHeader
            employee={employee}
            name={name || employee.name}
            jobTitle={jobTitle}
            department={departmentLabel}
            role={role}
            status={status}
            startDate={startDate}
            uploadingPhoto={uploadingPhoto}
            onPickPhoto={() => {
              if (uploadingPhoto || saving) return;
              photoInput.current?.click();
            }}
          />
          <input
            ref={photoInput}
            className="profile-photo-input"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              void uploadPhoto(file);
            }}
          />
          <div className="drawer-header-actions">
            <button
              type="button"
              className="drawer-icon-button"
              aria-label={expanded ? t("drawer.collapse") : t("drawer.expand")}
              title={expanded ? t("drawer.collapse") : t("drawer.expand")}
              onClick={toggleExpanded}
            >
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button
              type="button"
              className="drawer-icon-button"
              aria-label={t("drawer.close")}
              title={t("drawer.close")}
              onClick={requestClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="drawer-main">
        <div
          className="drawer-tabs"
          role="tablist"
          aria-label={t("drawer.sections")}
          aria-orientation={expanded ? "vertical" : "horizontal"}
          onKeyDown={onTabKey}
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`employee-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`employee-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={`drawer-tab${tab === item.id ? " is-active" : ""}`}
              title={item.label}
              onClick={() => setTab(item.id)}
            >
              <span className="drawer-tab-label">{item.label}</span>
              {item.invalid && <span className="drawer-tab-alert" aria-label={t("drawer.tabHasError")} />}
            </button>
          ))}
        </div>

        <div className="drawer-body employee-edit-form">
          <section className="drawer-overview" {...panelProps("overview")}>
            <div className="overview-highlight">
              <span>{t("drawer.annualNow")}</span>
              <b>
                {vacation ? (
                  <>
                    {formatLeaveDayCount(vacation.balanceDays, dateLocale, 2)}{" "}
                    <small>{t("panel.daysShort")}</small>
                  </>
                ) : (
                  t("common.dash")
                )}
              </b>
              <em>
                {t("drawer.ratePerMonth", {
                  days: formatLeaveDayCount(Number(monthlyLeaveDays) || 0, dateLocale),
                })}
              </em>
            </div>
            <OverviewGroup
              title={t("profile.contact")}
              onEdit={() => setTab("profile")}
              rows={[
                [t("profile.workEmail"), email],
                [t("profile.phone"), displayValue(phone)],
              ]}
            />
            <OverviewGroup
              title={t("profile.employment")}
              onEdit={() => setTab("employment")}
              rows={[
                [t("profile.jobTitle"), displayValue(jobTitle)],
                [t("profile.department"), departmentLabel],
                [t("profile.role"), translateRole(t, role)],
                [t("profile.status"), translateStatus(t, status)],
                [
                  t("profile.startDate"),
                  startDate ? formatDisplayDate(startDate, dateLocale) : t("common.dash"),
                ],
              ]}
            />
            {solde.length > 0 && (
              <OverviewGroup
                title={t("drawer.tabBalance")}
                onEdit={() => setTab("balance")}
                rows={solde.map((row) => [
                  leaveTypeLabel(t, row.typeName),
                  `${formatLeaveDayCount(row.daysRemaining, dateLocale, 2)}\u00a0${t("panel.daysShort")}`,
                ])}
              />
            )}
          </section>

          <section className="detail-block drawer-section" {...panelProps("profile")}>
            <p className="eyebrow">{t("drawer.profile")}</p>
            <div className="drawer-grid">
              <Field
                label={t("profile.fullName")}
                name="full_name"
                value={name}
                onChange={setName}
                required
                error={errors.name}
              />
              <Field
                label={t("profile.jobTitle")}
                name="job_title"
                value={jobTitle}
                onChange={setJobTitle}
              />
              <Field
                label={t("profile.workEmail")}
                name="email"
                value={email}
                onChange={canManageAccounts ? setEmail : undefined}
                readOnly={!canManageAccounts}
                required={canManageAccounts}
                hint={canManageAccounts ? t("panel.emailNote") : undefined}
                error={errors.email}
              />
              <Field label={t("profile.phone")} name="phone" value={phone} onChange={setPhone} />
            </div>
          </section>

          {canManageAccounts && (
            <section className="detail-block drawer-section drawer-subsection" hidden={tab !== "profile"}>
              <p className="eyebrow">{t("panel.accountTitle")}</p>
              <span className="field-hint">{t("panel.accountNote")}</span>
              <div className="drawer-grid">
                <Field
                  label={t("panel.newPassword")}
                  name="new_password"
                  type="password"
                  value={newPassword}
                  onChange={setNewPassword}
                />
                <Field
                  label={t("panel.confirmPassword")}
                  name="confirm_password"
                  type="password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                />
              </div>
              <div className="drawer-inline-action">
                <span className="field-hint">{t("drawer.savedSeparately")}</span>
                <Button
                  secondary
                  busy={savingPassword}
                  disabled={!newPassword}
                  onClick={() => void changePassword()}
                >
                  {t("panel.setPassword")}
                </Button>
              </div>
            </section>
          )}

          <section className="detail-block drawer-section" {...panelProps("employment")}>
            <p className="eyebrow">{t("profile.employment")}</p>
            <div className="drawer-grid">
              <label className="form-label">
                <span className="form-label-text">{t("profile.department")}</span>
                <ModernSelect
                  block
                  ariaLabel={t("profile.department")}
                  value={departmentId}
                  onChange={setDepartmentId}
                  options={[
                    { value: "", label: t("department.unassigned") },
                    ...departments.map((department) => ({
                      value: department.id,
                      label: department.name,
                    })),
                  ]}
                />
              </label>
              <label className="form-label">
                <span className="form-label-text">{t("profile.role")}</span>
                <ModernSelect
                  block
                  ariaLabel={t("profile.role")}
                  value={role}
                  onChange={setRole}
                  options={[
                    { value: "Employee", label: translateRole(t, "Employee") },
                    { value: "Manager", label: translateRole(t, "Manager") },
                    { value: "Administrator", label: translateRole(t, "Administrator") },
                  ]}
                />
              </label>
            </div>
            <div className="form-label">
              <span className="form-label-text" id="employee-status-label">
                {t("profile.status")}
              </span>
              <div
                className="segmented"
                role="radiogroup"
                aria-labelledby="employee-status-label"
              >
                {(["Active", "Inactive"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={status === value}
                    className={status === value ? "is-active" : undefined}
                    onClick={() => setStatus(value)}
                  >
                    <span className={`segmented-dot is-${value.toLowerCase()}`} />
                    {translateStatus(t, value)}
                  </button>
                ))}
              </div>
              <span className="field-hint">{t("drawer.statusHint")}</span>
            </div>
            <div className="drawer-grid">
              <Field
                label={t("profile.startDate")}
                name="start_date"
                type="date"
                value={startDate}
                onChange={(value) => applyHireSolde(value, monthlyLeaveDays)}
              />
              <Field
                label={t("profile.monthlyDays")}
                name="monthly_leave_days"
                type="number"
                step="0.01"
                min="0"
                value={monthlyLeaveDays}
                onChange={(value) => applyHireSolde(startDate, value)}
                error={errors.monthly}
              />
            </div>
            <span className="field-hint">{t("panel.rateNote")}</span>
          </section>

          <section className="detail-block drawer-section" {...panelProps("balance")}>
            <p className="eyebrow">{t("drawer.tabBalance")}</p>
            <p className="page-subtitle">{t("panel.soldeNote")}</p>
            {solde.length === 0 ? (
              <span className="field-hint">{t("panel.noTypes")}</span>
            ) : (
              solde.map((row, index) => (
                <div className="solde-adjust" key={`${row.leaveTypeId}-${row.typeName}-${index}`}>
                  <span>
                    {leaveTypeLabel(t, row.typeName)}
                    {isAnnualLeaveType({ name: row.typeName }) && (
                      <small className="solde-opening-label">{t("panel.openingLabel")}</small>
                    )}
                  </span>
                  <div>
                    <button
                      type="button"
                      aria-label={t("panel.decrease", { name: row.typeName })}
                      onClick={(event) => {
                        event.preventDefault();
                        bumpSolde(index, -1);
                      }}
                    >
                      <Minus size={14} />
                    </button>
                    <input
                      type="number"
                      name={`solde-${row.leaveTypeId || index}`}
                      step={1}
                      value={row.daysRemaining}
                      aria-label={leaveTypeLabel(t, row.typeName)}
                      onChange={(event) => setSoldeValue(index, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                    />
                    <button
                      type="button"
                      aria-label={t("panel.increase", { name: row.typeName })}
                      onClick={(event) => {
                        event.preventDefault();
                        bumpSolde(index, 1);
                      }}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
            {vacation && (
              <div className="solde-accrual">
                <div><span>{t("panel.accrualEarned")}</span><b>{formatLeaveDayCount(vacation.earnedDays ?? 0, dateLocale)} {t("panel.daysShort")}</b></div>
                <div className="is-total"><span>{t("panel.accrualTotal")}</span><b>{formatLeaveDayCount(vacation.balanceDays, dateLocale)} {t("panel.daysShort")}</b></div>
                <small>{t("panel.accrualNote")}</small>
              </div>
            )}
          </section>


          <div {...panelProps("attendance")}>
            {tab === "attendance" && <EmployeeAttendance employeeId={employee.id} />}
          </div>
          {canManagePayroll && (
            <div {...panelProps("payslips")}>
              {tab === "payslips" && <EmployeePayslips employeeId={employee.id} flash={flash} />}
            </div>
          )}
          {canManagePayroll && (
            <div {...panelProps("contract")}>
              <ContractSection employeeId={employee.id} flash={flash} />
            </div>
          )}
        </div>
        </div>

        <footer className="drawer-footer">
          {confirmingDiscard ? (
            <>
              <span className="drawer-footer-note is-warning">{t("drawer.discardQuestion")}</span>
              <Button secondary onClick={() => setConfirmingDiscard(false)}>
                {t("drawer.keepEditing")}
              </Button>
              <button type="button" className="danger-button" onClick={close}>
                {t("drawer.discard")}
              </button>
            </>
          ) : (
            <>
              <span className={`drawer-footer-note${dirty ? " is-dirty" : ""}`}>
                {dirty ? t("drawer.unsaved") : t("drawer.noChanges")}
              </span>
              <Button secondary onClick={requestClose}>
                {t("common.cancel")}
              </Button>
              <Button busy={saving} disabled={!dirty} onClick={() => void save()}>
                {t("panel.saveChanges")}
              </Button>
            </>
          )}
        </footer>
      </aside>
    </>
  );
}

type EmployeeTab =
  | "overview"
  | "profile"
  | "employment"
  | "balance"
  | "attendance"
  | "payslips"
  | "contract";

const DRAWER_EXPANDED_KEY = "employee-drawer-expanded";

/** Read-only facts with a shortcut to the tab where they are edited. */
function OverviewGroup({
  title,
  rows,
  onEdit,
}: {
  title: string;
  rows: [string, string][];
  onEdit: () => void;
}) {
  const t = useT();
  return (
    <div className="overview-group">
      <div className="overview-group-head">
        <h3>{title}</h3>
        <button type="button" className="overview-edit" onClick={onEdit}>
          <Pencil size={13} /> {t("drawer.edit")}
        </button>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EmployeeProfileHeader({
  employee,
  name,
  jobTitle,
  department,
  role,
  status,
  startDate,
  uploadingPhoto,
  onPickPhoto,
}: {
  employee: Employee;
  name: string;
  jobTitle: string;
  department: string;
  role: string;
  status: string;
  startDate: string;
  uploadingPhoto: boolean;
  onPickPhoto: () => void;
}) {
  const { t, dateLocale } = useLanguage();
  return (
    <div className="profile-header">
      <div className="profile-header-avatar">
        <Avatar e={employee} />
        <button
          type="button"
          className="profile-header-photo"
          onClick={onPickPhoto}
          aria-label={
            employee.avatarUrl ? t("profile.changePhoto") : t("profile.uploadPhoto")
          }
          title={employee.avatarUrl ? t("profile.changePhoto") : t("profile.uploadPhoto")}
          disabled={uploadingPhoto}
        >
          {uploadingPhoto ? <span className="button-spinner" aria-hidden="true" /> : <Camera size={13} />}
        </button>
      </div>
      <div className="profile-header-text">
        <h2 id="employee-drawer-title">{name}</h2>
        <p>
          {jobTitle.trim() || t("profile.noJob")} · {department}
        </p>
        <div className="profile-header-tags">
          <Status status={status} />
          <span className="role-chip">{translateRole(t, role)}</span>
          {startDate && (
            <span className="profile-header-meta">
              {t("drawer.since", { date: formatDisplayDate(startDate, dateLocale) })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function daysLabel(
  t: ReturnType<typeof useT>,
  value: number | null,
) {
  if (value === null) return t("common.dash");
  if (value === -1) return `-${t("common.oneDay")}`;
  return formatDaysLabel(t, value);
}

export function RequestDetail({
  request,
  employee,
  approverName,
  balances,
  leaveTypes,
  busy = false,
  close,
  onApprove,
  onReject,
}: {
  request: LeaveRequest;
  employee: Employee | null;
  approverName: string | null;
  balances: LeaveBalance[];
  leaveTypes: LeaveType[];
  busy?: boolean;
  close: () => void;
  onApprove?: () => void | Promise<void>;
  onReject?: () => void | Promise<void>;
}) {
  const person = employee ?? {
    initials: initialsFromName(request.name),
    color: "avatar-indigo",
    avatarUrl: null,
  };
  const leaveType =
    leaveTypes.find((type) => type.id === request.leaveTypeId) ??
    leaveTypes.find(
      (type) =>
        displayLeaveType(type.name) === request.type || type.name === request.type,
    );
  const balance = balances.find(
    (item) =>
      item.employeeId === request.employeeId &&
      (request.leaveTypeId
        ? item.leaveTypeId === request.leaveTypeId
        : leaveType
          ? item.leaveTypeId === leaveType.id
          : false),
  );
  const soldeActuel = balance ? balance.daysRemaining : null;
  const total = leaveType ? leaveType.defaultDays : null;
  const requestedDays = requestedLeaveDays(request.startDate, request.endDate);
  const unpaid = leaveType ? isUnpaidLeaveType(leaveType) : true;
  const sick = Boolean(leaveType && isSickLeaveType(leaveType));
  const parental = Boolean(leaveType && isParentalLeaveType(leaveType));
  const alreadyApproved = request.status === "Approved";
  const nextSolde =
    soldeActuel === null ? null : soldeActuel - requestedDays;
  const advance =
    leaveType &&
    !unpaid &&
    !sick &&
    !parental &&
    soldeActuel !== null &&
    (alreadyApproved
      ? soldeActuel < 0
      : soldeGoesNegative(soldeActuel, requestedDays));
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const t = useT();
  const { dateLocale } = useLanguage();

  useEffect(() => {
    if (!request.attachmentPath) {
      setAttachmentUrl(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const url = await getLeaveAttachmentUrl(request.attachmentPath!);
      if (!cancelled) setAttachmentUrl(url);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [request.attachmentPath]);

  return (
    <>
      <div className="side-panel-backdrop" onMouseDown={close} aria-hidden="true" />
      <div className="side-panel request-detail">
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <Avatar e={person} />
        <h2>{request.name}</h2>
        <p>
          {displayValue(employee?.jobTitle)} · {request.department}
        </p>
        <Status status={request.status} />
        {advance && (
          <p className="solde-alert" role="alert">
            {alreadyApproved
              ? t("panel.noSoldeApproved", { days: soldeActuel ?? 0 })
              : t("panel.noSoldeAdvance", {
                  remaining: soldeActuel ?? 0,
                  next: nextSolde ?? 0,
                })}
          </p>
        )}
        {sick && (
          <p className="leave-policy-alert" role="status">
            <b>{t("modal.sickPolicy")}</b>
            {t("panel.sickReview")}
          </p>
        )}
        {parental && (
          <p className="leave-policy-alert" role="status">
            <b>{t("modal.parentalPolicy")}</b>
            {t("panel.parentalReview")}
          </p>
        )}
        <div className="request-solde">
          <div>
            <span>{t("panel.currentBalance")}</span>
            <b>{daysLabel(t, soldeActuel)}</b>
          </div>
          <div>
            <span>{t("panel.total")}</span>
            <b>{daysLabel(t, total)}</b>
          </div>
          <div>
            <span>{t("panel.duration")}</span>
            <b>{request.days}</b>
          </div>
        </div>
        <div className="detail-block">
          <p className="eyebrow">{t("panel.requestDetails")}</p>
          <div className="detail-row">
            <span>{t("modal.leaveType")}</span>
            <b>{leaveTypeLabel(t, request.type)}</b>
          </div>
          <div className="detail-row">
            <span>{t("modal.startDate")}</span>
            <b>{formatDisplayDate(request.startDate, dateLocale)}</b>
          </div>
          <div className="detail-row">
            <span>{t("modal.endDate")}</span>
            <b>{formatDisplayDate(request.endDate, dateLocale)}</b>
          </div>
          <div className="detail-row">
            <span>{t("panel.duration")}</span>
            <b>{request.days}</b>
          </div>
          <div className="detail-row">
            <span>{t("panel.submitted")}</span>
            <b>
              {request.createdAt
                ? new Date(request.createdAt).toLocaleDateString(dateLocale, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : t("common.dash")}
            </b>
          </div>
          {approverName && (
            <div className="detail-row">
              <span>{t("panel.reviewedBy")}</span>
              <b>{approverName}</b>
            </div>
          )}
          {employee?.email && (
            <div className="detail-row">
              <span>{t("profile.workEmail")}</span>
              <b>{employee.email}</b>
            </div>
          )}
          <div className="detail-reason">
            <span>{t("modal.reason")}</span>
            <p>{displayValue(request.reason)}</p>
          </div>
          <div className="detail-row">
            <span>{t("modal.attachment")}</span>
            {request.attachmentPath ? (
              attachmentUrl ? (
                <a
                  className="detail-attachment"
                  href={attachmentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Paperclip size={12} />
                  {request.attachmentName || t("panel.viewFile")}
                </a>
              ) : (
                <b>{request.attachmentName || t("panel.attached")}</b>
              )
            ) : (
              <b>{t("common.dash")}</b>
            )}
          </div>
        </div>
        {request.status === "Pending" && onApprove && onReject && (
          <div className="request-detail-actions">
            <Button type="button" secondary onClick={() => setConfirmReject(true)}>
              {busy ? t("panel.pleaseWait") : t("common.reject")}
            </Button>
            <Button type="button" onClick={() => setConfirmApprove(true)}>
              {busy ? t("panel.pleaseWait") : t("common.approve")}
            </Button>
          </div>
        )}
        {confirmApprove && onApprove && (
          <ConfirmModal
            title={t("admin.approveTitle")}
            message={t("admin.approveLeave", {
              name: request.name,
              type: request.type,
              dates: request.dates,
            })}
            confirmLabel={t("common.approve")}
            cancelLabel={t("admin.goBack")}
            danger={false}
            close={() => setConfirmApprove(false)}
            confirm={async () => {
              await onApprove();
              setConfirmApprove(false);
            }}
          />
        )}
        {confirmReject && onReject && (
          <ConfirmModal
            title={t("admin.rejectTitle")}
            message={t("admin.rejectLeave", {
              name: request.name,
              type: request.type,
              dates: request.dates,
            })}
            confirmLabel={t("common.reject")}
            cancelLabel={t("admin.goBack")}
            close={() => setConfirmReject(false)}
            confirm={async () => {
              await onReject();
              setConfirmReject(false);
            }}
          />
        )}
      </div>
    </>
  );
}

export function AuthorizationDetail({
  request,
  employee,
  approverName,
  usedMinutes,
  busy = false,
  close,
  onApprove,
  onReject,
}: {
  request: Authorization;
  employee: Employee | null;
  approverName: string | null;
  usedMinutes: number;
  busy?: boolean;
  close: () => void;
  onApprove?: () => void | Promise<void>;
  onReject?: () => void | Promise<void>;
}) {
  const person = employee ?? {
    initials: initialsFromName(request.name),
    color: "avatar-indigo",
    avatarUrl: null,
  };
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const t = useT();
  const { dateLocale } = useLanguage();
  return (
    <>
      <div className="side-panel-backdrop" onMouseDown={close} aria-hidden="true" />
      <div className="side-panel request-detail">
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <Avatar e={person} />
        <h2>{request.name}</h2>
        <p>
          {displayValue(employee?.jobTitle)} · {request.department}
        </p>
        <Status status={request.status} />
        <div className="request-solde is-two">
          <div>
            <span>{t("panel.duration")}</span>
            <b>{request.durationLabel}</b>
          </div>
          <div>
            <span>{t("employee.used")}</span>
            <b>{formatDurationMinutes(usedMinutes)}</b>
          </div>
        </div>
        <div className="detail-block">
          <p className="eyebrow">{t("panel.requestDetails")}</p>
          <div className="detail-row">
            <span>{t("panel.date")}</span>
            <b>{formatDisplayDate(request.date, dateLocale)}</b>
          </div>
          <div className="detail-row">
            <span>{t("panel.startTime")}</span>
            <b>{formatClock(request.startTime)}</b>
          </div>
          <div className="detail-row">
            <span>{t("panel.endTime")}</span>
            <b>{formatClock(request.endTime)}</b>
          </div>
          <div className="detail-row">
            <span>{t("panel.duration")}</span>
            <b>{request.durationLabel}</b>
          </div>
          <div className="detail-row">
            <span>{t("panel.submitted")}</span>
            <b>
              {request.createdAt
                ? new Date(request.createdAt).toLocaleDateString(dateLocale, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : t("common.dash")}
            </b>
          </div>
          {approverName && (
            <div className="detail-row">
              <span>{t("panel.reviewedBy")}</span>
              <b>{approverName}</b>
            </div>
          )}
          {employee?.email && (
            <div className="detail-row">
              <span>{t("profile.workEmail")}</span>
              <b>{employee.email}</b>
            </div>
          )}
          <div className="detail-reason">
            <span>{t("modal.reason")}</span>
            <p>{displayValue(request.reason)}</p>
          </div>
        </div>
        {request.status === "Pending" && onApprove && onReject && (
          <div className="request-detail-actions">
            <Button type="button" secondary onClick={() => setConfirmReject(true)}>
              {busy ? t("panel.pleaseWait") : t("common.reject")}
            </Button>
            <Button type="button" onClick={() => setConfirmApprove(true)}>
              {busy ? t("panel.pleaseWait") : t("common.approve")}
            </Button>
          </div>
        )}
        {confirmApprove && onApprove && (
          <ConfirmModal
            title={t("admin.approveTitle")}
            message={t("admin.approveAuthz", {
              name: request.name,
              date: formatDisplayDate(request.date, dateLocale),
              duration: request.durationLabel,
            })}
            confirmLabel={t("common.approve")}
            cancelLabel={t("admin.goBack")}
            danger={false}
            close={() => setConfirmApprove(false)}
            confirm={async () => {
              await onApprove();
              setConfirmApprove(false);
            }}
          />
        )}
        {confirmReject && onReject && (
          <ConfirmModal
            title={t("admin.rejectTitle")}
            message={t("admin.rejectAuthz", {
              name: request.name,
              date: formatDisplayDate(request.date, dateLocale),
              duration: request.durationLabel,
            })}
            confirmLabel={t("common.reject")}
            cancelLabel={t("admin.goBack")}
            close={() => setConfirmReject(false)}
            confirm={async () => {
              await onReject();
              setConfirmReject(false);
            }}
          />
        )}
      </div>
    </>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  close,
  confirm,
}: {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  close: () => void;
  confirm: () => void | Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await confirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Close when the press starts on the backdrop itself, not inside the dialog.
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className={`modal card confirm-modal${danger ? " is-danger" : ""}`}>
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <p className="eyebrow">{t("confirm.please")}</p>
        <h2>{title || t("confirm.please")}</h2>
        <p className="page-subtitle">{message}</p>
        <div className="modal-actions">
          <Button secondary onClick={close}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button onClick={() => void run()}>
            {busy ? t("panel.pleaseWait") : confirmLabel ?? t("common.delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}
