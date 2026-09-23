"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Filter,
  History,
  LoaderCircle,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  Timer,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { Header, Metric } from "@/components/primitives";
import {
  ATTENDANCE_TIMEZONE,
  formatAttendanceDuration,
  type AttendanceApiError,
  type AttendanceCorrectionRequest,
  type AttendanceDaySummary,
  type AttendancePunchType,
  type AttendanceReportItem,
  type AttendanceSettings,
  type AttendanceTimelineItem,
  type CorrectionOperation,
  type ScheduleAssignment,
  type ScheduleSegment,
  type WorkSchedule,
} from "@/lib/attendance";
import type { Department, Employee } from "@/lib/app-types";
import {
  screenLabel,
  translateStatus,
  useLanguage,
  useT,
} from "@/lib/i18n";

type TodayAttendance = AttendanceDaySummary & {
  previousIncomplete: AttendanceDaySummary | null;
};

type CorrectionDraft = {
  operation: CorrectionOperation;
  target: AttendanceTimelineItem | null;
};

const clockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: ATTENDANCE_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: ATTENDANCE_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
});

function formatClockDay(value: Date, dateLocale: string) {
  return new Intl.DateTimeFormat(dateLocale, {
    timeZone: ATTENDANCE_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(value);
}

function apiMessage(payload: unknown, fallback: string) {
  const response = payload as Partial<AttendanceApiError> | null;
  return response?.error?.message ?? fallback;
}

async function fetchToday(signal?: AbortSignal, fallback?: string) {
  const response = await fetch("/api/attendance/today", {
    cache: "no-store",
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(apiMessage(payload, fallback ?? "Attendance could not be loaded."));
  }
  return payload as TodayAttendance;
}

function formatTime(value: string | null) {
  return value ? timeFormatter.format(new Date(value)) : "—";
}

function datetimeLocalValue(value: string) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function tunisLocalToIso(value: string) {
  return new Date(`${value}:00+01:00`).toISOString();
}

function statusCopy(
  t: ReturnType<typeof useT>,
  state: AttendanceDaySummary["state"],
) {
  if (state === "present") return t("att.present");
  if (state === "locked") return t("att.locked");
  if (state === "incomplete") return t("att.incomplete");
  return t("att.absent");
}

function punchTypeLabel(t: ReturnType<typeof useT>, type: AttendancePunchType) {
  return type === "entry" ? t("att.entry") : t("att.exit");
}

function operationLabel(t: ReturnType<typeof useT>, operation: CorrectionOperation) {
  if (operation === "add") return t("att.addPunch");
  if (operation === "change") return t("att.changePunch");
  return t("att.removePunch");
}

function segmentKindLabel(t: ReturnType<typeof useT>, kind: string) {
  if (kind === "work") return t("att.work");
  if (kind === "break") return t("att.break");
  return kind;
}

const WEEKDAY_KEYS = [
  "att.monday",
  "att.tuesday",
  "att.wednesday",
  "att.thursday",
  "att.friday",
  "att.saturday",
  "att.sunday",
] as const;

function localIsoDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftIsoDate(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function EmployeeTimeClock({
  flash,
}: {
  flash: (message: string) => void;
}) {
  const { t, dateLocale } = useLanguage();
  const [attendance, setAttendance] = useState<TodayAttendance | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [correction, setCorrection] = useState<CorrectionDraft | null>(null);
  const serverOffset = useRef(0);
  const pendingIdempotencyKey = useRef<string | null>(null);

  const syncAttendance = useCallback((next: TodayAttendance) => {
    serverOffset.current = new Date(next.serverTime).getTime() - Date.now();
    setAttendance(next);
    setNow(Date.now());
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError("");
    try {
      syncAttendance(await fetchToday(signal, t("att.loadFailed")));
      pendingIdempotencyKey.current = null;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(error instanceof Error ? error.message : t("att.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [syncAttendance, t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const liveNow = new Date(now + serverOffset.current);
  const openMinutes = attendance?.openSince
    ? Math.max(
        0,
        Math.floor(
          (liveNow.getTime() - new Date(attendance.openSince).getTime()) / 60_000,
        ),
      )
    : 0;

  const punch = async () => {
    if (!attendance || !attendance.nextAction || busy) return;
    setBusy(true);
    const key = pendingIdempotencyKey.current ?? crypto.randomUUID();
    pendingIdempotencyKey.current = key;
    try {
      const response = await fetch("/api/attendance/punch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: key,
          expectedLatestPunchId: attendance.latestPunchId,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const code = (payload as Partial<AttendanceApiError>)?.error?.code;
        if (code === "STALE_STATE" || code === "MAX_SESSIONS") {
          pendingIdempotencyKey.current = null;
          await load();
        }
        flash(apiMessage(payload, t("att.punchFailed")));
        return;
      }
      pendingIdempotencyKey.current = null;
      syncAttendance({
        ...(payload as TodayAttendance),
        previousIncomplete: attendance.previousIncomplete,
      });
      flash(
        attendance.nextAction === "entry"
          ? t("att.entryOk")
          : t("att.exitOk"),
      );
    } catch {
      flash(t("att.networkRetry"));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !attendance) {
    return (
      <div className="attendance-loading">
        <LoaderCircle className="spin" size={24} />
        {t("att.loading")}
      </div>
    );
  }

  if (!attendance) {
    return (
      <div className="attendance-error card">
        <AlertTriangle size={24} />
        <h2>{t("att.unavailable")}</h2>
        <p>{loadError}</p>
        <button className="secondary-button" type="button" onClick={() => void load()}>
          <RefreshCw size={15} /> {t("common.tryAgain")}
        </button>
      </div>
    );
  }

  const isPresent = attendance.state === "present";
  const actionLabel =
    attendance.nextAction === "entry" ? t("att.clockIn") : t("att.clockOut");

  return (
    <div className="attendance-page">
      <Header
        eyebrow={t("employee.workspace")}
        title={screenLabel(t, "Time clock")}
        action={
          <button
            type="button"
            className="attendance-refresh"
            aria-label={t("att.refresh")}
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={loading ? "spin" : ""} size={16} />
          </button>
        }
      />

      {attendance.previousIncomplete && (
        <div className="attendance-warning" role="alert">
          <AlertTriangle size={18} />
          <div>
            <b>
              {t("att.incompleteDay", {
                date: attendance.previousIncomplete.workDate,
              })}
            </b>
            <span>{t("att.missingExit")}</span>
          </div>
          <button
            type="button"
            onClick={() => setCorrection({ operation: "add", target: null })}
          >
            {t("att.requestCorrection")}
          </button>
        </div>
      )}

      <section className={`clock-hero card is-${attendance.state}`}>
        <div className="clock-status">
          <span className="clock-status-dot" />
          {statusCopy(t, attendance.state)}
        </div>
        <p className="clock-date">{formatClockDay(liveNow, dateLocale)}</p>
        <strong className="clock-time">{clockFormatter.format(liveNow)}</strong>
        {isPresent && attendance.openSince ? (
          <p className="clock-since">
            {t("att.presentSince", {
              time: formatTime(attendance.openSince),
              duration: formatAttendanceDuration(openMinutes),
            })}
          </p>
        ) : (
          <p className="clock-since">
            {attendance.state === "locked"
              ? t("att.maxSessions")
              : t("att.ready")}
          </p>
        )}
        <button
          type="button"
          className={`punch-button ${isPresent ? "is-exit" : "is-entry"}`}
          disabled={busy || !attendance.nextAction}
          onClick={punch}
        >
          {busy ? (
            <LoaderCircle className="spin" size={20} />
          ) : attendance.nextAction === "entry" ? (
            <ArrowDownToLine size={20} />
          ) : (
            <ArrowUpFromLine size={20} />
          )}
          {attendance.nextAction ? actionLabel : t("att.unavailableAction")}
        </button>
        {attendance.blockReason && (
          <small className="clock-block-reason">
            {attendance.blockReason === "MAX_SESSIONS"
              ? t("att.maxFive")
              : t("att.contactHr")}
          </small>
        )}
      </section>

      <section className="metric-grid attendance-metrics">
        <Metric
          label={t("att.totalWorked")}
          value={formatAttendanceDuration(attendance.workedMinutes)}
          note={
            isPresent
              ? t("att.activeExtra", {
                  duration: formatAttendanceDuration(openMinutes),
                })
              : t("att.completedSessions")
          }
          tone="teal"
          icon={<Timer size={19} />}
        />
        <Metric
          label={t("att.firstEntry")}
          value={formatTime(attendance.firstEntryAt)}
          note={t("common.today")}
          tone="indigo"
          icon={<ArrowDownToLine size={19} />}
        />
        <Metric
          label={t("att.lastExit")}
          value={formatTime(attendance.lastExitAt)}
          note={isPresent ? t("att.workingNow") : t("common.today")}
          tone="rose"
          icon={<ArrowUpFromLine size={19} />}
        />
        <Metric
          label={t("att.sessions")}
          value={`${attendance.completedSessions}/${attendance.sessionsStarted}`}
          note={t("att.remaining", { count: attendance.remainingSessions })}
          tone="amber"
          icon={<History size={19} />}
        />
      </section>

      <div className="attendance-details">
        <section className="card attendance-panel">
          <div className="attendance-panel-head">
            <div>
              <p className="eyebrow">{t("common.today")}</p>
              <h2>{t("att.sessions")}</h2>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setCorrection({ operation: "add", target: null })}
            >
              <Plus size={15} /> {t("att.missingPunch")}
            </button>
          </div>
          {attendance.sessions.length === 0 ? (
            <div className="attendance-empty">
              <CalendarClock size={25} />
              <p>{t("att.noSessions")}</p>
            </div>
          ) : (
            <div className="session-list">
              {attendance.sessions.map((session, index) => (
                <article className="session-card" key={session.entryId}>
                  <span className="session-number">{index + 1}</span>
                  <div>
                    <b>
                      {formatTime(session.entryAt)} — {formatTime(session.exitAt)}
                    </b>
                    <small>
                      {session.durationMinutes == null
                        ? t("att.inProgress")
                        : formatAttendanceDuration(session.durationMinutes)}
                    </small>
                  </div>
                  {session.exitAt ? (
                    <CheckCircle2 size={18} className="session-complete" />
                  ) : (
                    <Clock3 size={18} className="session-open" />
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="card attendance-panel">
          <div className="attendance-panel-head">
            <div>
              <p className="eyebrow">{t("att.recorded")}</p>
              <h2>{t("att.timeline")}</h2>
            </div>
          </div>
          {attendance.timeline.length === 0 ? (
            <div className="attendance-empty">
              <History size={25} />
              <p>{t("att.timelineEmpty")}</p>
            </div>
          ) : (
            <div className="attendance-timeline">
              {attendance.timeline.map((item) => (
                <article key={item.id}>
                  <span className={`timeline-icon is-${item.type}`}>
                    {item.type === "entry" ? (
                      <ArrowDownToLine size={15} />
                    ) : (
                      <ArrowUpFromLine size={15} />
                    )}
                  </span>
                  <div>
                    <b>{punchTypeLabel(t, item.type)}</b>
                    <small>{formatTime(item.occurredAt)}</small>
                  </div>
                  <button
                    type="button"
                    aria-label={t("att.correctPunch", {
                      type: punchTypeLabel(t, item.type),
                      time: formatTime(item.occurredAt),
                    })}
                    onClick={() => setCorrection({ operation: "change", target: item })}
                  >
                    <PencilLine size={14} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {correction && (
        <CorrectionRequestModal
          draft={correction}
          defaultWorkDate={
            correction.target
              ? attendance.workDate
              : attendance.previousIncomplete?.workDate ?? attendance.workDate
          }
          close={() => setCorrection(null)}
          submitted={async () => {
            setCorrection(null);
            flash(t("att.correctionSent"));
            await load();
          }}
        />
      )}
    </div>
  );
}

export function AttendanceOverviewCard({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const t = useT();
  const [attendance, setAttendance] = useState<TodayAttendance | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchToday(controller.signal, t("att.loadFailed"))
      .then(setAttendance)
      .catch(() => undefined);
    return () => controller.abort();
  }, [t]);

  if (!attendance) return null;
  return (
    <button type="button" className="attendance-overview-card card" onClick={onOpen}>
      <span className={`clock-status is-${attendance.state}`}>
        <span className="clock-status-dot" />
        {statusCopy(t, attendance.state)}
      </span>
      <span>
        <b>{screenLabel(t, "Time clock")}</b>
        <small>
          {attendance.state === "present" && attendance.openSince
            ? t("att.since", { time: formatTime(attendance.openSince) })
            : t("att.sessionsDone", { count: attendance.completedSessions })}
        </small>
      </span>
      <strong>
        {formatAttendanceDuration(
          attendance.workedMinutes + (attendance.state === "present" ? attendance.openMinutes : 0),
        )}
      </strong>
      <span className="attendance-overview-action">{t("common.open")}</span>
    </button>
  );
}

export function AdminAttendance({
  employees,
  departments,
  flash,
  focusCorrectionId = null,
  onNoticeFocusHandled,
}: {
  employees: Employee[];
  departments: Department[];
  flash: (message: string) => void;
  focusCorrectionId?: string | null;
  onNoticeFocusHandled?: () => void;
}) {
  const t = useT();
  const today = localIsoDate();
  const [tab, setTab] = useState<"records" | "corrections">("records");
  const [from, setFrom] = useState(shiftIsoDate(today, -29));
  const [to, setTo] = useState(today);
  const [employeeId, setEmployeeId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AttendanceReportItem[]>([]);
  const [total, setTotal] = useState(0);
  const [corrections, setCorrections] = useState<AttendanceCorrectionRequest[]>([]);
  const [correctionStatus, setCorrectionStatus] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedCorrection, setSelectedCorrection] =
    useState<AttendanceCorrectionRequest | null>(null);
  const pageSize = 20;

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      from,
      to,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (employeeId) params.set("employeeId", employeeId);
    if (departmentId) params.set("departmentId", departmentId);
    if (status) params.set("status", status);
    try {
      const response = await fetch(`/api/attendance?${params}`, {
        cache: "no-store",
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(payload, t("att.recordsFailed")));
      }
      const result = payload as {
        items: AttendanceReportItem[];
        total: number;
      };
      setItems(result.items ?? []);
      setTotal(result.total ?? 0);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("att.recordsFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [departmentId, employeeId, from, page, status, t, to]);

  const loadCorrections = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "100" });
    if (correctionStatus) params.set("status", correctionStatus);
    try {
      const response = await fetch(
        `/api/attendance/correction-requests?${params}`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          apiMessage(payload, t("att.correctionsFailed")),
        );
      }
      const result = payload as { items: AttendanceCorrectionRequest[] };
      setCorrections(result.items ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("att.correctionsFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [correctionStatus, t]);

  useEffect(() => {
    if (tab === "records") void loadRecords();
    else void loadCorrections();
  }, [loadCorrections, loadRecords, tab]);

  useEffect(() => {
    if (!focusCorrectionId) return;
    setTab("corrections");
    setCorrectionStatus("");
  }, [focusCorrectionId]);

  useEffect(() => {
    if (!focusCorrectionId) return;
    const match = corrections.find((item) => item.id === focusCorrectionId);
    if (!match) return;
    setSelectedCorrection(match);
    onNoticeFocusHandled?.();
  }, [corrections, focusCorrectionId, onNoticeFocusHandled]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const totalWorked = items.reduce((sum, item) => sum + item.workedMinutes, 0);
  const incomplete = items.filter((item) => item.state === "incomplete").length;
  const present = items.filter((item) => item.state === "present").length;
  const employeeName = (id: string) =>
    employees.find((employee) => employee.id === id)?.name ?? t("att.unknown");

  return (
    <div className="admin-attendance-page">
      <Header
        eyebrow={t("att.adminEyebrow")}
        title={screenLabel(t, "Attendance")}
        action={
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              void (tab === "records" ? loadRecords() : loadCorrections())
            }
          >
            <RefreshCw className={loading ? "spin" : ""} size={15} />
            {t("common.refresh")}
          </button>
        }
      />

      <div className="attendance-admin-tabs">
        <button
          type="button"
          className={tab === "records" ? "active" : ""}
          onClick={() => setTab("records")}
        >
          <Clock3 size={16} /> {t("att.records")}
        </button>
        <button
          type="button"
          className={tab === "corrections" ? "active" : ""}
          onClick={() => setTab("corrections")}
        >
          <PencilLine size={16} /> {t("att.corrections")}
          {corrections.filter((item) => item.status === "pending").length > 0 && (
            <span>
              {corrections.filter((item) => item.status === "pending").length}
            </span>
          )}
        </button>
      </div>

      {error && (
        <div className="attendance-warning" role="alert">
          <AlertTriangle size={18} />
          <div>
            <b>{t("att.dataFailed")}</b>
            <span>{error}</span>
          </div>
        </div>
      )}

      {tab === "records" ? (
        <>
          <section className="metric-grid attendance-metrics">
            <Metric
              label={t("att.employeeDays")}
              value={String(total)}
              note={t("att.matchingRange")}
              tone="indigo"
              icon={<Users size={19} />}
            />
            <Metric
              label={t("att.workedPage")}
              value={formatAttendanceDuration(totalWorked)}
              note={t("att.displayed", { count: items.length })}
              tone="teal"
              icon={<Timer size={19} />}
            />
            <Metric
              label={t("att.currentlyPresent")}
              value={String(present)}
              note={t("att.withinPage")}
              tone="amber"
              icon={<CheckCircle2 size={19} />}
            />
            <Metric
              label={t("att.incomplete")}
              value={String(incomplete)}
              note={t("att.needsCorrection")}
              tone="rose"
              icon={<AlertTriangle size={19} />}
            />
          </section>

          <section className="card attendance-report-card">
            <div className="attendance-report-filters">
              <span className="filter-title">
                <Filter size={15} /> {t("att.filters")}
              </span>
              <label>
                {t("att.from")}
                <input
                  type="date"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label>
                {t("att.to")}
                <input
                  type="date"
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label>
                {t("admin.colEmployee")}
                <select
                  value={employeeId}
                  onChange={(event) => {
                    setEmployeeId(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">{t("att.allEmployees")}</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("filter.department")}
                <select
                  value={departmentId}
                  onChange={(event) => {
                    setDepartmentId(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">{t("admin.allDepartments")}</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("filter.status")}
                <select
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">{t("att.allStatuses")}</option>
                  <option value="present">{t("att.present")}</option>
                  <option value="absent">{t("att.completed")}</option>
                  <option value="incomplete">{t("att.incomplete")}</option>
                  <option value="locked">{t("att.locked")}</option>
                </select>
              </label>
            </div>

            <div className="attendance-report-table">
              <div className="attendance-report-row is-head">
                <span>{t("admin.colEmployee")}</span>
                <span>{t("att.colDate")}</span>
                <span>{t("filter.status")}</span>
                <span>{t("att.colFirstLast")}</span>
                <span>{t("att.colWorked")}</span>
                <span>{t("att.sessions")}</span>
                <span />
              </div>
              {loading ? (
                <div className="attendance-report-empty">
                  <LoaderCircle className="spin" size={20} /> {t("att.loadingRecords")}
                </div>
              ) : items.length === 0 ? (
                <div className="attendance-report-empty">
                  <Search size={22} /> {t("att.noRecords")}
                </div>
              ) : (
                items.map((item) => (
                  <div className="attendance-report-entry" key={`${item.employeeId}:${item.workDate}`}>
                    <button
                      type="button"
                      className="attendance-report-row"
                      onClick={() =>
                        setExpandedId(
                          expandedId === `${item.employeeId}:${item.workDate}`
                            ? null
                            : `${item.employeeId}:${item.workDate}`,
                        )
                      }
                    >
                      <span>
                        <b>{item.employeeName}</b>
                        <small>{item.departmentName}</small>
                      </span>
                      <span>{item.workDate}</span>
                      <span>
                        <em className={`attendance-state is-${item.state}`}>
                          {statusCopy(t, item.state)}
                        </em>
                      </span>
                      <span>
                        {formatTime(item.firstEntryAt)} / {formatTime(item.lastExitAt)}
                      </span>
                      <span>{formatAttendanceDuration(item.workedMinutes)}</span>
                      <span>{item.sessionsStarted}</span>
                      <span>
                        {expandedId === `${item.employeeId}:${item.workDate}` ? (
                          <ChevronUp size={16} />
                        ) : (
                          <ChevronDown size={16} />
                        )}
                      </span>
                    </button>
                    {expandedId === `${item.employeeId}:${item.workDate}` && (
                      <AttendanceRecordDetail item={item} />
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="attendance-report-pagination">
              <span>
                {t("att.pageSummary", {
                  page,
                  pageCount,
                  total,
                })}
              </span>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  {t("common.previous")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={page >= pageCount}
                  onClick={() =>
                    setPage((current) => Math.min(pageCount, current + 1))
                  }
                >
                  {t("common.next")}
                </button>
              </div>
            </div>
          </section>
        </>
      ) : (
        <section className="card correction-queue">
          <div className="correction-queue-head">
            <div>
              <p className="eyebrow">{t("att.reviewQueue")}</p>
              <h2>{t("att.corrections")}</h2>
            </div>
            <select
              value={correctionStatus}
              onChange={(event) => setCorrectionStatus(event.target.value)}
            >
              <option value="">{t("att.allStatuses")}</option>
              <option value="pending">{translateStatus(t, "pending")}</option>
              <option value="approved">{translateStatus(t, "approved")}</option>
              <option value="rejected">{translateStatus(t, "rejected")}</option>
            </select>
          </div>
          {loading ? (
            <div className="attendance-report-empty">
              <LoaderCircle className="spin" size={20} /> {t("att.loadingRequests")}
            </div>
          ) : corrections.length === 0 ? (
            <div className="attendance-report-empty">
              <CheckCircle2 size={24} /> {t("att.noCorrections")}
            </div>
          ) : (
            <div className="correction-request-list">
              {corrections.map((request) => (
                <button
                  type="button"
                  key={request.id}
                  onClick={() => setSelectedCorrection(request)}
                >
                  <span className={`timeline-icon is-${request.proposedType ?? "exit"}`}>
                    <PencilLine size={14} />
                  </span>
                  <span>
                    <b>{employeeName(request.employeeId)}</b>
                    <small>
                      {request.workDate} · {operationLabel(t, request.operation)}
                    </small>
                  </span>
                  <em className={`attendance-state is-${request.status}`}>
                    {translateStatus(t, request.status)}
                  </em>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {selectedCorrection && (
        <CorrectionDecisionPanel
          request={selectedCorrection}
          employeeName={employeeName(selectedCorrection.employeeId)}
          close={() => setSelectedCorrection(null)}
          decided={async (decision) => {
            setSelectedCorrection(null);
            flash(
              t("att.decided", {
                decision: translateStatus(t, decision).toLowerCase(),
              }),
            );
            await loadCorrections();
          }}
        />
      )}
    </div>
  );
}

export function AdminAttendanceOverviewCard({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const t = useT();
  const [records, setRecords] = useState<AttendanceReportItem[]>([]);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const today = localIsoDate();
    Promise.all([
      fetch(
        `/api/attendance?from=${today}&to=${today}&page=1&pageSize=100`,
        { cache: "no-store", signal: controller.signal },
      ),
      fetch("/api/attendance/correction-requests?status=pending&limit=100", {
        cache: "no-store",
        signal: controller.signal,
      }),
    ])
      .then(async ([attendanceResponse, correctionsResponse]) => {
        if (attendanceResponse.ok) {
          const result = (await attendanceResponse.json()) as {
            items?: AttendanceReportItem[];
          };
          setRecords(result.items ?? []);
        }
        if (correctionsResponse.ok) {
          const result = (await correctionsResponse.json()) as {
            items?: AttendanceCorrectionRequest[];
          };
          setPending(result.items?.length ?? 0);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const present = records.filter((item) => item.state === "present").length;
  const incomplete = records.filter((item) => item.state === "incomplete").length;
  return (
    <button type="button" className="admin-attendance-overview card" onClick={onOpen}>
      <span className="metric-icon metric-indigo">
        <Clock3 size={19} />
      </span>
      <span>
        <b>{t("att.todayTitle")}</b>
        <small>{t("att.todaySubtitle", { count: records.length })}</small>
      </span>
      <span>
        <b>{present}</b>
        <small>{t("att.present")}</small>
      </span>
      <span className={incomplete ? "is-warning" : ""}>
        <b>{incomplete}</b>
        <small>{t("att.incomplete")}</small>
      </span>
      <span className={pending ? "is-warning" : ""}>
        <b>{pending}</b>
        <small>{t("att.corrections")}</small>
      </span>
      <em>{t("att.openAttendance")}</em>
    </button>
  );
}

function AttendanceRecordDetail({ item }: { item: AttendanceReportItem }) {
  const t = useT();
  return (
    <div className="attendance-record-detail">
      <div>
        <p className="eyebrow">{t("att.timeline")}</p>
        {item.timeline.map((punch) => (
          <span key={punch.id}>
            <b>{punchTypeLabel(t, punch.type)}</b>
            {formatTime(punch.occurredAt)}
          </span>
        ))}
      </div>
      <div>
        <p className="eyebrow">{t("att.schedule")}</p>
        {item.scheduleSegments.length === 0 ? (
          <span>{t("att.unscheduled")}</span>
        ) : (
          item.scheduleSegments.map((segment, index) => (
            <span key={segment.id ?? index}>
              <b>{segmentKindLabel(t, segment.kind)}</b>
              {segment.startTime.slice(0, 5)}–{segment.endTime.slice(0, 5)}
            </span>
          ))
        )}
      </div>
      <div>
        <p className="eyebrow">{t("tabs.authorizations")}</p>
        {item.authorizations.length === 0 ? (
          <span>{t("common.none")}</span>
        ) : (
          item.authorizations.map((authorization) => (
            <span key={authorization.id}>
              <b>{authorization.startTime.slice(0, 5)}–{authorization.endTime.slice(0, 5)}</b>
              {authorization.reason}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function CorrectionDecisionPanel({
  request,
  employeeName,
  close,
  decided,
}: {
  request: AttendanceCorrectionRequest;
  employeeName: string;
  close: () => void;
  decided: (decision: "approved" | "rejected") => Promise<void>;
}) {
  const t = useT();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState("");
  const [original, setOriginal] = useState<AttendanceReportItem | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      from: request.workDate,
      to: request.workDate,
      employeeId: request.employeeId,
      page: "1",
      pageSize: "1",
    });
    fetch(`/api/attendance?${params}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { items?: AttendanceReportItem[] };
      })
      .then((payload) => setOriginal(payload?.items?.[0] ?? null))
      .catch(() => undefined);
    return () => controller.abort();
  }, [request.employeeId, request.workDate]);

  const decide = async (decision: "approved" | "rejected") => {
    setBusy(decision);
    setError("");
    try {
      const response = await fetch(
        `/api/attendance/correction-requests/${request.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, note: note.trim() || null }),
        },
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        setError(apiMessage(payload, t("att.decisionFailed")));
        return;
      }
      await decided(decision);
    } catch {
      setError(t("att.network"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section
        className="card modal correction-decision"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="panel-close" onClick={close}>
          <X size={18} />
        </button>
        <p className="eyebrow">{t("att.correctionEyebrow")}</p>
        <h2>{employeeName}</h2>
        <div className="correction-original">
          <p>{t("att.original")}</p>
          {original?.timeline.length ? (
            original.timeline.map((punch) => (
              <span key={punch.id}>
                <b>{punchTypeLabel(t, punch.type)}</b>
                {formatTime(punch.occurredAt)}
              </span>
            ))
          ) : (
            <span>{t("att.noPunches")}</span>
          )}
        </div>
        <dl>
          <div>
            <dt>{t("att.workDate")}</dt>
            <dd>{request.workDate}</dd>
          </div>
          <div>
            <dt>{t("att.operation")}</dt>
            <dd>{operationLabel(t, request.operation)}</dd>
          </div>
          {request.proposedType && (
            <div>
              <dt>{t("att.proposed")}</dt>
              <dd>
                {punchTypeLabel(t, request.proposedType)} ·{" "}
                {formatTime(request.proposedOccurredAt)}
              </dd>
            </div>
          )}
          <div>
            <dt>{t("att.employeeReason")}</dt>
            <dd>{request.reason}</dd>
          </div>
        </dl>
        <label className="form-label">
          {t("att.reviewNote")}
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("att.reviewPlaceholder")}
            maxLength={2000}
          />
        </label>
        {error && (
          <p className="correction-error" role="alert">
            {error}
          </p>
        )}
        <div className="correction-decision-actions">
          <button
            type="button"
            className="decision-reject"
            disabled={busy !== null}
            onClick={() => void decide("rejected")}
          >
            {busy === "rejected" ? <LoaderCircle className="spin" size={15} /> : <Ban size={15} />}
            {t("common.reject")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== null}
            onClick={() => void decide("approved")}
          >
            {busy === "approved" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            {t("att.approveApply")}
          </button>
        </div>
      </section>
    </div>
  );
}

export function AttendanceScheduleSettings({
  employees,
  flash,
}: {
  employees: Employee[];
  flash: (message: string) => void;
}) {
  const t = useT();
  const [schedules, setSchedules] = useState<WorkSchedule[]>([]);
  const [settings, setSettings] = useState<AttendanceSettings | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<WorkSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/work-schedules", { cache: "no-store" });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(payload, t("att.schedulesFailed")));
      }
      const result = payload as {
        settings: AttendanceSettings;
        schedules: WorkSchedule[];
      };
      setSchedules(result.schedules);
      setSettings(result.settings);
      const selected =
        result.schedules.find((schedule) => schedule.id === selectedId) ??
        result.schedules.find((schedule) => schedule.isDefault) ??
        result.schedules[0] ??
        null;
      setSelectedId(selected?.id ?? "");
      setDraft(selected ? structuredClone(selected) : null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("att.schedulesFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [selectedId, t]);

  useEffect(() => {
    void load();
  }, []);

  const selectSchedule = (id: string) => {
    const selected = schedules.find((schedule) => schedule.id === id) ?? null;
    setSelectedId(id);
    setDraft(selected ? structuredClone(selected) : null);
  };

  const updateSegment = (
    index: number,
    field: keyof ScheduleSegment,
    value: string | number,
  ) => {
    if (!draft) return;
    setDraft({
      ...draft,
      segments: draft.segments.map((segment, itemIndex) =>
        itemIndex === index ? { ...segment, [field]: value } : segment,
      ),
    });
  };

  const save = async () => {
    if (!draft || !settings || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/work-schedules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule: draft, settings }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        setError(apiMessage(payload, t("att.scheduleSaveFailed")));
        return;
      }
      flash(t("att.scheduleSaved"));
      await load();
    } catch {
      setError(t("att.network"));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !draft) {
    return (
      <div className="settings-attendance-loading">
        <LoaderCircle className="spin" size={20} /> {t("att.settingsLoading")}
      </div>
    );
  }

  if (!draft || !settings) {
    return <p className="correction-error">{error || t("att.noSchedule")}</p>;
  }

  return (
    <div className="attendance-settings-editor">
      <div className="schedule-picker">
        <label className="form-label">
          {t("att.schedule")}
          <select value={selectedId} onChange={(event) => selectSchedule(event.target.value)}>
            {schedules.map((schedule) => (
              <option key={schedule.id} value={schedule.id}>
                {schedule.name}
                {schedule.isDefault ? t("att.defaultSuffix") : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="form-label">
          {t("att.scheduleName")}
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
      </div>

      <div className="attendance-settings-grid">
        <label className="form-label">
          {t("att.timezone")}
          <input value={settings.timezone} readOnly />
        </label>
        <label className="form-label">
          {t("att.grace")}
          <input
            type="number"
            min={0}
            max={120}
            value={settings.graceMinutes}
            onChange={(event) =>
              setSettings({ ...settings, graceMinutes: Number(event.target.value) })
            }
          />
        </label>
        <label className="form-label">
          {t("att.maxSessionsLabel")}
          <input
            type="number"
            min={1}
            max={5}
            value={settings.maxSessions}
            onChange={(event) =>
              setSettings({ ...settings, maxSessions: Number(event.target.value) })
            }
          />
        </label>
      </div>

      <div className="schedule-editor-head">
        <div>
          <p className="eyebrow">{t("att.weekly")}</p>
          <h3>{t("att.weeklyTitle")}</h3>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            setDraft({
              ...draft,
              segments: [
                ...draft.segments,
                {
                  isoWeekday: 1,
                  kind: "work",
                  startTime: "08:00",
                  endTime: "17:00",
                  position: draft.segments.length + 1,
                },
              ],
            })
          }
        >
          <Plus size={14} /> {t("att.addSegment")}
        </button>
      </div>
      <div className="schedule-segment-list">
        {draft.segments.map((segment, index) => (
          <div className="schedule-segment-row" key={segment.id ?? index}>
            <select
              value={segment.isoWeekday}
              onChange={(event) =>
                updateSegment(index, "isoWeekday", Number(event.target.value))
              }
            >
              {WEEKDAY_KEYS.map((dayKey, dayIndex) => (
                <option key={dayKey} value={dayIndex + 1}>
                  {t(dayKey)}
                </option>
              ))}
            </select>
            <select
              value={segment.kind}
              onChange={(event) => updateSegment(index, "kind", event.target.value)}
            >
              <option value="work">{t("att.work")}</option>
              <option value="break">{t("att.break")}</option>
            </select>
            <input
              type="time"
              value={segment.startTime.slice(0, 5)}
              onChange={(event) => updateSegment(index, "startTime", event.target.value)}
            />
            <span>{t("att.segmentTo")}</span>
            <input
              type="time"
              value={segment.endTime.slice(0, 5)}
              onChange={(event) => updateSegment(index, "endTime", event.target.value)}
            />
            <button
              type="button"
              aria-label={t("att.removeSegment")}
              onClick={() =>
                setDraft({
                  ...draft,
                  segments: draft.segments.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>

      <ScheduleAssignments
        assignments={draft.assignments ?? []}
        employees={employees}
        onChange={(assignments) => setDraft({ ...draft, assignments })}
      />

      {error && <p className="correction-error">{error}</p>}
      <button type="button" className="primary-button" disabled={saving} onClick={save}>
        {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
        {t("att.saveSettings")}
      </button>
    </div>
  );
}

function ScheduleAssignments({
  assignments,
  employees,
  onChange,
}: {
  assignments: ScheduleAssignment[];
  employees: Employee[];
  onChange: (assignments: ScheduleAssignment[]) => void;
}) {
  const t = useT();
  return (
    <div className="schedule-assignment-editor">
      <div className="schedule-editor-head">
        <div>
          <p className="eyebrow">{t("att.overrides")}</p>
          <h3>{t("att.assignments")}</h3>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={employees.length === 0}
          onClick={() =>
            onChange([
              ...assignments,
              {
                employeeId: employees[0]?.id ?? "",
                effectiveFrom: localIsoDate(),
                effectiveTo: null,
              },
            ])
          }
        >
          <Plus size={14} /> {t("att.addAssignment")}
        </button>
      </div>
      {assignments.map((assignment, index) => (
        <div className="schedule-assignment-row" key={assignment.id ?? index}>
          <select
            value={assignment.employeeId}
            onChange={(event) =>
              onChange(
                assignments.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, employeeId: event.target.value }
                    : item,
                ),
              )
            }
          >
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={assignment.effectiveFrom}
            onChange={(event) =>
              onChange(
                assignments.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, effectiveFrom: event.target.value }
                    : item,
                ),
              )
            }
          />
          <input
            type="date"
            value={assignment.effectiveTo ?? ""}
            onChange={(event) =>
              onChange(
                assignments.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, effectiveTo: event.target.value || null }
                    : item,
                ),
              )
            }
          />
          <button
            type="button"
            aria-label={t("att.removeAssignment")}
            onClick={() =>
              onChange(assignments.filter((_, itemIndex) => itemIndex !== index))
            }
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {assignments.length === 0 && (
        <p className="page-subtitle">
          {t("att.noOverrides")}
        </p>
      )}
    </div>
  );
}

function CorrectionRequestModal({
  draft,
  defaultWorkDate,
  close,
  submitted,
}: {
  draft: CorrectionDraft;
  defaultWorkDate: string;
  close: () => void;
  submitted: () => Promise<void>;
}) {
  const t = useT();
  const [operation, setOperation] = useState(draft.operation);
  const [type, setType] = useState<AttendancePunchType>(
    draft.target?.type ?? "entry",
  );
  const [occurredAt, setOccurredAt] = useState(
    draft.target
      ? datetimeLocalValue(draft.target.occurredAt)
      : `${defaultWorkDate}T09:00`,
  );
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const workDate = useMemo(() => occurredAt.slice(0, 10) || defaultWorkDate, [
    occurredAt,
    defaultWorkDate,
  ]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError(t("att.reasonShort"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/attendance/correction-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workDate,
          operation,
          targetPunchId: operation === "add" ? null : draft.target?.id,
          proposedType: operation === "void" ? null : type,
          proposedOccurredAt:
            operation === "void" ? null : tunisLocalToIso(occurredAt),
          reason: reason.trim(),
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        setError(apiMessage(payload, t("att.correctionSubmitFailed")));
        return;
      }
      await submitted();
    } catch {
      setError(t("att.network"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="card modal correction-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="panel-close" type="button" onClick={close}>
          <X size={18} />
        </button>
        <p className="eyebrow">{screenLabel(t, "Attendance")}</p>
        <h2>{t("att.correctionTitle")}</h2>
        <p className="correction-copy">
          {t("att.correctionBody")}
        </p>
        <label className="form-label">
          {t("att.operation")}
          <select
            value={operation}
            onChange={(event) => setOperation(event.target.value as CorrectionOperation)}
            disabled={!draft.target}
          >
            <option value="add">{t("att.addPunch")}</option>
            {draft.target && <option value="change">{t("att.changePunch")}</option>}
            {draft.target && <option value="void">{t("att.removePunch")}</option>}
          </select>
        </label>
        {operation !== "void" && (
          <div className="form-row">
            <label className="form-label">
              {t("att.punchType")}
              <select
                value={type}
                onChange={(event) => setType(event.target.value as AttendancePunchType)}
              >
                <option value="entry">{t("att.entry")}</option>
                <option value="exit">{t("att.exit")}</option>
              </select>
            </label>
            <label className="form-label">
              {t("att.dateTime")}
              <input
                type="datetime-local"
                value={occurredAt}
                onChange={(event) => setOccurredAt(event.target.value)}
                required
              />
            </label>
          </div>
        )}
        <label className="form-label">
          {t("modal.reason")}
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("att.reasonHint")}
            maxLength={2000}
            required
          />
        </label>
        {error && (
          <p className="correction-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={close}>
            {t("common.cancel")}
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving && <LoaderCircle className="spin" size={15} />}
            {t("att.submitCorrection")}
          </button>
        </div>
      </form>
    </div>
  );
}
