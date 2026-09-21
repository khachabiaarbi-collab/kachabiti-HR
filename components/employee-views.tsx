"use client";

import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Clock3,
  Palmtree,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  Authorization,
  CompanyEvent,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  ModalKind,
  NoticeFocus,
  RequestTab,
} from "@/lib/app-types";
import { Calendar } from "@/components/admin-views";
import {
  AuthorizationDetail,
  ConfirmModal,
  RequestDetail,
} from "@/components/modals";
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
  deleteAuthorizationRecord,
  deleteLeaveRequestRecord,
} from "@/lib/delete-records";
import {
  approvedAuthorizationMinutes,
  authorizationMonthKey,
  authorizationBalance,
  DEFAULT_MONTHLY_LEAVE_DAYS,
  displayLeaveType,
  displayValue,
  firstName,
  firstParentalLeave,
  formatDisplayDate,
  isAnnualLeaveType,
  isExceptionalLeaveType,
  isSickLeaveType,
  overlapsDateRange,
  requestedLeaveDays,
} from "@/lib/map-rows";
import { uploadEmployeeAvatar } from "@/lib/employee-avatar";
import { createClient } from "@/lib/supabase/client";

function parentalStatus(kind: "available" | "pending" | "used" | "locked") {
  if (kind === "available") return "Available";
  if (kind === "pending") return "Pending";
  if (kind === "used") return "Used this year";
  return "After first leave";
}

