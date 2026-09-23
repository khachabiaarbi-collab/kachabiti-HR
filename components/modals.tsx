"use client";

import { useEffect, useState } from "react";
import { Minus, Paperclip, Plus, X } from "lucide-react";
import type {
  Authorization,
  Department,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
} from "@/lib/app-types";
import { Avatar, Button, Field, Status } from "@/components/primitives";
import { createClient } from "@/lib/supabase/client";
import {
  getLeaveAttachmentUrl,
  uploadLeaveAttachment,
} from "@/lib/leave-attachments";
import {
  authorizationBalance,
  authorizationBucketLabel,
  authorizationMonthKey,
  authorizationVacationDaysToCharge,
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
import {
  formatDaysLabel,
  translateRole,
  translateStatus,
  useLanguage,
  useT,
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
  flash: (message: string) => void;
  onSubmitted: () => void | Promise<void>;
}) {
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
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
      flash(t("modal.chooseType"));
      return;
    }
    if (!startDate || !endDate) {
      flash(t("modal.chooseDates"));
      return;
    }
    if (endDate < startDate) {
      flash(t("modal.endAfterStart"));
      return;
    }
    if (sick && startDate < sickLeaveMinIsoDate()) {
      flash(t("modal.sick48h"));
      return;
    }
    if (parental && firstParental?.status === "Pending") {
      flash(t("modal.parentalPending"));
      return;
    }
    if (secondParental) {
      if (startDate !== secondStart) {
        flash(t("modal.parentalSecondStart"));
        return;
      }
      if (endDate > parentalEnd) {
        flash(t("modal.parentalSecondMax"));
        return;
      }
      const deadline = shiftCalendarMonths(firstParental.endDate, -1);
      if (deadline && isoDate() > deadline) {
        flash(t("modal.parentalDeadline"));
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
      flash(t("profile.mustSignIn"));
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
        flash(uploaded.error);
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
      flash(error.message);
      return;
    }

    await onSubmitted();
    setSaving(false);
  };

  return (
    <div className="modal-backdrop">
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
          <select
            name="leave_type_id"
            value={leaveTypeId}
            onChange={(event) => chooseType(event.target.value)}
          >
            {leaveTypes.length === 0 && (
              <option value="">{t("modal.noTypes")}</option>
            )}
            {leaveTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {displayLeaveType(type.name)}
              </option>
            ))}
          </select>
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
  flash: (message: string) => void;
  onSubmitted: () => void | Promise<void>;
  authorizations: Authorization[];
  currentEmployeeId: string | null;
}) {
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const t = useT();
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
  const extraDaysIfApproved = authorizationVacationDaysToCharge(
    usedMinutes,
    Math.max(0, durationMinutes),
  );
  const afterBalance = authorizationBalance(
    usedMinutes + Math.max(0, durationMinutes),
  );

  const submit = async () => {
    if (saving) return;
    if (!date) {
      flash(t("modal.chooseDate"));
      return;
    }
    if (!startTime || !endTime) {
      flash(t("modal.chooseTimes"));
      return;
    }
    if (durationMinutes <= 0) {
      flash(t("modal.endTimeAfter"));
      return;
    }
    if (!reason.trim()) {
      flash(t("modal.addReason"));
      return;
    }

    setSaving(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      flash(t("profile.mustSignIn"));
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
      flash(error.message);
      return;
    }

    await onSubmitted();
    setSaving(false);
  };

  return (
    <div className="modal-backdrop">
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
            <span>{t("employee.leftOf8h")}</span>
            <b>{monthBalance.remainingLabel}</b>
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
        {afterBalance.extraMinutes > 0 && (
          <p className="solde-alert" role="alert">
            {t("modal.exceeds8h")}
            {extraDaysIfApproved > 0
              ? `${
                  extraDaysIfApproved === 1
                    ? t("modal.ifApprovedOne")
                    : t("modal.ifApprovedDays", { count: extraDaysIfApproved })
                }${t("modal.overBy", { extra: afterBalance.extraLabel })}`
              : t("modal.byExtra", { extra: afterBalance.extraLabel })}
            .
          </p>
        )}
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
  flash: (message: string) => void;
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
      flash(t("modal.addEventTitle"));
      return;
    }
    if (!startDate || !endDate) {
      flash(t("modal.chooseDates"));
      return;
    }
    if (endDate < startDate) {
      flash(t("modal.endAfterStart"));
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
      flash(error.message);
      return;
    }
    await onSaved();
    setSaving(false);
  };

  return (
    <div className="modal-backdrop">
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
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option value="Company Holiday">{t("modal.companyHoliday")}</option>
            <option value="Team Event">{t("modal.teamEvent")}</option>
            <option value="Other">{t("modal.other")}</option>
          </select>
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
  flash: (message: string) => void;
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
      flash(t("modal.addDeptName"));
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
      flash(error.message);
      return;
    }
    await onSaved();
    setSaving(false);
  };

  return (
    <div className="modal-backdrop">
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
          <select
            value={managerId}
            onChange={(e) => setManagerId(e.target.value)}
          >
            <option value="">{t("department.unassigned")}</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
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
  flash: (message: string) => void;
  onInvited: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [monthlyLeaveDays, setMonthlyLeaveDays] = useState(
    String(DEFAULT_MONTHLY_LEAVE_DAYS),
  );
  const [role, setRole] = useState("Employee");
  const [saving, setSaving] = useState(false);
  const t = useT();

  const submit = async () => {
    if (saving) return;
    if (!name.trim() || !email.trim()) {
      flash(t("modal.nameEmailRequired"));
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
      flash(error);
      return;
    }

    await onInvited();
    setSaving(false);
  };

  return (
    <div className="modal-backdrop">
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
            <select
              name="department_id"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">{t("department.unassigned")}</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-label">
            {t("profile.role")}
            <select
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="Employee">{translateRole(t, "Employee")}</option>
              <option value="Manager">{translateRole(t, "Manager")}</option>
              <option value="Administrator">{translateRole(t, "Administrator")}</option>
            </select>
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
  close,
  flash,
  onSaved,
}: {
  employee: Employee;
  departments: Department[];
  leaveTypes: LeaveType[];
  balances?: LeaveBalance[];
  close: () => void;
  flash: (message: string) => void;
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
  const t = useT();

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
    if (!name.trim() || !email.trim() || saving) return;
    setSaving(true);
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
      flash(employeeError.message);
      return;
    }

    if (solde.length) {
      const { error: soldeError } = await supabase.from("leave_balances").upsert(
        solde.map((row) => ({
          employee_id: employee.id,
          leave_type_id: row.leaveTypeId,
          days_remaining: row.daysRemaining,
        })),
        { onConflict: "employee_id,leave_type_id" },
      );

      if (soldeError) {
        setSaving(false);
        flash(soldeError.message);
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
    flash(t("panel.saved"));
    setSaving(false);
  };

  return (
    <div className="side-panel">
      <button type="button" className="panel-close" onClick={close}>
        <X size={18} />
      </button>
      <Avatar e={employee} />
      <h2>{name || employee.name}</h2>
      <p>
        {displayValue(jobTitle)} · {employee.department}
      </p>
      <div className="employee-edit-form">
        <div className="detail-block">
          <p className="eyebrow">{t("panel.details")}</p>
          <Field label={t("profile.fullName")} name="full_name" value={name} onChange={setName} />
          <Field label={t("profile.workEmail")} name="email" value={email} onChange={setEmail} />
          <Field label={t("profile.phone")} name="phone" value={phone} onChange={setPhone} />
          <Field label={t("profile.jobTitle")} name="job_title" value={jobTitle} onChange={setJobTitle} />
          <label className="form-label">
            {t("profile.department")}
            <select
              name="department_id"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">{t("department.unassigned")}</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-label">
            {t("profile.role")}
            <select
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="Employee">{translateRole(t, "Employee")}</option>
              <option value="Manager">{translateRole(t, "Manager")}</option>
              <option value="Administrator">{translateRole(t, "Administrator")}</option>
            </select>
          </label>
          <label className="form-label">
            {t("profile.status")}
            <select
              name="status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="Active">{translateStatus(t, "Active")}</option>
              <option value="Inactive">{translateStatus(t, "Inactive")}</option>
            </select>
          </label>
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
            value={monthlyLeaveDays}
            onChange={(value) => applyHireSolde(startDate, value)}
          />
        </div>
        <div className="detail-block">
          <p className="eyebrow">{t("panel.solde")}</p>
          <p className="page-subtitle">{t("panel.soldeNote")}</p>
          {solde.length === 0 ? (
            <span>{t("panel.noTypes")}</span>
          ) : (
            solde.map((row, index) => (
              <div className="solde-adjust" key={`${row.leaveTypeId}-${row.typeName}-${index}`}>
                <span>{row.typeName}</span>
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
        </div>
        <Button onClick={() => void save()}>
          {saving ? t("modal.saving") : t("panel.saveChanges")}
        </Button>
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
          <b>{request.type}</b>
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
  const vacationDaysIfApproved =
    request.status === "Pending"
      ? authorizationVacationDaysToCharge(usedMinutes, request.durationMinutes)
      : 0;

  return (
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
          <span>{t("employee.thisMonth")}</span>
          <b>{authorizationBucketLabel(usedMinutes)}</b>
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
          message={
            vacationDaysIfApproved > 0
              ? t("admin.approveAuthzDays", {
                  name: request.name,
                  date: formatDisplayDate(request.date, dateLocale),
                  duration: request.durationLabel,
                  days: vacationDaysIfApproved,
                })
              : t("admin.approveAuthz", {
                  name: request.name,
                  date: formatDisplayDate(request.date, dateLocale),
                  duration: request.durationLabel,
                })
          }
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
    <div className="modal-backdrop">
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
