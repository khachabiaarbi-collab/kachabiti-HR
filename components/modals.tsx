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
      flash("Choose a leave type");
      return;
    }
    if (!startDate || !endDate) {
      flash("Choose a start and end date");
      return;
    }
    if (endDate < startDate) {
      flash("End date must be on or after the start date");
      return;
    }
    if (sick && startDate < sickLeaveMinIsoDate()) {
      flash(
        "Sick leave must be applied for within 48 hours of the start date",
      );
      return;
    }
    if (parental && firstParental?.status === "Pending") {
      flash("Your first parental leave is still pending");
      return;
    }
    if (secondParental) {
      if (startDate !== secondStart) {
        flash(
          "Second parental leave must start immediately after the first one ends",
        );
        return;
      }
      if (endDate > parentalEnd) {
        flash("Second parental leave can last at most 4 months");
        return;
      }
      const deadline = shiftCalendarMonths(firstParental.endDate, -1);
      if (deadline && isoDate() > deadline) {
        flash(
          "Second parental leave must be submitted no later than one month before the first leave ends",
        );
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
      flash("You must be signed in");
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
        <p className="eyebrow">Time away</p>
        <h2>Request leave</h2>
        {advance && (
          <p className="solde-alert" role="alert">
            {remaining <= 0
              ? `You have no remaining solde (${remaining} days). This leave will be taken in advance and your balance will go negative (${nextSolde} days).`
              : `This leave exceeds your solde (${remaining} days remaining). Extra days will be taken in advance and your balance will go negative (${nextSolde} days).`}
          </p>
        )}
        {sick && (
          <p className="leave-policy-alert" role="status">
            <b>Sick leave policy</b>
            You currently have {remaining} sick day(s) available each year. Any
            sick leave beyond that balance will automatically deduct the extra
            days from your Vacation leave balance. Note: Dates before 48 hours
            ago are disabled in the calendar as sick leave must be applied for
            within 48 hours of the start date.
          </p>
        )}
        {parental && (
          <p className="leave-policy-alert" role="status">
            <b>Parental leave benefit</b>
            This parental leave is granted for 3.5 months starting on your
            chosen start date. The end date is set automatically and the leave
            is not deducted from your balance. After your first parental leave
            ends you may request a second one that must start immediately after
            the first and last at most 4 months, but it needs to be submitted no
            later than one month before the first leave ends.
          </p>
        )}
        <label className="form-label">
          Leave type
          <select
            name="leave_type_id"
            value={leaveTypeId}
            onChange={(event) => chooseType(event.target.value)}
          >
            {leaveTypes.length === 0 && <option value="">No leave types</option>}
            {leaveTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {displayLeaveType(type.name)}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <Field
            label="Start date"
            name="start_date"
            type="date"
            value={startDate}
            min={sick ? sickMin : secondParental ? secondStart : undefined}
            max={secondParental ? secondStart : undefined}
            readOnly={secondParental}
            onChange={setStartDate}
          />
          <Field
            label="End date"
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
          Reason
          <textarea
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Add a note for your manager"
          />
        </label>
        {sick && (
          <label className="form-label">
            Attachment
            <input
              type="file"
              accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <small>
              <Paperclip size={12} />{" "}
              {file ? file.name : "Optional supporting document, up to 10 MB"}
            </small>
          </label>
        )}
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            Cancel
          </Button>
          <Button>{saving ? "Submitting..." : "Submit request"}</Button>
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
      flash("Choose a date");
      return;
    }
    if (!startTime || !endTime) {
      flash("Choose a start and end time");
      return;
    }
    if (durationMinutes <= 0) {
      flash("End time must be after start time");
      return;
    }
    if (!reason.trim()) {
      flash("Add a reason");
      return;
    }

    setSaving(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      flash("You must be signed in");
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
        <p className="eyebrow">Authorization</p>
        <h2>Request authorization</h2>
        <p className="page-subtitle">
          An authorization is a few hours during a work day (doctor, errand).
          For a full day, use Request leave. You get 8 free hours each month.
        </p>
        <div className="request-solde">
          <div>
            <span>Used</span>
            <b>{monthBalance.usedDurationLabel}</b>
          </div>
          <div>
            <span>Left of 8h</span>
            <b>{monthBalance.remainingLabel}</b>
          </div>
          <div>
            <span>This request</span>
            <b>
              {durationMinutes > 0
                ? formatDurationMinutes(durationMinutes)
                : "—"}
            </b>
          </div>
        </div>
        {afterBalance.extraMinutes > 0 && (
          <p className="solde-alert" role="alert">
            This request exceeds the free 8h
            {extraDaysIfApproved > 0
              ? `. If approved, it takes ${
                  extraDaysIfApproved === 1
                    ? "1 vacation day"
                    : `${extraDaysIfApproved} vacation days`
                } because you will be ${afterBalance.extraLabel} over`
              : ` by ${afterBalance.extraLabel}`}
            .
          </p>
        )}
        <Field
          label="Which day?"
          name="date"
          type="date"
          value={date}
          onChange={setDate}
        />
        <div className="form-row">
          <Field
            label="From"
            name="start_time"
            type="time"
            value={startTime}
            onChange={setStartTime}
          />
          <Field
            label="Until"
            name="end_time"
            type="time"
            value={endTime}
            onChange={setEndTime}
          />
        </div>
        <label className="form-label">
          Why do you need to leave?
          <textarea
            name="reason"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Doctor visit, errand, family matter…"
          />
        </label>
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            Cancel
          </Button>
          <Button>{saving ? "Sending..." : "Submit authorization"}</Button>
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

  const submit = async () => {
    if (saving) return;
    if (!title.trim()) {
      flash("Add an event title");
      return;
    }
    if (!startDate || !endDate) {
      flash("Choose a start and end date");
      return;
    }
    if (endDate < startDate) {
      flash("End date must be on or after the start date");
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
        <p className="eyebrow">Team calendar</p>
        <h2>Add event</h2>
        <Field label="Event title" value={title} onChange={setTitle} />
        <div className="form-row">
          <Field
            label="Start date"
            type="date"
            value={startDate}
            onChange={setStartDate}
          />
          <Field
            label="End date"
            type="date"
            value={endDate}
            onChange={setEndDate}
          />
        </div>
        <label className="form-label">
          Type
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option>Company Holiday</option>
            <option>Team Event</option>
            <option>Other</option>
          </select>
        </label>
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            Cancel
          </Button>
          <Button>{saving ? "Saving..." : "Save event"}</Button>
        </div>
      </form>
    </div>
  );
}

export function DepartmentModal({
  employees,
  close,
  flash,
  onSaved,
}: {
  employees: Employee[];
  close: () => void;
  flash: (message: string) => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [managerId, setManagerId] = useState(employees[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!name.trim()) {
      flash("Add a department name");
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from("departments").insert({
      name: name.trim(),
      manager_id: managerId || null,
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
        <p className="eyebrow">Workspace structure</p>
        <h2>Add department</h2>
        <label className="form-label">
          Department name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Department name"
          />
        </label>
        <label className="form-label">
          Assign manager
          <select
            value={managerId}
            onChange={(e) => setManagerId(e.target.value)}
          >
            <option value="">Unassigned</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            Cancel
          </Button>
          <Button>{saving ? "Adding..." : "Add department"}</Button>
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

  const submit = async () => {
    if (saving) return;
    if (!name.trim() || !email.trim()) {
      flash("Name and work email are required");
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
        <p className="eyebrow">Team directory</p>
        <h2>Invite employee</h2>
        <Field
          label="Full name"
          name="full_name"
          value={name}
          onChange={setName}
        />
        <Field
          label="Work email"
          name="email"
          type="email"
          value={email}
          onChange={setEmail}
        />
        <Field
          label="Job title"
          name="job_title"
          value={jobTitle}
          onChange={setJobTitle}
        />
        <div className="form-row">
          <label className="form-label">
            Department
            <select
              name="department_id"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-label">
            Role
            <select
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option>Employee</option>
              <option>Manager</option>
              <option>Administrator</option>
            </select>
          </label>
        </div>
        <Field
          label="Start date"
          name="start_date"
          type="date"
          value={startDate}
          onChange={setStartDate}
        />
        <Field
          label="Monthly leave days"
          name="monthly_leave_days"
          type="number"
          step="0.01"
          value={monthlyLeaveDays}
          onChange={setMonthlyLeaveDays}
        />
        <p className="page-subtitle">
          They will set a password from the invite email. Annual solde is
          months worked times this monthly rate (default 1.75). A future start
          date stays at 0.
        </p>
        <div className="modal-actions">
          <Button type="button" secondary onClick={close}>
            Cancel
          </Button>
          <Button>{saving ? "Sending..." : "Send invite"}</Button>
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
    flash("Employee details saved");
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
          <p className="eyebrow">Employee details</p>
          <Field label="Full name" name="full_name" value={name} onChange={setName} />
          <Field label="Work email" name="email" value={email} onChange={setEmail} />
          <Field label="Phone" name="phone" value={phone} onChange={setPhone} />
          <Field label="Job title" name="job_title" value={jobTitle} onChange={setJobTitle} />
          <label className="form-label">
            Department
            <select
              name="department_id"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-label">
            Role
            <select
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option>Employee</option>
              <option>Manager</option>
              <option>Administrator</option>
            </select>
          </label>
          <label className="form-label">
            Status
            <select
              name="status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option>Active</option>
              <option>Inactive</option>
            </select>
          </label>
          <Field
            label="Start date"
            name="start_date"
            type="date"
            value={startDate}
            onChange={(value) => applyHireSolde(value, monthlyLeaveDays)}
          />
          <Field
            label="Monthly leave days"
            name="monthly_leave_days"
            type="number"
            step="0.01"
            value={monthlyLeaveDays}
            onChange={(value) => applyHireSolde(startDate, value)}
          />
        </div>
        <div className="detail-block">
          <p className="eyebrow">Solde</p>
          <p className="page-subtitle">
            Annual solde is months worked since the start date times the monthly
            rate. A future start stays at 0. Sick is the full yearly default
            (10) and is not tied to the monthly annual rate.
          </p>
          {solde.length === 0 ? (
            <span>No leave types yet</span>
          ) : (
            solde.map((row, index) => (
              <div className="solde-adjust" key={`${row.leaveTypeId}-${row.typeName}-${index}`}>
                <span>{row.typeName}</span>
                <div>
                  <button
                    type="button"
                    aria-label={`Decrease ${row.typeName}`}
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
                    aria-label={`Increase ${row.typeName}`}
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
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function daysLabel(value: number | null) {
  if (value === null) return "—";
  if (value === 1) return "1 day";
  if (value === -1) return "-1 day";
  return `${value} days`;
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
            ? `No remaining solde. Balance is in the negative (${soldeActuel} days).`
            : `No remaining solde (${soldeActuel} days). This request is leave in advance; balance will go negative (${nextSolde} days).`}
        </p>
      )}
      {sick && (
        <p className="leave-policy-alert" role="status">
          <b>Sick leave policy</b>
          Extra sick days beyond the yearly sick balance are deducted from
          Vacation leave. Sick leave must be applied for within 48 hours of the
          start date.
        </p>
      )}
      {parental && (
        <p className="leave-policy-alert" role="status">
          <b>Parental leave benefit</b>
          This leave is not deducted from vacation balance. First leave is 3.5
          months; a second leave of up to 4 months must start immediately after
          the first and be submitted no later than one month before the first
          ends.
        </p>
      )}
      <div className="request-solde">
        <div>
          <span>Solde actuel</span>
          <b>{daysLabel(soldeActuel)}</b>
        </div>
        <div>
          <span>Total</span>
          <b>{daysLabel(total)}</b>
        </div>
        <div>
          <span>Duration</span>
          <b>{request.days}</b>
        </div>
      </div>
      <div className="detail-block">
        <p className="eyebrow">Request details</p>
        <div className="detail-row">
          <span>Leave type</span>
          <b>{request.type}</b>
        </div>
        <div className="detail-row">
          <span>Start date</span>
          <b>{formatDisplayDate(request.startDate)}</b>
        </div>
        <div className="detail-row">
          <span>End date</span>
          <b>{formatDisplayDate(request.endDate)}</b>
        </div>
        <div className="detail-row">
          <span>Duration</span>
          <b>{request.days}</b>
        </div>
        <div className="detail-row">
          <span>Submitted</span>
          <b>
            {request.createdAt
              ? new Date(request.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : "—"}
          </b>
        </div>
        {approverName && (
          <div className="detail-row">
            <span>Reviewed by</span>
            <b>{approverName}</b>
          </div>
        )}
        {employee?.email && (
          <div className="detail-row">
            <span>Work email</span>
            <b>{employee.email}</b>
          </div>
        )}
        <div className="detail-reason">
          <span>Reason</span>
          <p>{displayValue(request.reason)}</p>
        </div>
        <div className="detail-row">
          <span>Attachment</span>
          {request.attachmentPath ? (
            attachmentUrl ? (
              <a
                className="detail-attachment"
                href={attachmentUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Paperclip size={12} />
                {request.attachmentName || "View file"}
              </a>
            ) : (
              <b>{request.attachmentName || "Attached"}</b>
            )
          ) : (
            <b>—</b>
          )}
        </div>
      </div>
      {request.status === "Pending" && onApprove && onReject && (
        <div className="request-detail-actions">
          <Button type="button" secondary onClick={() => setConfirmReject(true)}>
            {busy ? "Please wait..." : "Reject"}
          </Button>
          <Button type="button" onClick={() => setConfirmApprove(true)}>
            {busy ? "Please wait..." : "Approve"}
          </Button>
        </div>
      )}
      {confirmApprove && onApprove && (
        <ConfirmModal
          title="Approve request"
          message={`Approve ${request.name}'s ${request.type} request for ${request.dates}?`}
          confirmLabel="Approve"
          cancelLabel="Go back"
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
          title="Reject request"
          message={`Reject ${request.name}'s ${request.type} request for ${request.dates}?`}
          confirmLabel="Reject"
          cancelLabel="Go back"
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
          <span>Duration</span>
          <b>{request.durationLabel}</b>
        </div>
        <div>
          <span>This month</span>
          <b>{authorizationBucketLabel(usedMinutes)}</b>
        </div>
      </div>
      <div className="detail-block">
        <p className="eyebrow">Request details</p>
        <div className="detail-row">
          <span>Date</span>
          <b>{formatDisplayDate(request.date)}</b>
        </div>
        <div className="detail-row">
          <span>Start time</span>
          <b>{formatClock(request.startTime)}</b>
        </div>
        <div className="detail-row">
          <span>End time</span>
          <b>{formatClock(request.endTime)}</b>
        </div>
        <div className="detail-row">
          <span>Duration</span>
          <b>{request.durationLabel}</b>
        </div>
        <div className="detail-row">
          <span>Submitted</span>
          <b>
            {request.createdAt
              ? new Date(request.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : "—"}
          </b>
        </div>
        {approverName && (
          <div className="detail-row">
            <span>Reviewed by</span>
            <b>{approverName}</b>
          </div>
        )}
        {employee?.email && (
          <div className="detail-row">
            <span>Work email</span>
            <b>{employee.email}</b>
          </div>
        )}
        <div className="detail-reason">
          <span>Reason</span>
          <p>{displayValue(request.reason)}</p>
        </div>
      </div>
      {request.status === "Pending" && onApprove && onReject && (
        <div className="request-detail-actions">
          <Button type="button" secondary onClick={() => setConfirmReject(true)}>
            {busy ? "Please wait..." : "Reject"}
          </Button>
          <Button type="button" onClick={() => setConfirmApprove(true)}>
            {busy ? "Please wait..." : "Approve"}
          </Button>
        </div>
      )}
      {confirmApprove && onApprove && (
        <ConfirmModal
          title="Approve request"
          message={
            vacationDaysIfApproved > 0
              ? `Approve ${request.name}'s authorization for ${formatDisplayDate(request.date)} (${request.durationLabel})? This takes ${vacationDaysIfApproved} vacation day${vacationDaysIfApproved === 1 ? "" : "s"} because they will be over the free 8h.`
              : `Approve ${request.name}'s authorization for ${formatDisplayDate(request.date)} (${request.durationLabel})?`
          }
          confirmLabel="Approve"
          cancelLabel="Go back"
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
          title="Reject request"
          message={`Reject ${request.name}'s authorization for ${formatDisplayDate(request.date)} (${request.durationLabel})?`}
          confirmLabel="Reject"
          cancelLabel="Go back"
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
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
  close,
  confirm,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  close: () => void;
  confirm: () => void | Promise<void>;
}) {
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
        <p className="eyebrow">Please confirm</p>
        <h2>{title}</h2>
        <p className="page-subtitle">{message}</p>
        <div className="modal-actions">
          <Button secondary onClick={close}>
            {cancelLabel}
          </Button>
          <Button onClick={() => void run()}>
            {busy ? "Please wait..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