export function EmployeeView({
  active,
  requests,
  authorizations,
  flash,
  setModal,
  currentEmployee,
  balances,
  leaveTypes,
  events,
  noticeFocus = null,
  onNoticeFocusHandled,
  reload,
}: {
  active: string;
  requests: LeaveRequest[];
  authorizations: Authorization[];
  flash: (message: string) => void;
  setModal: (modal: ModalKind) => void;
  currentEmployee: Employee | null;
  balances: LeaveBalance[];
  leaveTypes: LeaveType[];
  events: CompanyEvent[];
  noticeFocus?: NoticeFocus | null;
  onNoticeFocusHandled?: () => void;
  reload: () => Promise<void>;
}) {
  const [pendingCancel, setPendingCancel] = useState<LeaveRequest | null>(null);
  const [pendingCancelAuthz, setPendingCancelAuthz] =
    useState<Authorization | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<RequestTab>("leaves");
  const skipClear = useRef(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [type, setType] = useState("All");
  const [startFrom, setStartFrom] = useState("");
  const [endTo, setEndTo] = useState("");
  const mine = currentEmployee
    ? requests.filter((request) => request.employeeId === currentEmployee.id)
    : [];
  const myAuthorizations = currentEmployee
    ? authorizations.filter((item) => item.employeeId === currentEmployee.id)
    : [];
  const needle = query.toLowerCase();
  const filteredLeaves = mine.filter(
    (request) =>
      (status === "All" || request.status === status) &&
      (type === "All" || request.type === type) &&
      overlapsDateRange(request.startDate, request.endDate, startFrom, endTo) &&
      (request.type.toLowerCase().includes(needle) ||
        request.dates.toLowerCase().includes(needle) ||
        (request.reason ?? "").toLowerCase().includes(needle)),
  );
  const filteredAuthz = myAuthorizations.filter(
    (request) =>
      (status === "All" || request.status === status) &&
      overlapsDateRange(request.date, request.date, startFrom, endTo) &&
      (request.reason.toLowerCase().includes(needle) ||
        request.durationLabel.toLowerCase().includes(needle) ||
        request.timesLabel.toLowerCase().includes(needle)),
  );
  const pagedLeaves = paginate(filteredLeaves, page);
  const pagedAuthz = paginate(filteredAuthz, page);
  const selected = mine.find((request) => request.id === selectedId) ?? null;
  const selectedAuthz =
    myAuthorizations.find((request) => request.id === selectedId) ?? null;
  const usedMinutes = currentEmployee
    ? approvedAuthorizationMinutes(authorizations, currentEmployee.id)
    : 0;
  const authzBalance = authorizationBalance(usedMinutes);

  useEffect(() => {
    setPage(1);
    if (skipClear.current) {
      skipClear.current = false;
      return;
    }
    setSelectedId(null);
  }, [tab, query, status, type, startFrom, endTo]);

  useEffect(() => {
    if (!noticeFocus) return;
    skipClear.current = true;
    setQuery("");
    setStatus("All");
    setType("All");
    setStartFrom("");
    setEndTo("");
    setTab(noticeFocus.tab);
    setPage(
      noticeFocus.tab === "authorizations"
        ? pageForId(myAuthorizations, noticeFocus.id)
        : pageForId(mine, noticeFocus.id),
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

  const resetFilters = () => {
    setQuery("");
    setStatus("All");
    setType("All");
    setStartFrom("");
    setEndTo("");
  };

  if (active === "My requests") {
    return (
      <>
        <Header
          eyebrow="My workspace"
          title="My requests"
          action={
            tab === "leaves" ? (
              <Button onClick={() => setModal("request")}>
                <Plus size={16} /> Request leave
              </Button>
            ) : (
              <Button onClick={() => setModal("authorization")}>
                <Plus size={16} /> Request authorization
              </Button>
            )
          }
        />
        <div className="request-tabs-row">
          <RequestTabs value={tab} onChange={setTab} />
          {tab === "authorizations" && (
            <p className="authz-bucket">
              {authzBalance.usedDurationLabel} of 8h used this month
              {authzBalance.extraMinutes > 0 ? (
                <span className="authz-extra-danger">
                  {" "}
                  · {authzBalance.extraLabel} over the free 8h
                  {authzBalance.daysCharged > 0
                    ? ` · takes ${authzBalance.daysCharged === 1 ? "1 vacation day" : `${authzBalance.daysCharged} vacation days`}`
                    : ""}
                </span>
              ) : null}
            </p>
          )}
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
                    ...Array.from(new Set(mine.map((request) => request.type))),
                  ].filter(
                    (option, index, list) => list.indexOf(option) === index,
                  ),
                },
              ]}
              startDate={startFrom}
              setStartDate={setStartFrom}
              endDate={endTo}
              setEndDate={setEndTo}
              onReset={resetFilters}
            />
            {pagedLeaves.items.map((request) => (
              <div
                className={`employee-row is-selectable${selectedId === request.id ? " is-selected" : ""}${highlightId === request.id ? " is-notice-focus" : ""}`}
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
                <LeaveTypeLabel type={request.type} />
                <span>{request.dates}</span>
                <span>{request.days}</span>
                <Status status={request.status} />
                <div
                  className="row-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  {request.status === "Pending" && (
                    <button
                      type="button"
                      onClick={() => setPendingCancel(request)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {filteredLeaves.length === 0 && (
              <div className="table-empty">
                {mine.length === 0
                  ? "No leave requests yet."
                  : "No leave requests match these filters."}
              </div>
            )}
            <Pagination
              page={pagedLeaves.page}
              pageCount={pagedLeaves.pageCount}
              total={pagedLeaves.total}
              start={pagedLeaves.start}
              end={pagedLeaves.end}
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
              onReset={resetFilters}
            />
            {pagedAuthz.items.map((request) => (
              <div
                className={`employee-row employee-authz-row is-selectable${selectedId === request.id ? " is-selected" : ""}${highlightId === request.id ? " is-notice-focus" : ""}`}
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
                <span>{request.durationLabel}</span>
                <span>{formatDisplayDate(request.date)}</span>
                <span>{request.timesLabel}</span>
                <span className="authz-reason">{request.reason}</span>
                <Status status={request.status} />
                <div
                  className="row-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  {request.status === "Pending" && (
                    <button
                      type="button"
                      onClick={() => setPendingCancelAuthz(request)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {filteredAuthz.length === 0 && (
              <div className="table-empty">
                {myAuthorizations.length === 0
                  ? "No authorizations yet."
                  : "No authorizations match these filters."}
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
        {pendingCancel && (
          <ConfirmModal
            title="Cancel request"
            message={`Cancel your ${pendingCancel.type} request for ${pendingCancel.dates}?`}
            cancelLabel="Keep request"
            confirmLabel="Cancel request"
            close={() => setPendingCancel(null)}
            confirm={async () => {
              const message = await deleteLeaveRequestRecord(pendingCancel.id);
              if (message) {
                flash(message);
                return;
              }
              await reload();
              setPendingCancel(null);
              setSelectedId(null);
              flash("Request cancelled");
            }}
          />
        )}
        {pendingCancelAuthz && (
          <ConfirmModal
            title="Cancel request"
            message={`Cancel your authorization for ${formatDisplayDate(pendingCancelAuthz.date)} (${pendingCancelAuthz.durationLabel})?`}
            cancelLabel="Keep request"
            confirmLabel="Cancel request"
            close={() => setPendingCancelAuthz(null)}
            confirm={async () => {
              const message = await deleteAuthorizationRecord(
                pendingCancelAuthz.id,
              );
              if (message) {
                flash(message);
                return;
              }
              await reload();
              setPendingCancelAuthz(null);
              setSelectedId(null);
              flash("Request cancelled");
            }}
          />
        )}
        {tab === "leaves" && selected && (
          <RequestDetail
            request={selected}
            employee={currentEmployee}
            approverName={null}
            balances={balances}
            leaveTypes={leaveTypes}
            close={() => setSelectedId(null)}
          />
        )}
        {tab === "authorizations" && selectedAuthz && (
          <AuthorizationDetail
            request={selectedAuthz}
            employee={currentEmployee}
            approverName={null}
            usedMinutes={approvedAuthorizationMinutes(
              authorizations,
              currentEmployee?.id ?? selectedAuthz.employeeId,
              authorizationMonthKey(selectedAuthz.date),
            )}
            close={() => setSelectedId(null)}
          />
        )}
      </>
    );
  }

  if (active === "Calendar") {
    return (
      <Calendar
        setModal={setModal}
        events={events}
        requests={mine}
        authorizations={myAuthorizations}
        employees={currentEmployee ? [currentEmployee] : []}
        eyebrow="My workspace"
      />
    );
  }

  if (active === "My profile") {
    return <Profile flash={flash} employee={currentEmployee} reload={reload} />;
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const hello = currentEmployee ? firstName(currentEmployee.name) : "";
  const myBalances = balances.filter(
    (balance) => !currentEmployee || balance.employeeId === currentEmployee.id,
  );
  const annualType = leaveTypes.find((type) => isAnnualLeaveType(type));
  const sickType = leaveTypes.find((type) => isSickLeaveType(type));
  const annual = myBalances.find(
    (balance) => balance.leaveTypeId === annualType?.id,
  );
  const sick = myBalances.find(
    (balance) => balance.leaveTypeId === sickType?.id,
  );
  const monthlyDays =
    currentEmployee?.monthlyLeaveDays ?? DEFAULT_MONTHLY_LEAVE_DAYS;
  const yearPrefix = String(new Date().getFullYear());
  const exceptionalTypes = leaveTypes
    .filter((type) => isExceptionalLeaveType(type))
    .map((type) => {
      const used = mine
        .filter(
          (request) =>
            request.status === "Approved" &&
            request.leaveTypeId === type.id &&
            request.startDate.startsWith(yearPrefix),
        )
        .reduce(
          (total, request) =>
            total + requestedLeaveDays(request.startDate, request.endDate),
          0,
        );
      return { type, used, cap: type.defaultDays };
    });
  const annualDays = annual?.daysRemaining ?? 0;
  const soldeWarning = Boolean(annual) && annualDays <= 0;
  const firstParental = firstParentalLeave(
    mine,
    currentEmployee?.id ?? null,
  );
  const firstParentalKind =
    firstParental?.status === "Approved"
      ? "used"
      : firstParental?.status === "Pending"
        ? "pending"
        : "available";
  const secondParentalKind =
    firstParentalKind === "used" ? "available" : "locked";

  return (
    <div className="dashboard-page">
      <section className="welcome-row">
        <div>
          <p className="eyebrow">My workspace · {today}</p>
          <h1>Hello{hello ? `, ${hello}` : ""}</h1>
          <p className="page-subtitle">
            {soldeWarning
              ? "You can still request leave in advance; your solde will go negative."
              : "Your leave and authorization balances are below."}
          </p>
        </div>
        <Button onClick={() => setModal("request")}>
          <Plus size={17} /> Request leave
        </Button>
      </section>
      {soldeWarning && (
        <p className="solde-alert" role="alert">
          {annualDays < 0
            ? `You have no remaining annual solde. Your balance is in the negative (${annualDays} days).`
            : "You have no remaining annual solde. You can take leave in advance; your balance will go negative."}
        </p>
      )}
      <section className="metric-grid">
        <Metric
          label="Monthly Balance"
          value={String(monthlyDays)}
          note="days accrued each month"
          tone="rose"
          icon={<CalendarDays size={19} />}
        />
        <Metric
          label="Vacation Leave"
          value={String(annual?.daysRemaining ?? 0)}
          note={
            annualDays < 0
              ? "in the negative (advance)"
              : annualDays === 0
                ? "no days remaining — advance allowed"
                : "days remaining this year"
          }
          tone="indigo"
          icon={<Palmtree size={19} />}
          valueTone={annualDays < 0 ? "negative" : undefined}
        />
        <Metric
          label="Sick Leave"
          value={String(sick?.daysRemaining ?? 0)}
          note="days remaining this year"
          tone="teal"
          icon={<ShieldCheck size={19} />}
        />
        <Metric
          label="Auth Balance"
          value={authzBalance.remainingLabel}
          note={
            authzBalance.extraMinutes > 0
              ? `${authzBalance.extraLabel} over the free 8h`
              : `${authzBalance.usedDurationLabel} used this month`
          }
          tone={authzBalance.extraMinutes > 0 ? "rose" : "amber"}
          icon={<Clock3 size={19} />}
          valueTone={authzBalance.extraMinutes > 0 ? "negative" : undefined}
        />
      </section>
      <div className="card other-leave-card">
        <p className="eyebrow">This month</p>
        <h2>Authorization balance</h2>
        <div className="request-solde">
          <div>
            <span>Used</span>
            <b>{authzBalance.usedDurationLabel}</b>
          </div>
          <div>
            <span>Left of 8h</span>
            <b>{authzBalance.remainingLabel}</b>
          </div>
          <div className={authzBalance.extraMinutes > 0 ? "is-danger" : undefined}>
            <span>Extra</span>
            <b>{authzBalance.extraLabel}</b>
          </div>
        </div>
        <p>
          You get 8 free hours each month. Time above 8h takes 1 vacation day
          per extra 8 hours.
        </p>
        {authzBalance.extraMinutes > 0 && (
          <p className="solde-alert" role="alert">
            You have exceeded the free 8h this month by{" "}
            {authzBalance.extraLabel}
            {authzBalance.daysCharged > 0
              ? `. This takes ${
                  authzBalance.daysCharged === 1
                    ? "1 vacation day"
                    : `${authzBalance.daysCharged} vacation days`
                }`
              : ""}
            .
          </p>
        )}
        <div>
          <Button secondary onClick={() => setModal("authorization")}>
            Request authorization
          </Button>
        </div>
      </div>
      <section className="other-leave-board">
        <div className="other-leave-board-head">
          <p className="eyebrow">Also yours</p>
          <h2>Family and special leave</h2>
          <p>These days are extra. They never take from your vacation.</p>
        </div>
        <div className="other-leave-split">
          <article className="card other-leave-panel is-parental">
            <h3>Parental leave</h3>
            <p>
              You can take 3.5 months after you start. A second leave of up to
              4 months can follow when the first one ends.
            </p>
            <div className="parental-tile-list">
              <div className="parental-tile">
                <div>
                  <b>First parental leave</b>
                  <span>3.5 months after you start</span>
                </div>
                <em className={`leave-chip is-${firstParentalKind}`}>
                  {parentalStatus(firstParentalKind)}
                </em>
              </div>
              <div className="parental-tile">
                <div>
                  <b>Second parental leave</b>
                  <span>Up to 4 months after the first</span>
                </div>
                <em className={`leave-chip is-${secondParentalKind}`}>
                  {parentalStatus(secondParentalKind)}
                </em>
              </div>
            </div>
          </article>
          <article className="card other-leave-panel is-exceptional">
            <h3>Exceptional leave</h3>
            <p>
              For marriage, a death in the family, and similar events. Each
              type has its own days, and they start over on 1 January.
            </p>
            <ul className="exceptional-leave-grid">
              {exceptionalTypes.length === 0 && (
                <li>No exceptional leave types in the catalog yet.</li>
              )}
              {exceptionalTypes.map(({ type, used, cap }) => {
                const usedPct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
                const remaining = Math.max(0, cap - used);
                return (
                  <li key={type.id}>
                    <div className="exceptional-leave-copy">
                      <b lang="ar" dir="rtl">
                        {type.name}
                      </b>
                      <span className={remaining > 0 ? "is-remaining" : "is-used-up"}>
                        {remaining === 1
                          ? "1 day left"
                          : `${remaining} days left`}{" "}
                        this year
                      </span>
                    </div>
                    <div className="exceptional-leave-meter">
                      <span>
                        {used} / {cap}
                      </span>
                      <span
                        className="exceptional-leave-bar"
                        aria-hidden="true"
                      >
                        <i style={{ width: `${usedPct}%` }} />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </article>
        </div>
      </section>
    </div>
  );
}

function Profile({
  flash,
  employee,
  reload,
}: {
  flash: (message: string) => void;
  employee: Employee | null;
  reload: () => Promise<void>;
}) {
  const [phone, setPhone] = useState(employee?.phone ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPhone(employee?.phone ?? "");
  }, [employee?.id, employee?.phone]);

  const uploadPhoto = async (file: File | null) => {
    if (!file || uploadingPhoto || saving) return;
    setUploadingPhoto(true);
    const payload = new FormData();
    payload.append("file", file);
    try {
      const uploaded = await uploadEmployeeAvatar(payload);
      if (uploaded.error) {
        flash(uploaded.error);
        return;
      }
      await reload();
      flash("Photo updated");
    } finally {
      setUploadingPhoto(false);
    }
  };

  const save = async () => {
    if (saving || uploadingPhoto) return;
    if (!employee) {
      flash("You must be signed in");
      return;
    }

    const current = currentPassword.trim();
    const next = newPassword.trim();
    if (current && !next) {
      flash("Enter a new password");
      return;
    }
    if (next && !current) {
      flash("Enter your current password");
      return;
    }
    if (next && next.length < 8) {
      flash("Use at least 8 characters");
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

    const { error: phoneError } = await supabase
      .from("employees")
      .update({ phone: phone.trim() || null })
      .eq("id", user.id);
    if (phoneError) {
      setSaving(false);
      flash(phoneError.message);
      return;
    }

    if (current && next) {
      const { error: signError } = await supabase.auth.signInWithPassword({
        email: employee.email,
        password: current,
      });
      if (signError) {
        setSaving(false);
        flash(signError.message);
        return;
      }
      const { error: passwordError } = await supabase.auth.updateUser({
        password: next,
      });
      if (passwordError) {
        setSaving(false);
        flash(passwordError.message);
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
    }

    await reload();
    flash("Profile saved successfully");
    setSaving(false);
  };

  return (
    <div className="profile-page">
      <section className="welcome-row">
        <div>
          <p className="eyebrow">My workspace</p>
          <h1>My profile</h1>
          <p className="page-subtitle">
            Your work details are set by HR. You can update your phone number
            and password.
          </p>
        </div>
      </section>
      <section className="card profile-identity">
        <Avatar
          e={
            employee ?? {
              initials: "?",
              color: "avatar-slate",
              avatarUrl: null,
            }
          }
        />
        <div className="profile-identity-copy">
          <h2>{employee?.name || "Your profile"}</h2>
          <p>
            {[
              displayValue(employee?.jobTitle),
              employee?.department,
            ]
              .filter((part) => part && part !== "—")
              .join(" · ") || "No job title on file"}
          </p>
          {employee?.status ? <Status status={employee.status} /> : null}
        </div>
        <div className="profile-photo-actions">
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
          <Button
            type="button"
            secondary
            onClick={() => {
              if (uploadingPhoto || saving) return;
              photoInput.current?.click();
            }}
          >
            {uploadingPhoto
              ? "Uploading..."
              : employee?.avatarUrl
                ? "Change photo"
                : "Upload photo"}
          </Button>
        </div>
      </section>
      <div className="profile-grid" key={employee?.id ?? "profile"}>
        <section className="card profile-section">
          <h2>Contact</h2>
          <p>Phone is the only contact field you can edit.</p>
          <Field
            label="Phone"
            name="phone"
            value={phone}
            onChange={setPhone}
          />
          <div className="profile-facts">
            <div>
              <span>Work email</span>
              <b>{employee?.email || "—"}</b>
            </div>
          </div>
        </section>
        <section className="card profile-section">
          <h2>Employment</h2>
          <p>These details come from your employee record.</p>
          <div className="profile-facts">
            <div>
              <span>Full name</span>
              <b>{employee?.name || "—"}</b>
            </div>
            <div>
              <span>Job title</span>
              <b>{displayValue(employee?.jobTitle)}</b>
            </div>
            <div>
              <span>Department</span>
              <b>{employee?.department || "—"}</b>
            </div>
            <div>
              <span>Role</span>
              <b>{employee?.role || "—"}</b>
            </div>
            <div>
              <span>Status</span>
              <b>{employee?.status || "—"}</b>
            </div>
            <div>
              <span>Start date</span>
              <b>{formatDisplayDate(employee?.startDate)}</b>
            </div>
            <div>
              <span>Monthly leave days</span>
              <b>
                {employee?.monthlyLeaveDays ?? DEFAULT_MONTHLY_LEAVE_DAYS} days
              </b>
            </div>
          </div>
        </section>
        <section className="card profile-section profile-section-wide">
          <h2>Password</h2>
          <p>Leave these blank to keep your current password.</p>
          <div className="form-row">
            <Field
              label="Current password"
              name="current_password"
              type="password"
              value={currentPassword}
              onChange={setCurrentPassword}
            />
            <Field
              label="New password"
              name="new_password"
              type="password"
              value={newPassword}
              onChange={setNewPassword}
            />
          </div>
        </section>
      </div>
      <div className="profile-actions">
        <Button type="button" onClick={() => void save()}>
          {saving ? "Saving..." : "Save profile"}
        </Button>
      </div>
    </div>
  );
}
