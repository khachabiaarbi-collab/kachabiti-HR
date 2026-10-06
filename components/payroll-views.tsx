"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Banknote,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Plus,
  Printer,
  RefreshCw,
  Settings2,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import type { Employee } from "@/lib/app-types";
import { ConfirmModal } from "@/components/modals";
import { Avatar, Button, Field, Header, Metric } from "@/components/primitives";
import { useLanguage } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages";
import { formatDisplayDate, isoDate } from "@/lib/map-rows";
import {
  CONTRACT_SELECT,
  CONTRACT_TYPES,
  MARITAL_STATUSES,
  contractNeedsEnd,
  currentContract,
  formatTnd,
  isMissingPayrollTable,
  mapContract,
  type ContractType,
  type EmployeeContract,
  type EmployeeContractRow,
  type MaritalStatus,
  type PayBasis,
} from "@/lib/payroll";
import {
  SIMULATION_DAY_HOURS,
  amountInFrenchWords,
  isExemptContract,
  simulatePay,
  round3,
  type IrppBracket,
  type PayItem,
  type PayVariables,
} from "@/lib/payroll-calc";
import {
  addEmployeeComponent,
  deleteDraftRun,
  effectiveVariables,
  endEmployeeComponent,
  exclusionReason,
  isMonthInProgress,
  loadCompany,
  loadComponents,
  loadContractPeriods,
  loadEmployeeComponents,
  loadMyPayslips,
  loadPublishedPayslips,
  loadPayslips,
  loadRun,
  loadSettings,
  monthLabel,
  monthRange,
  prepareRun,
  ratesOnly,
  saveCompany,
  saveComponent,
  saveSettings,
  setRunStatus,
  shiftMonth,
  toPayItem,
  updatePayslip,
  type ContractPeriod,
  type EmployeePayComponent,
  type PayComponent,
  type PayrollCompany,
  type Payslip,
  type PayslipWarning,
  type PayrollRun,
  type PayrollSettings,
} from "@/lib/payroll-run";
import {
  annualTaxCsv,
  bankTransferCsv,
  cnssQuarterCsv,
  missingRib,
  payrollJournalCsv,
  quarterMonths,
} from "@/lib/payroll-export";
import { createClient } from "@/lib/supabase/client";

/** `flash` from the page shell changes every render; keep effects off it. */
function useStableFlash(flash: (message: string) => void) {
  const ref = useRef(flash);
  ref.current = flash;
  return useCallback((message: string) => ref.current(message), []);
}

type ContractForm = {
  effectiveFrom: string;
  contractType: ContractType;
  contractEnd: string;
  payBasis: PayBasis;
  baseSalary: string;
  hourlyRate: string;
  weeklyHours: string;
  cnssNumber: string;
  maritalStatus: MaritalStatus;
  headOfFamily: boolean;
  attendanceBased: boolean;
  dependentChildren: string;
  bankName: string;
  rib: string;
};

function formFromContract(contract: EmployeeContract | null, today: string): ContractForm {
  return {
    effectiveFrom: contract?.effectiveFrom ?? today,
    contractType: contract?.contractType ?? "cdi",
    contractEnd: contract?.contractEnd ?? "",
    payBasis: contract?.payBasis ?? "monthly",
    baseSalary: contract ? String(contract.baseSalary) : "",
    hourlyRate: contract?.hourlyRate == null ? "" : String(contract.hourlyRate),
    weeklyHours: String(contract?.weeklyHours ?? 48),
    cnssNumber: contract?.cnssNumber ?? "",
    maritalStatus: contract?.maritalStatus ?? "single",
    headOfFamily: contract?.headOfFamily ?? false,
    dependentChildren: String(contract?.dependentChildren ?? 0),
    bankName: contract?.bankName ?? "",
    rib: contract?.rib ?? "",
    attendanceBased: contract?.attendanceBased ?? true,
  };
}

function amount(value: string) {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) / 1000 : null;
}

/** Salary contract block of the employee panel. Admin only (RLS enforces it). */
export function ContractSection({
  employeeId,
  flash,
}: {
  employeeId: string;
  flash: (message: string) => void;
}) {
  const { t, dateLocale } = useLanguage();
  const today = isoDate(new Date());
  const [contracts, setContracts] = useState<EmployeeContract[]>([]);
  const [form, setForm] = useState<ContractForm>(() => formFromContract(null, today));
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ContractForm>(key: K, value: ContractForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data, error } = await createClient()
        .from("employee_contracts")
        .select(CONTRACT_SELECT)
        .eq("employee_id", employeeId)
        .order("effective_from", { ascending: false });
      if (cancelled) return;
      if (error) {
        setState(isMissingPayrollTable(error.message) ? "missing" : "ready");
        if (!isMissingPayrollTable(error.message)) flash(error.message);
        return;
      }
      const rows = ((data ?? []) as EmployeeContractRow[]).map(mapContract);
      setContracts(rows);
      setForm(formFromContract(currentContract(rows, today), today));
      setState("ready");
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  const save = async () => {
    if (saving) return;
    const baseSalary = amount(form.baseSalary);
    const hourlyRate = form.hourlyRate.trim() ? amount(form.hourlyRate) : null;
    const weeklyHours = amount(form.weeklyHours);
    const children = Number.parseInt(form.dependentChildren, 10);
    const rib = form.rib.replace(/\s+/g, "");

    if (!form.effectiveFrom) return flash(t("contract.errorEffective"));
    if (form.payBasis === "monthly" && !baseSalary) return flash(t("contract.errorSalary"));
    if (form.payBasis === "hourly" && !hourlyRate) return flash(t("contract.errorHourly"));
    if (!weeklyHours || weeklyHours > 60) return flash(t("contract.errorHours"));
    if (!Number.isInteger(children) || children < 0 || children > 20) {
      return flash(t("contract.errorChildren"));
    }
    if (rib && !/^\d{20}$/.test(rib)) return flash(t("contract.errorRib"));
    if (contractNeedsEnd(form.contractType) && !form.contractEnd) {
      return flash(t("contract.errorEnd"));
    }
    if (form.contractEnd && form.contractEnd < form.effectiveFrom) {
      return flash(t("contract.errorEndBefore"));
    }

    setSaving(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // Same effective date updates that version; a new date adds a version.
    const { data, error } = await supabase
      .from("employee_contracts")
      .upsert(
        {
          employee_id: employeeId,
          effective_from: form.effectiveFrom,
          contract_type: form.contractType,
          contract_end: form.contractEnd || null,
          pay_basis: form.payBasis,
          base_salary: baseSalary ?? 0,
          hourly_rate: hourlyRate,
          weekly_hours: weeklyHours,
          // SIVP is not affiliated to CNSS through this payroll.
          cnss_number: isExemptContract(form.contractType) ? null : form.cnssNumber.trim() || null,
          marital_status: form.maritalStatus,
          head_of_family: form.headOfFamily,
          dependent_children: children,
          bank_name: form.bankName.trim() || null,
          rib: rib || null,
          attendance_based: form.attendanceBased,
          created_by: user?.id ?? null,
        },
        { onConflict: "employee_id,effective_from" },
      )
      .select(CONTRACT_SELECT)
      .single();
    setSaving(false);

    if (error) {
      flash(isMissingPayrollTable(error.message) ? t("contract.missingTable") : error.message);
      return;
    }
    const saved = mapContract(data as EmployeeContractRow);
    setContracts((current) =>
      [...current.filter((item) => item.effectiveFrom !== saved.effectiveFrom), saved].sort(
        (a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom),
      ),
    );
    setForm(formFromContract(saved, today));
    flash(t("contract.saved"));
  };

  if (state === "loading") {
    return (
      <div className="detail-block" id="employee-contract">
        <p className="eyebrow">{t("contract.title")}</p>
        <span>{t("contract.loading")}</span>
      </div>
    );
  }

  if (state === "missing") {
    return (
      <div className="detail-block" id="employee-contract">
        <p className="eyebrow">{t("contract.title")}</p>
        <span>{t("contract.missingTable")}</span>
      </div>
    );
  }

  const isNewVersion = !contracts.some((item) => item.effectiveFrom === form.effectiveFrom);

  return (
    <div className="detail-block contract-block" id="employee-contract">
      <p className="eyebrow">{t("contract.title")}</p>
      <p className="page-subtitle">{t("contract.note")}</p>

      {contracts.length > 1 && (
        <div className="contract-history" aria-label={t("contract.history")}>
          {contracts.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.effectiveFrom === form.effectiveFrom ? "active" : ""}
              onClick={() => setForm(formFromContract(item, today))}
            >
              <span>{formatDisplayDate(item.effectiveFrom, dateLocale)}</span>
              <b>
                {item.payBasis === "hourly"
                  ? `${formatTnd(item.hourlyRate ?? 0, dateLocale)}/h`
                  : formatTnd(item.baseSalary, dateLocale)}
              </b>
            </button>
          ))}
        </div>
      )}

      <Field
        label={t("contract.effectiveFrom")}
        name="effective_from"
        type="date"
        value={form.effectiveFrom}
        onChange={(value) => set("effectiveFrom", value)}
      />
      {contracts.length > 0 && (
        <span className="contract-hint">
          {isNewVersion ? t("contract.newVersionHint") : t("contract.editVersionHint")}
        </span>
      )}
      <label className="form-label">
        {t("contract.type")}
        <select
          name="contract_type"
          value={form.contractType}
          onChange={(event) => set("contractType", event.target.value as ContractType)}
        >
          {CONTRACT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`contract.type.${type}`)}
            </option>
          ))}
        </select>
      </label>
      {(contractNeedsEnd(form.contractType) || form.contractEnd) && (
        <Field
          label={t("contract.end")}
          name="contract_end"
          type="date"
          value={form.contractEnd}
          min={form.effectiveFrom}
          onChange={(value) => set("contractEnd", value)}
        />
      )}
      <label className="form-label">
        {t("contract.payBasis")}
        <select
          name="pay_basis"
          value={form.payBasis}
          onChange={(event) => set("payBasis", event.target.value as PayBasis)}
        >
          <option value="monthly">{t("contract.payBasis.monthly")}</option>
          <option value="hourly">{t("contract.payBasis.hourly")}</option>
        </select>
      </label>
      {form.payBasis === "monthly" ? (
        <Field
          label={t("contract.baseSalary")}
          name="base_salary"
          type="number"
          step="0.001"
          min="0"
          value={form.baseSalary}
          onChange={(value) => set("baseSalary", value)}
        />
      ) : (
        <Field
          label={t("contract.hourlyRate")}
          name="hourly_rate"
          type="number"
          step="0.001"
          min="0"
          value={form.hourlyRate}
          onChange={(value) => set("hourlyRate", value)}
        />
      )}
      <Field
        label={t("contract.weeklyHours")}
        name="weekly_hours"
        type="number"
        step="0.5"
        min="1"
        max="60"
        value={form.weeklyHours}
        onChange={(value) => set("weeklyHours", value)}
      />
      {isExemptContract(form.contractType) ? (
        <span className="contract-hint">{t("contract.cnssNotApplicable")}</span>
      ) : (
        <Field
          label={t("contract.cnssNumber")}
          name="cnss_number"
          value={form.cnssNumber}
          onChange={(value) => set("cnssNumber", value)}
        />
      )}

      <p className="eyebrow contract-subhead">{t("contract.family")}</p>
      <label className="form-label">
        {t("contract.maritalStatus")}
        <select
          name="marital_status"
          value={form.maritalStatus}
          onChange={(event) => set("maritalStatus", event.target.value as MaritalStatus)}
        >
          {MARITAL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`contract.marital.${status}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="form-check">
        <input
          type="checkbox"
          name="head_of_family"
          checked={form.headOfFamily}
          onChange={(event) => set("headOfFamily", event.target.checked)}
        />
        {t("contract.headOfFamily")}
      </label>
      <Field
        label={t("contract.children")}
        name="dependent_children"
        type="number"
        step="1"
        min="0"
        max="20"
        value={form.dependentChildren}
        onChange={(value) => set("dependentChildren", value)}
      />

      <p className="eyebrow contract-subhead">{t("contract.timeClock")}</p>
      <label className="form-check">
        <input
          type="checkbox"
          name="attendance_based"
          checked={form.attendanceBased}
          onChange={(event) => set("attendanceBased", event.target.checked)}
        />
        {t("contract.attendanceBased")}
      </label>
      <span className="contract-hint">
        {form.attendanceBased ? t("contract.attendanceOn") : t("contract.attendanceOff")}
      </span>
      {form.contractType === "sivp" && <span className="contract-hint">{t("contract.sivpExempt")}</span>}

      <p className="eyebrow contract-subhead">{t("contract.bank")}</p>
      <Field
        label={t("contract.bankName")}
        name="bank_name"
        value={form.bankName}
        onChange={(value) => set("bankName", value)}
      />
      <Field
        label={t("contract.rib")}
        name="rib"
        value={form.rib}
        onChange={(value) => set("rib", value)}
      />

      <Button onClick={() => void save()}>
        {saving
          ? t("modal.saving")
          : contracts.length > 0 && isNewVersion
            ? t("contract.saveNewVersion")
            : t("contract.save")}
      </Button>
      {contracts.length > 0 && <FixedComponentsSection employeeId={employeeId} flash={flash} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recurring bonuses and deductions of one employee
// ---------------------------------------------------------------------------

function FixedComponentsSection({
  employeeId,
  flash: rawFlash,
}: {
  employeeId: string;
  flash: (message: string) => void;
}) {
  const flash = useStableFlash(rawFlash);
  const { t, dateLocale } = useLanguage();
  const today = isoDate(new Date());
  const [catalog, setCatalog] = useState<PayComponent[]>([]);
  const [items, setItems] = useState<EmployeePayComponent[]>([]);
  const [componentId, setComponentId] = useState("");
  const [amountValue, setAmountValue] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [components, current] = await Promise.all([
      loadComponents(),
      loadEmployeeComponents(today, "9999-12-31", employeeId),
    ]);
    setCatalog(components);
    setItems(current);
  }, [employeeId, today]);

  useEffect(() => {
    reload().catch((error: Error) => flash(error.message));
  }, [reload, flash]);

  const byId = new Map(catalog.map((component) => [component.id, component]));
  const active = catalog.filter((component) => component.active);

  const add = async () => {
    const value = amount(amountValue);
    if (!componentId || !value || busy) return flash(t("payroll.errorAmount"));
    setBusy(true);
    try {
      // Applies from the 1st of the current month.
      await addEmployeeComponent(employeeId, componentId, value, `${today.slice(0, 7)}-01`);
      setComponentId("");
      setAmountValue("");
      await reload();
    } catch (error) {
      flash((error as Error).message);
    }
    setBusy(false);
  };

  const stop = async (item: EmployeePayComponent) => {
    if (busy) return;
    setBusy(true);
    try {
      // Last month is the final one it applies to.
      const lastDay = monthRange(shiftMonth(today.slice(0, 7), -1)).to;
      await endEmployeeComponent(item, lastDay);
      await reload();
    } catch (error) {
      flash((error as Error).message);
    }
    setBusy(false);
  };

  return (
    <>
      <p className="eyebrow contract-subhead">{t("payroll.fixedTitle")}</p>
      <span className="contract-hint">{t("payroll.fixedNote")}</span>
      {items.length === 0 ? (
        <span className="contract-hint">{t("payroll.fixedEmpty")}</span>
      ) : (
        <div className="pay-item-list">
          {items.map((item) => {
            const component = byId.get(item.componentId);
            return (
              <div className="pay-item" key={item.id}>
                <div>
                  <b>{component?.name ?? "—"}</b>
                  <span>
                    {t(component?.kind === "deduction" ? "payroll.kindDeduction" : "payroll.kindEarning")}
                    {" · "}
                    {t("payroll.since", { date: formatDisplayDate(item.startsOn, dateLocale) })}
                  </span>
                </div>
                <strong>{formatTnd(item.amount, dateLocale)}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("payroll.stopItem")}
                  title={t("payroll.stopItem")}
                  onClick={() => void stop(item)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="pay-item-add">
        <select
          aria-label={t("payroll.component")}
          value={componentId}
          onChange={(event) => setComponentId(event.target.value)}
        >
          <option value="">{t("payroll.chooseComponent")}</option>
          {active.map((component) => (
            <option key={component.id} value={component.id}>
              {component.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          step="0.001"
          min="0"
          aria-label={t("payroll.amount")}
          placeholder={t("payroll.amount")}
          value={amountValue}
          onChange={(event) => setAmountValue(event.target.value)}
        />
        <button type="button" className="secondary-button" onClick={() => void add()}>
          <Plus size={14} /> {t("payroll.add")}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Admin: Payroll screen
// ---------------------------------------------------------------------------

const WARNING_KEYS: Record<PayslipWarning, MessageKey> = {
  rates_unverified: "payroll.warn.rates_unverified",
  no_cnss_number: "payroll.warn.no_cnss_number",
  no_rib: "payroll.warn.no_rib",
  hourly_no_hours: "payroll.warn.hourly_no_hours",
  negative_net: "payroll.warn.negative_net",
  contract_ends: "payroll.warn.contract_ends",
  attendance_unavailable: "payroll.warn.attendance_unavailable",
};

const STATUS_KEYS: Record<PayrollRun["status"], MessageKey> = {
  draft: "payroll.status.draft",
  validated: "payroll.status.validated",
  paid: "payroll.status.paid",
};

export function PayrollView({
  employees,
  flash: rawFlash,
  onOpenEmployee,
}: {
  employees: Employee[];
  flash: (message: string) => void;
  /** Opens the employee panel (where the contract is edited). */
  onOpenEmployee?: (employee: Employee) => void;
}) {
  const flash = useStableFlash(rawFlash);
  const { t, dateLocale } = useLanguage();
  // Early in the month, payroll is usually being prepared for the month just ended.
  const [period, setPeriod] = useState(() => {
    const today = isoDate(new Date());
    return Number(today.slice(8, 10)) <= 10 ? shiftMonth(today.slice(0, 7), -1) : today.slice(0, 7);
  });
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [contractPeriods, setContractPeriods] = useState<ContractPeriod[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "missing-table">("loading");
  const [busy, setBusy] = useState(false);
  const [openPayslip, setOpenPayslip] = useState<Payslip | null>(null);
  const [printing, setPrinting] = useState<Payslip[] | null>(null);
  const [showRates, setShowRates] = useState(false);
  const [confirm, setConfirm] = useState<"validate" | "paid" | "delete" | null>(null);
  const { year } = monthRange(period);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [nextRun, nextSettings, periods] = await Promise.all([
        loadRun(period),
        loadSettings(year),
        loadContractPeriods(),
      ]);
      setRun(nextRun);
      setSettings(nextSettings);
      setContractPeriods(periods);
      setPayslips(nextRun ? await loadPayslips(nextRun.id) : []);
      setState("ready");
    } catch (error) {
      const message = (error as Error).message;
      if (isMissingPayrollTable(message)) setState("missing-table");
      else {
        flash(message);
        setState("ready");
      }
    }
  }, [period, year, flash]);

  useEffect(() => {
    void load();
  }, [load]);

  const byEmployee = useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees],
  );
  const sorted = useMemo(
    () => [...payslips].sort((a, b) => a.inputs.employee.name.localeCompare(b.inputs.employee.name)),
    [payslips],
  );
  const totals = useMemo(
    () =>
      payslips.reduce(
        (sum, payslip) => ({
          gross: sum.gross + payslip.gross,
          net: sum.net + payslip.net,
          employerCost: sum.employerCost + payslip.employerCost,
          cnss: sum.cnss + payslip.cnssEmployee,
          tax: sum.tax + payslip.irpp + payslip.css,
          deductions: sum.deductions + payslip.otherDeductions,
        }),
        { gross: 0, net: 0, employerCost: 0, cnss: 0, tax: 0, deductions: 0 },
      ),
    [payslips],
  );
  const notIncluded = run
    ? employees.filter(
        (employee) =>
          employee.status !== "Inactive" &&
          !payslips.some((payslip) => payslip.employeeId === employee.id),
      )
    : [];
  const { from: monthFrom, to: monthTo } = monthRange(period);
  const reasonLabel = (employee: Employee) => {
    const reason = exclusionReason(contractPeriods, employee.id, monthFrom, monthTo);
    if (reason.kind === "starts_later") {
      return t("payroll.reasonStartsLater", { date: formatDisplayDate(reason.date, dateLocale) });
    }
    if (reason.kind === "ended") {
      return t("payroll.reasonEnded", { date: formatDisplayDate(reason.date, dateLocale) });
    }
    return t("payroll.reasonNoContract");
  };
  const money = (value: number) => formatTnd(round3(value), dateLocale);

  const prepare = async () => {
    if (!settings) return flash(t("payroll.noRates", { year }));
    if (busy) return;
    setBusy(true);
    try {
      const result = await prepareRun(period, employees, settings);
      setRun(result.run);
      const [nextPayslips, periods] = await Promise.all([
        loadPayslips(result.run.id),
        loadContractPeriods(),
      ]);
      setPayslips(nextPayslips);
      setContractPeriods(periods);
      flash(t("payroll.prepared"));
    } catch (error) {
      flash((error as Error).message);
    }
    setBusy(false);
  };

  const changeStatus = async (status: PayrollRun["status"]) => {
    if (!run || !settings) return;
    try {
      await setRunStatus(run, status, ratesOnly(settings));
      setConfirm(null);
      await load();
      flash(t(status === "paid" ? "payroll.markedPaid" : "payroll.validatedToast"));
    } catch (error) {
      flash((error as Error).message);
    }
  };

  if (state === "missing-table") {
    return (
      <>
        <Header eyebrow={t("payroll.eyebrow")} title={t("nav.payroll")} action={null} />
        <div className="card payroll-empty">
          <AlertTriangle size={20} />
          <p>{t("contract.missingTable")}</p>
        </div>
      </>
    );
  }

  const isDraft = run?.status === "draft";
  const inProgress = isMonthInProgress(period);
  const blockingRates = !settings?.verified;

  return (
    <div className="payroll-page">
      <Header
        eyebrow={t("payroll.eyebrow")}
        title={t("nav.payroll")}
        action={
          <div className="payroll-header-actions">
            <div className="month-switcher" role="group" aria-label={t("payroll.month")}>
              <button
                type="button"
                className="icon-button"
                aria-label={t("common.previous")}
                onClick={() => setPeriod((current) => shiftMonth(current, -1))}
              >
                <ChevronLeft size={16} />
              </button>
              <span>{monthLabel(period, dateLocale)}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={t("common.next")}
                onClick={() => setPeriod((current) => shiftMonth(current, 1))}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <Button secondary onClick={() => setShowRates(true)}>
              <Settings2 size={15} /> {t("payroll.ratesButton")}
            </Button>
          </div>
        }
      />

      {state === "ready" && inProgress && (
        <div className="payroll-banner is-info">
          <AlertTriangle size={17} />
          <p>
            {t("payroll.inProgress", {
              month: monthLabel(period, dateLocale),
              date: formatDisplayDate(monthRange(shiftMonth(period, 1)).from, dateLocale),
            })}
          </p>
        </div>
      )}

      {state === "ready" && blockingRates && (
        <div className="payroll-banner">
          <AlertTriangle size={17} />
          <p>
            {settings
              ? t("payroll.ratesUnverified", { year })
              : t("payroll.noRates", { year })}
          </p>
          <button type="button" className="secondary-button" onClick={() => setShowRates(true)}>
            {t("payroll.reviewRates")}
          </button>
        </div>
      )}

      {state === "loading" ? (
        <div className="workspace-loading" role="status">
          <span>{t("chrome.loading")}</span>
        </div>
      ) : !run ? (
        <div className="card payroll-empty">
          <Wallet size={22} />
          <h2>{t("payroll.emptyTitle", { month: monthLabel(period, dateLocale) })}</h2>
          <p>{t("payroll.emptyCopy")}</p>
          <Button onClick={() => void prepare()}>
            {busy ? t("panel.pleaseWait") : t("payroll.prepare")}
          </Button>
        </div>
      ) : (
        <>
          <div className="metric-grid">
            <Metric
              label={t("payroll.totalGross")}
              value={money(totals.gross)}
              note={t("payroll.employeesCount", { count: payslips.length })}
              tone="indigo"
              icon={<Banknote size={17} />}
            />
            <Metric
              label={t("payroll.totalNet")}
              value={money(totals.net)}
              note={t("payroll.toTransfer")}
              tone="teal"
              icon={<Wallet size={17} />}
            />
            <Metric
              label={t("payroll.totalCharges")}
              value={money(totals.cnss + totals.tax)}
              note={t("payroll.chargesNote")}
              tone="amber"
              icon={<FileText size={17} />}
            />
            <Metric
              label={t("payroll.employerCost")}
              value={money(totals.employerCost)}
              note={t("payroll.employerCostNote")}
              tone="rose"
              icon={<Users size={17} />}
            />
          </div>

          <div className="card table-card payroll-table">
            <div className="payroll-table-top">
              <span className={`payroll-status is-${run.status}`}>{t(STATUS_KEYS[run.status])}</span>
              <span className="payroll-status-note">
                {run.status === "draft"
                  ? t("payroll.draftNote")
                  : run.status === "validated"
                    ? t("payroll.validatedNote", {
                        date: formatDisplayDate(run.validatedAt?.slice(0, 10), dateLocale),
                      })
                    : t("payroll.paidNote", {
                        date: formatDisplayDate(run.paidAt?.slice(0, 10), dateLocale),
                      })}
              </span>
              <div className="payroll-table-actions">
                {isDraft && (
                  <>
                    <button type="button" className="secondary-button" onClick={() => setConfirm("delete")}>
                      <Trash2 size={14} /> {t("payroll.deleteDraft")}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => void prepare()}>
                      <RefreshCw size={14} /> {busy ? t("panel.pleaseWait") : t("payroll.recalculate")}
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => setConfirm("validate")}
                      disabled={inProgress}
                      title={inProgress ? t("payroll.validateAfterMonth") : undefined}
                    >
                      {t("payroll.validate")}
                    </button>
                  </>
                )}
                {run.status === "validated" && (
                  <Button onClick={() => setConfirm("paid")}>{t("payroll.markPaid")}</Button>
                )}
              </div>
            </div>

            {notIncluded.length > 0 && (
              <div className="payroll-missing">
                <AlertTriangle size={14} />
                <div>
                  <p>{t("payroll.notIncludedTitle")}</p>
                  <div className="payroll-missing-names">
                    {notIncluded.map((employee) =>
                      onOpenEmployee ? (
                        <button
                          type="button"
                          key={employee.id}
                          onClick={() => {
                            onOpenEmployee(employee);
                            // The contract block sits at the bottom of the panel.
                            window.setTimeout(() => {
                              document
                                .getElementById("employee-contract")
                                ?.scrollIntoView({ behavior: "smooth", block: "start" });
                            }, 400);
                          }}
                        >
                          <Plus size={12} /> {employee.name}
                          <small>· {reasonLabel(employee)}</small>
                        </button>
                      ) : (
                        <span key={employee.id}>
                          {employee.name} <small>· {reasonLabel(employee)}</small>
                        </span>
                      ),
                    )}
                  </div>
                  <p className="payroll-missing-hint">{t("payroll.notIncludedHint")}</p>
                </div>
              </div>
            )}

            {sorted.length === 0 ? (
              <p className="table-empty">{t("payroll.noPayslips")}</p>
            ) : (
              <>
                <div className="payroll-row payroll-head">
                  <span>{t("admin.colEmployee")}</span>
                  <span>{t("payroll.gross")}</span>
                  <span>{t("payroll.cnss")}</span>
                  <span>{t("payroll.tax")}</span>
                  <span>{t("payroll.deductions")}</span>
                  <span>{t("payroll.net")}</span>
                  <span />
                </div>
                {sorted.map((payslip) => {
                  const employee = byEmployee.get(payslip.employeeId);
                  return (
                    <div className="payroll-row is-clickable" key={payslip.id}>
                      <button
                        type="button"
                        className="table-member payroll-open"
                        onClick={() => setOpenPayslip(payslip)}
                      >
                        {employee && <Avatar e={employee} />}
                        <span>
                          <b>{payslip.inputs.employee.name}</b>
                          <span>
                            {payslip.warnings.filter((warning) => warning !== "rates_unverified").length > 0 ? (
                              <span className="payroll-warn-count">
                                <AlertTriangle size={12} />
                                {payslip.warnings
                                  .filter((warning) => warning !== "rates_unverified")
                                  .map((warning) => t(WARNING_KEYS[warning]))
                                  .join(" · ")}
                              </span>
                            ) : (
                              payslip.inputs.employee.jobTitle ?? payslip.inputs.employee.department
                            )}
                          </span>
                        </span>
                      </button>
                      <span>{money(payslip.gross)}</span>
                      <span>{money(payslip.cnssEmployee)}</span>
                      <span>{money(payslip.irpp + payslip.css)}</span>
                      <span>{money(payslip.otherDeductions)}</span>
                      <b>{money(payslip.net)}</b>
                      <button
                        type="button"
                        className="icon-button payroll-row-print"
                        aria-label={t("payslip.exportOne", { name: payslip.inputs.employee.name })}
                        title={t("payslip.exportOne", { name: payslip.inputs.employee.name })}
                        onClick={() => setPrinting([payslip])}
                        disabled={inProgress}
                      >
                        <Download size={15} />
                      </button>
                    </div>
                  );
                })}
                <div className="payroll-row payroll-total">
                  <span>{t("payroll.total")}</span>
                  <span>{money(totals.gross)}</span>
                  <span>{money(totals.cnss)}</span>
                  <span>{money(totals.tax)}</span>
                  <span>{money(totals.deductions)}</span>
                  <b>{money(totals.net)}</b>
                  <span />
                </div>
              </>
            )}
          </div>
        </>
      )}

      {run && state === "ready" && (
        <PayrollExports
          period={period}
          run={run}
          payslips={payslips}
          flash={flash}
          onPrintAll={() => setPrinting(sorted)}
          inProgress={inProgress}
        />
      )}

      {printing && <PayslipDocument payslips={printing} onClose={() => setPrinting(null)} />}

      {openPayslip && (
        <PayslipPanel
          key={openPayslip.id}
          payslip={openPayslip}
          editable={isDraft}
          inProgress={inProgress}
          verified={Boolean(settings?.verified)}
          close={() => setOpenPayslip(null)}
          flash={flash}
          onSaved={async () => {
            if (!run) return;
            const next = await loadPayslips(run.id);
            setPayslips(next);
            setOpenPayslip(next.find((item) => item.id === openPayslip.id) ?? null);
          }}
        />
      )}

      {showRates && (
        <RatesPanel
          year={year}
          initial={settings}
          close={() => setShowRates(false)}
          flash={flash}
          onSaved={async () => {
            setSettings(await loadSettings(year));
          }}
        />
      )}

      {confirm === "validate" && (
        <ConfirmModal
          danger={false}
          title={t("payroll.validateTitle", { month: monthLabel(period, dateLocale) })}
          message={
            blockingRates
              ? t("payroll.validateBlocked", { year })
              : t("payroll.validateMessage", { count: payslips.length, net: money(totals.net) })
          }
          confirmLabel={blockingRates ? t("payroll.reviewRates") : t("payroll.validate")}
          close={() => setConfirm(null)}
          confirm={async () => {
            if (blockingRates) {
              setConfirm(null);
              setShowRates(true);
              return;
            }
            await changeStatus("validated");
          }}
        />
      )}
      {confirm === "paid" && (
        <ConfirmModal
          danger={false}
          title={t("payroll.markPaid")}
          message={t("payroll.paidMessage", { net: money(totals.net) })}
          confirmLabel={t("payroll.markPaid")}
          close={() => setConfirm(null)}
          confirm={() => changeStatus("paid")}
        />
      )}
      {confirm === "delete" && run && (
        <ConfirmModal
          title={t("payroll.deleteDraft")}
          message={t("payroll.deleteMessage", { month: monthLabel(period, dateLocale) })}
          confirmLabel={t("common.delete")}
          close={() => setConfirm(null)}
          confirm={async () => {
            try {
              await deleteDraftRun(run);
              setConfirm(null);
              await load();
            } catch (error) {
              flash((error as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One payslip: lines, variables and one-off items
// ---------------------------------------------------------------------------

const VARIABLE_FIELDS: {
  key: keyof PayVariables;
  label: MessageKey;
  hourlyOnly?: boolean;
  monthlyOnly?: boolean;
  /** "only": time-clock (per hour) pay; "never": day-based pay. */
  clock?: "only" | "never";
}[] = [
  { key: "workedHours", label: "payroll.var.workedHours", hourlyOnly: true },
  { key: "unpaidDays", label: "payroll.var.unpaidDays", monthlyOnly: true, clock: "never" },
  { key: "outsideContractDays", label: "payroll.var.outsideContractDays", monthlyOnly: true, clock: "never" },
  { key: "absentDays", label: "payroll.var.absentDays", monthlyOnly: true, clock: "never" },
  { key: "earnedHours", label: "payroll.var.earnedHours", monthlyOnly: true, clock: "never" },
  { key: "absenceHours", label: "payroll.var.absenceHours", monthlyOnly: true },
  { key: "unpaidHours", label: "payroll.var.unpaidHours", monthlyOnly: true, clock: "only" },
  { key: "outsideHours", label: "payroll.var.outsideHours", monthlyOnly: true, clock: "only" },
  { key: "notYetHours", label: "payroll.var.notYetHours", monthlyOnly: true, clock: "only" },
  { key: "overtimeHours", label: "payroll.var.overtimeHours" },
];

export function PayslipLines({ payslip }: { payslip: Payslip }) {
  const { t, dateLocale } = useLanguage();
  const money = (value: number) => formatTnd(value, dateLocale);
  const groups: { kind: Payslip["lines"][number]["kind"]; title: MessageKey }[] = [
    { kind: "earning", title: "payroll.linesEarnings" },
    { kind: "contribution", title: "payroll.linesContributions" },
    { kind: "deduction", title: "payroll.linesDeductions" },
  ];
  return (
    <div className="payslip-lines">
      {groups.map(({ kind, title }) => {
        const lines = payslip.lines.filter((line) => line.kind === kind);
        if (!lines.length) return null;
        return (
          <div key={kind} className="payslip-group">
            <p className="eyebrow">{t(title)}</p>
            {lines.map((line, index) => (
              <div className="payslip-line" key={`${line.code}-${index}`}>
                <span>
                  {line.label}
                  {line.rate != null && line.kind === "contribution" && (
                    <small> · {(line.rate * 100).toLocaleString(dateLocale, { maximumFractionDigits: 3 })} %</small>
                  )}
                  {line.base != null && line.kind === "earning" && (
                    <small> · {line.base.toLocaleString(dateLocale)}</small>
                  )}
                </span>
                <b className={line.amount < 0 ? "is-negative" : undefined}>{money(line.amount)}</b>
              </div>
            ))}
          </div>
        );
      })}
      <div className="payslip-net">
        <span>{t("payroll.net")}</span>
        <b>{money(payslip.net)}</b>
      </div>
    </div>
  );
}

function PayslipPanel({
  payslip,
  editable,
  inProgress,
  verified,
  close,
  flash: rawFlash,
  onSaved,
}: {
  payslip: Payslip;
  editable: boolean;
  inProgress: boolean;
  verified: boolean;
  close: () => void;
  flash: (message: string) => void;
  onSaved: () => Promise<void>;
}) {
  const flash = useStableFlash(rawFlash);
  const { t, dateLocale } = useLanguage();
  const { inputs } = payslip;
  const [values, setValues] = useState<Record<keyof PayVariables, string>>(() => {
    const current = effectiveVariables(inputs);
    return {
      workedHours: String(current.workedHours),
      unpaidDays: String(current.unpaidDays),
      outsideContractDays: String(current.outsideContractDays ?? 0),
      absentDays: String(current.absentDays ?? 0),
      earnedHours: current.earnedHours == null ? "" : String(current.earnedHours),
      absenceHours: String(current.absenceHours),
      overtimeHours: String(current.overtimeHours),
      scheduledHours: String(current.scheduledHours ?? 0),
      outsideHours: String(current.outsideHours ?? 0),
      unpaidHours: String(current.unpaidHours ?? 0),
      notYetHours: String(current.notYetHours ?? 0),
    };
  });
  const [oneOff, setOneOff] = useState<PayItem[]>(inputs.oneOff);
  const [catalog, setCatalog] = useState<PayComponent[]>([]);
  const [componentId, setComponentId] = useState("");
  const [amountValue, setAmountValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [showDocument, setShowDocument] = useState(false);

  useEffect(() => {
    if (!editable) return;
    loadComponents()
      .then((components) => setCatalog(components.filter((component) => component.active)))
      .catch((error: Error) => flash(error.message));
  }, [editable, flash]);

  const clockPay = (inputs.auto.scheduledHours ?? 0) > 0;
  const fields = VARIABLE_FIELDS.filter(
    (field) =>
      (inputs.contract.payBasis === "hourly" ? !field.monthlyOnly : !field.hourlyOnly) &&
      (field.clock === undefined || (field.clock === "only") === clockPay) &&
      (field.key !== "notYetHours" || (inputs.auto.notYetHours ?? 0) > 0) &&
      // Hours earned so far only apply while the month is in progress.
      (field.key !== "earnedHours" || inputs.auto.earnedHours != null),
  );

  const addOneOff = () => {
    const component = catalog.find((item) => item.id === componentId);
    const value = amount(amountValue);
    if (!component || !value) return flash(t("payroll.errorAmount"));
    setOneOff((current) => [...current, toPayItem(component, value)]);
    setComponentId("");
    setAmountValue("");
  };

  const save = async () => {
    if (saving) return;
    const manual: Partial<PayVariables> = {};
    for (const field of fields) {
      const value = amount(values[field.key]);
      if (value == null) return flash(t("payroll.errorNumber"));
      if (value !== (inputs.auto[field.key] ?? 0)) manual[field.key] = value;
    }
    setSaving(true);
    try {
      await updatePayslip(payslip, manual, oneOff, verified);
      await onSaved();
      flash(t("payroll.payslipSaved"));
    } catch (error) {
      flash((error as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="side-panel payslip-panel">
      <button type="button" className="panel-close" onClick={close} aria-label={t("chrome.closeMenu")}>
        <X size={18} />
      </button>
      <p className="eyebrow">{monthLabel(payslip.period, dateLocale)}</p>
      <h2>{inputs.employee.name}</h2>
      <p>
        {t(`contract.type.${inputs.contract.contractType}`)} ·{" "}
        {inputs.contract.payBasis === "hourly"
          ? `${formatTnd(inputs.contract.hourlyRate ?? 0, dateLocale)}/h`
          : formatTnd(inputs.contract.baseSalary, dateLocale)}
      </p>

      {payslip.warnings.length > 0 && (
        <ul className="payslip-warnings">
          {payslip.warnings.map((warning) => (
            <li key={warning}>
              <AlertTriangle size={13} /> {t(WARNING_KEYS[warning])}
            </li>
          ))}
        </ul>
      )}

      {inputs.attendance && (
        <div className="payslip-attendance">
          <p className="eyebrow">{t("payroll.attTitle")}</p>
          <span className="contract-hint">
            {t("payroll.attUntil", { date: formatDisplayDate(inputs.attendance.countedUntil, dateLocale) })}
          </span>
          {inputs.attendance.clock && (
            <dl className="payslip-clock">
              <div><dt>{t("payroll.clockScheduled")}</dt><dd>{inputs.attendance.clock.scheduledHours.toLocaleString(dateLocale)} h</dd></div>
              <div><dt>{t("payroll.clockCredited")}</dt><dd>{inputs.attendance.clock.creditedHours.toLocaleString(dateLocale)} h</dd></div>
              <div><dt>{t("payroll.clockAbsence")}</dt><dd className={inputs.attendance.clock.absenceHours ? "is-negative" : undefined}>{inputs.attendance.clock.absenceHours.toLocaleString(dateLocale)} h</dd></div>
              {inputs.attendance.clock.notYetHours > 0 && (
                <div><dt>{t("payroll.clockNotYet")}</dt><dd>{inputs.attendance.clock.notYetHours.toLocaleString(dateLocale)} h</dd></div>
              )}
              <div><dt>{t("payroll.clockOvertime")}</dt><dd>{inputs.attendance.clock.overtimeHours.toLocaleString(dateLocale)} h</dd></div>
              <div><dt>{t("payroll.clockLate")}</dt><dd className={inputs.attendance.clock.lateCount ? "is-negative" : undefined}>{inputs.attendance.clock.lateCount}</dd></div>
              <div><dt>{t("payroll.clockEarly")}</dt><dd className={inputs.attendance.clock.earlyLeaveCount ? "is-negative" : undefined}>{inputs.attendance.clock.earlyLeaveCount}</dd></div>
              <div><dt>{t("payroll.attAbsent")}</dt><dd className={inputs.attendance.clock.absentDays ? "is-negative" : undefined}>{inputs.attendance.clock.absentDays}</dd></div>
            </dl>
          )}
          {inputs.attendance.clock && <span className="contract-hint">{t("payroll.clockRule")}</span>}
          <dl hidden={Boolean(inputs.attendance.clock)}>
            <div><dt>{t("payroll.attScheduled")}</dt><dd>{inputs.attendance.scheduledDays}</dd></div>
            <div><dt>{t("payroll.attWorked")}</dt><dd>{inputs.attendance.workedDays}</dd></div>
            <div><dt>{t("payroll.attAbsent")}</dt><dd className={inputs.attendance.absentDays ? "is-negative" : undefined}>{inputs.attendance.absentDays}</dd></div>
            <div><dt>{t("payroll.attMissing")}</dt><dd>{inputs.attendance.missingHours.toLocaleString(dateLocale)} h</dd></div>
            <div><dt>{t("payroll.attLeave")}</dt><dd>{inputs.attendance.paidLeaveDays} / {inputs.attendance.unpaidDays}</dd></div>
            <div><dt>{t("payroll.attHolidays")}</dt><dd>{inputs.attendance.holidayDays}</dd></div>
            <div><dt>{t("payroll.attOutside")}</dt><dd>{inputs.attendance.outsideContractDays}</dd></div>
            <div><dt>{t("payroll.attHours")}</dt><dd>{inputs.attendance.workedHours.toLocaleString(dateLocale)} h</dd></div>
            {inputs.auto.earnedHours != null && (
              <div>
                <dt>{t("payroll.attEarned")}</dt>
                <dd>{(inputs.attendance.earnedHours ?? 0).toLocaleString(dateLocale)} h</dd>
              </div>
            )}
          </dl>
        </div>
      )}
      {isExemptContract(inputs.contract.contractType) && (
        <p className="contract-hint payslip-exempt">{t("contract.sivpExempt")}</p>
      )}

      <PayslipLines payslip={payslip} />
      <PaySimulator payslip={payslip} />
      <button
        type="button"
        className="secondary-button payslip-view-button"
        onClick={() => setShowDocument(true)}
        disabled={inProgress}
        title={inProgress ? t("payroll.validateAfterMonth") : undefined}
      >
        <Printer size={15} /> {t("payslip.view")}
      </button>
      {showDocument && <PayslipDocument payslips={[payslip]} onClose={() => setShowDocument(false)} />}

      {editable && (
        <div className="detail-block">
          <p className="eyebrow">{t("payroll.adjustTitle")}</p>
          <span className="contract-hint">{t("payroll.adjustNote")}</span>
          {fields.map((field) => (
            <label className="form-label" key={field.key}>
              {t(field.label)}
              <input
                type="number"
                step="0.5"
                min="0"
                value={values[field.key]}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
              <small className="contract-hint">
                {t("payroll.autoValue", { value: String(inputs.auto[field.key] ?? 0) })}
              </small>
            </label>
          ))}

          <p className="eyebrow contract-subhead">{t("payroll.oneOffTitle")}</p>
          {oneOff.length === 0 ? (
            <span className="contract-hint">{t("payroll.oneOffEmpty")}</span>
          ) : (
            <div className="pay-item-list">
              {oneOff.map((item, index) => (
                <div className="pay-item" key={`${item.code}-${index}`}>
                  <div>
                    <b>{item.label}</b>
                    <span>{t(item.kind === "deduction" ? "payroll.kindDeduction" : "payroll.kindEarning")}</span>
                  </div>
                  <strong>{formatTnd(item.amount, dateLocale)}</strong>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("common.delete")}
                    onClick={() => setOneOff((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="pay-item-add">
            <select
              aria-label={t("payroll.component")}
              value={componentId}
              onChange={(event) => setComponentId(event.target.value)}
            >
              <option value="">{t("payroll.chooseComponent")}</option>
              {catalog.map((component) => (
                <option key={component.id} value={component.id}>
                  {component.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              step="0.001"
              min="0"
              aria-label={t("payroll.amount")}
              placeholder={t("payroll.amount")}
              value={amountValue}
              onChange={(event) => setAmountValue(event.target.value)}
            />
            <button type="button" className="secondary-button" onClick={addOneOff}>
              <Plus size={14} /> {t("payroll.add")}
            </button>
          </div>

          <Button onClick={() => void save()}>
            {saving ? t("modal.saving") : t("payroll.saveAndRecalculate")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Yearly rates and the bonus catalogue
// ---------------------------------------------------------------------------

type RateKey =
  | "cnssEmployeeRate"
  | "cnssEmployerRate"
  | "workAccidentRate"
  | "cssRate"
  | "professionalExpensesRate"
  | "overtimeRate";
type AmountKey = "professionalExpensesCap" | "headOfFamilyDeduction" | "childDeduction" | "maxChildren";

const PERCENT_FIELDS: { key: RateKey; label: MessageKey }[] = [
  { key: "cnssEmployeeRate", label: "payroll.rate.cnssEmployee" },
  { key: "cnssEmployerRate", label: "payroll.rate.cnssEmployer" },
  { key: "workAccidentRate", label: "payroll.rate.workAccident" },
  { key: "cssRate", label: "payroll.rate.css" },
  { key: "professionalExpensesRate", label: "payroll.rate.professionalExpenses" },
];

const AMOUNT_FIELDS: { key: AmountKey; label: MessageKey }[] = [
  { key: "professionalExpensesCap", label: "payroll.rate.professionalExpensesCap" },
  { key: "headOfFamilyDeduction", label: "payroll.rate.headOfFamily" },
  { key: "childDeduction", label: "payroll.rate.child" },
  { key: "maxChildren", label: "payroll.rate.maxChildren" },
];

const percent = (rate: number) => String(round3(rate * 100));

function RatesPanel({
  year,
  initial,
  close,
  flash: rawFlash,
  onSaved,
}: {
  year: number;
  initial: PayrollSettings | null;
  close: () => void;
  flash: (message: string) => void;
  onSaved: () => Promise<void>;
}) {
  const flash = useStableFlash(rawFlash);
  const { t } = useLanguage();
  const [rates, setRates] = useState<Record<RateKey | AmountKey, string>>(() => ({
    cnssEmployeeRate: percent(initial?.cnssEmployeeRate ?? 0),
    cnssEmployerRate: percent(initial?.cnssEmployerRate ?? 0),
    workAccidentRate: percent(initial?.workAccidentRate ?? 0),
    cssRate: percent(initial?.cssRate ?? 0),
    professionalExpensesRate: percent(initial?.professionalExpensesRate ?? 0.1),
    overtimeRate: percent(initial?.overtimeRate ?? 1.25),
    professionalExpensesCap: String(initial?.professionalExpensesCap ?? 2000),
    headOfFamilyDeduction: String(initial?.headOfFamilyDeduction ?? 0),
    childDeduction: String(initial?.childDeduction ?? 0),
    maxChildren: String(initial?.maxChildren ?? 4),
  }));
  const [brackets, setBrackets] = useState<{ upTo: string; rate: string }[]>(() =>
    (initial?.irppBrackets ?? [{ upTo: null, rate: 0 }]).map((bracket) => ({
      upTo: bracket.upTo == null ? "" : String(bracket.upTo),
      rate: percent(bracket.rate),
    })),
  );
  const [verified, setVerified] = useState(initial?.verified ?? false);
  const [saving, setSaving] = useState(false);
  const [components, setComponents] = useState<PayComponent[]>([]);
  const [company, setCompany] = useState<PayrollCompany | null>(null);
  const [draft, setDraft] = useState({ name: "", kind: "earning" as PayComponent["kind"], subjectToCnss: true, taxable: true });

  const reloadComponents = useCallback(async () => {
    setComponents(await loadComponents());
  }, []);

  useEffect(() => {
    reloadComponents().catch((error: Error) => flash(error.message));
    loadCompany()
      .then(setCompany)
      .catch((error: Error) => flash(error.message));
  }, [reloadComponents, flash]);

  const saveCompanyDetails = async () => {
    if (!company) return;
    try {
      await saveCompany(company);
      flash(t("payslip.companySaved"));
    } catch (error) {
      flash((error as Error).message);
    }
  };

  const save = async () => {
    if (saving) return;
    const parsed: Partial<Record<RateKey | AmountKey, number>> = {};
    for (const key of Object.keys(rates) as (RateKey | AmountKey)[]) {
      const value = amount(rates[key]);
      if (value == null) return flash(t("payroll.errorNumber"));
      parsed[key] = value;
    }
    const nextBrackets: IrppBracket[] = [];
    for (const [index, bracket] of brackets.entries()) {
      const rate = amount(bracket.rate);
      const last = index === brackets.length - 1;
      const upTo = last ? null : amount(bracket.upTo);
      if (rate == null || (!last && !upTo)) return flash(t("payroll.errorBrackets"));
      if (upTo != null && nextBrackets.length && upTo <= (nextBrackets[nextBrackets.length - 1].upTo ?? 0)) {
        return flash(t("payroll.errorBrackets"));
      }
      nextBrackets.push({ upTo, rate: rate / 100 });
    }
    setSaving(true);
    try {
      await saveSettings({
        year,
        cnssEmployeeRate: parsed.cnssEmployeeRate! / 100,
        cnssEmployerRate: parsed.cnssEmployerRate! / 100,
        workAccidentRate: parsed.workAccidentRate! / 100,
        cssRate: parsed.cssRate! / 100,
        professionalExpensesRate: parsed.professionalExpensesRate! / 100,
        overtimeRate: parsed.overtimeRate! / 100,
        professionalExpensesCap: parsed.professionalExpensesCap!,
        headOfFamilyDeduction: parsed.headOfFamilyDeduction!,
        childDeduction: parsed.childDeduction!,
        maxChildren: Math.round(parsed.maxChildren!),
        irppBrackets: nextBrackets,
        verified,
      });
      await onSaved();
      flash(t("payroll.ratesSaved"));
    } catch (error) {
      flash((error as Error).message);
    }
    setSaving(false);
  };

  const addComponent = async () => {
    const name = draft.name.trim();
    if (!name) return;
    const code =
      name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "") || `item_${Date.now()}`;
    try {
      const deduction = draft.kind === "deduction";
      await saveComponent({
        ...draft,
        subjectToCnss: !deduction && draft.subjectToCnss,
        taxable: !deduction && draft.taxable,
        name,
        code,
        active: true,
      });
      setDraft({ name: "", kind: "earning", subjectToCnss: true, taxable: true });
      await reloadComponents();
    } catch (error) {
      flash((error as Error).message);
    }
  };

  const toggleComponent = async (component: PayComponent) => {
    try {
      await saveComponent({ ...component, active: !component.active });
      await reloadComponents();
    } catch (error) {
      flash((error as Error).message);
    }
  };

  const setRate = (key: RateKey | AmountKey, value: string) =>
    setRates((current) => ({ ...current, [key]: value }));

  return (
    <div className="side-panel rates-panel">
      <button type="button" className="panel-close" onClick={close} aria-label={t("chrome.closeMenu")}>
        <X size={18} />
      </button>
      <p className="eyebrow">{t("payroll.ratesEyebrow")}</p>
      <h2>{t("payroll.ratesTitle", { year })}</h2>
      <p>{t("payroll.ratesNote")}</p>

      <div className="detail-block">
        <p className="eyebrow">{t("payroll.ratesContributions")}</p>
        {PERCENT_FIELDS.map((field) => (
          <Field
            key={field.key}
            label={`${t(field.label)} (%)`}
            type="number"
            step="0.001"
            min="0"
            value={rates[field.key]}
            onChange={(value) => setRate(field.key, value)}
          />
        ))}
        <Field
          label={`${t("payroll.rate.overtime")} (%)`}
          type="number"
          step="1"
          min="100"
          value={rates.overtimeRate}
          onChange={(value) => setRate("overtimeRate", value)}
        />
        {AMOUNT_FIELDS.map((field) => (
          <Field
            key={field.key}
            label={t(field.label)}
            type="number"
            step={field.key === "maxChildren" ? "1" : "0.001"}
            min="0"
            value={rates[field.key]}
            onChange={(value) => setRate(field.key, value)}
          />
        ))}
      </div>

      <div className="detail-block">
        <p className="eyebrow">{t("payroll.ratesBrackets")}</p>
        <span className="contract-hint">{t("payroll.ratesBracketsNote")}</span>
        {brackets.map((bracket, index) => {
          const last = index === brackets.length - 1;
          return (
            <div className="bracket-row" key={index}>
              <label>
                <span>{t("payroll.upTo")}</span>
                {last ? (
                  <input value="∞" readOnly aria-label={t("payroll.upTo")} />
                ) : (
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={bracket.upTo}
                    onChange={(event) =>
                      setBrackets((current) =>
                        current.map((item, i) => (i === index ? { ...item, upTo: event.target.value } : item)),
                      )
                    }
                  />
                )}
              </label>
              <label>
                <span>%</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  max="100"
                  value={bracket.rate}
                  onChange={(event) =>
                    setBrackets((current) =>
                      current.map((item, i) => (i === index ? { ...item, rate: event.target.value } : item)),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={t("common.delete")}
                disabled={brackets.length === 1}
                onClick={() => setBrackets((current) => current.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            setBrackets((current) => [...current.slice(0, -1), { upTo: "", rate: "" }, ...current.slice(-1)])
          }
        >
          <Plus size={14} /> {t("payroll.addBracket")}
        </button>
      </div>

      <div className="detail-block">
        <label className="form-check rates-verified">
          <input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} />
          {t("payroll.ratesVerified")}
        </label>
        <span className="contract-hint">{t("payroll.ratesVerifiedNote")}</span>
        <Button onClick={() => void save()}>{saving ? t("modal.saving") : t("payroll.saveRates")}</Button>
      </div>

      {company && (
        <div className="detail-block">
          <p className="eyebrow">{t("payslip.companyTitle")}</p>
          <span className="contract-hint">{t("payslip.companyNote")}</span>
          <Field
            label={t("payslip.companyName")}
            value={company.name}
            onChange={(value) => setCompany({ ...company, name: value })}
          />
          <Field
            label={t("payslip.companyAddress")}
            value={company.address ?? ""}
            onChange={(value) => setCompany({ ...company, address: value })}
          />
          <Field
            label={t("payslip.taxId")}
            value={company.taxId ?? ""}
            onChange={(value) => setCompany({ ...company, taxId: value })}
          />
          <Field
            label={t("payslip.cnssEmployer")}
            value={company.cnssEmployerNumber ?? ""}
            onChange={(value) => setCompany({ ...company, cnssEmployerNumber: value })}
          />
          <button type="button" className="secondary-button" onClick={() => void saveCompanyDetails()}>
            {t("payslip.saveCompany")}
          </button>
        </div>
      )}

      <div className="detail-block">
        <p className="eyebrow">{t("payroll.catalogTitle")}</p>
        <div className="pay-item-list">
          {components.map((component) => (
            <div className={`pay-item ${component.active ? "" : "is-inactive"}`} key={component.id}>
              <div>
                <b>{component.name}</b>
                <span>
                  {t(component.kind === "deduction" ? "payroll.kindDeduction" : "payroll.kindEarning")}
                  {component.kind === "earning" &&
                    ` · ${component.subjectToCnss ? t("payroll.cnssYes") : t("payroll.cnssNo")} · ${
                      component.taxable ? t("payroll.taxYes") : t("payroll.taxNo")
                    }`}
                </span>
              </div>
              <button type="button" className="secondary-button" onClick={() => void toggleComponent(component)}>
                {component.active ? t("payroll.disable") : t("payroll.enable")}
              </button>
            </div>
          ))}
        </div>
        <Field
          label={t("payroll.newComponent")}
          value={draft.name}
          onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
        />
        <label className="form-label">
          {t("payroll.componentKind")}
          <select
            value={draft.kind}
            onChange={(event) =>
              setDraft((current) => ({ ...current, kind: event.target.value as PayComponent["kind"] }))
            }
          >
            <option value="earning">{t("payroll.kindEarning")}</option>
            <option value="deduction">{t("payroll.kindDeduction")}</option>
          </select>
        </label>
        {draft.kind === "earning" && (
          <>
            <label className="form-check">
              <input
                type="checkbox"
                checked={draft.subjectToCnss}
                onChange={(event) => setDraft((current) => ({ ...current, subjectToCnss: event.target.checked }))}
              />
              {t("payroll.cnssYes")}
            </label>
            <label className="form-check">
              <input
                type="checkbox"
                checked={draft.taxable}
                onChange={(event) => setDraft((current) => ({ ...current, taxable: event.target.checked }))}
              />
              {t("payroll.taxYes")}
            </label>
          </>
        )}
        <button type="button" className="secondary-button" onClick={() => void addComponent()}>
          <Plus size={14} /> {t("payroll.addComponent")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Printable payslip (always in French: it is an official document)
// ---------------------------------------------------------------------------

const FR_CONTRACT: Record<string, string> = {
  cdi: "CDI",
  cdd: "CDD",
  sivp: "SIVP",
  karama: "Karama",
  internship: "Stage",
  other: "Autre",
};
const FR_MARITAL: Record<string, string> = {
  single: "Célibataire",
  married: "Marié(e)",
  divorced: "Divorcé(e)",
  widowed: "Veuf / veuve",
};

function frAmount(value: number) {
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })
    .format(value)
    .replace(/\u202f/g, "\u00a0");
}

function frDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const [year, month, day] = iso.slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
}

/** Full-screen payslip viewer; several payslips print one per A4 page. */
export function PayslipDocument({ payslips, onClose }: { payslips: Payslip[]; onClose: () => void }) {
  const { t } = useLanguage();
  const [company, setCompany] = useState<PayrollCompany | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    loadCompany()
      .then(setCompany)
      .catch(() => setCompany({ name: "Kachabiti", address: null, taxId: null, cnssEmployerNumber: null }));
    document.body.classList.add("has-payslip-doc");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("has-payslip-doc");
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Rendered on <body> so printing can hide the rest of the app entirely.
  return createPortal(
    <div className="payslip-overlay" role="dialog" aria-modal="true" aria-label={t("payslip.view")}>
      <div className="payslip-toolbar">
        <span>
          {payslips.length > 1 ? t("payslip.countHint", { count: payslips.length }) + " " : ""}
          {t("payslip.printHint")}
        </span>
        <div>
          <button type="button" className="primary-button" onClick={() => window.print()}>
            <Printer size={15} /> {t("payslip.print")}
          </button>
          <button type="button" className="secondary-button" onClick={onClose}>
            <X size={15} /> {t("payslip.close")}
          </button>
        </div>
      </div>
      {payslips.map((payslip) => (
        <PayslipSheet key={payslip.id} payslip={payslip} company={company} />
      ))}
    </div>,
    document.body,
  );
}

function PayslipSheet({ payslip, company }: { payslip: Payslip; company: PayrollCompany | null }) {
  const { inputs } = payslip;
  const { from, to } = monthRange(payslip.period);
  const earnings = payslip.lines.filter((line) => line.kind === "earning");
  const withheld = payslip.lines.filter((line) => line.kind === "contribution" || line.kind === "deduction");
  const employer = payslip.lines.filter((line) => line.kind === "employer");
  const totalGains = round3(earnings.filter((line) => line.amount > 0).reduce((sum, line) => sum + line.amount, 0));
  const totalWithheld = round3(
    earnings.filter((line) => line.amount < 0).reduce((sum, line) => sum - line.amount, 0) +
      withheld.reduce((sum, line) => sum + line.amount, 0),
  );
  const rate = (value: number | null) =>
    value == null ? "" : `${(value * 100).toLocaleString("fr-FR", { maximumFractionDigits: 3 })} %`;
  const base = (value: number | null) => (value == null ? "" : frAmount(value));
  const family = [
    FR_MARITAL[inputs.contract.maritalStatus] ?? "",
    inputs.contract.dependentChildren
      ? `${inputs.contract.dependentChildren} enfant${inputs.contract.dependentChildren > 1 ? "s" : ""}`
      : "",
    inputs.contract.headOfFamily ? "chef de famille" : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
      <article className="payslip-doc">
        <header className="payslip-doc-head">
          <div>
            <h2>{company?.name ?? "Kachabiti"}</h2>
            {company?.address && <p>{company.address}</p>}
            {company?.taxId && <p>Matricule fiscal : {company.taxId}</p>}
            {company?.cnssEmployerNumber && <p>N° affiliation CNSS : {company.cnssEmployerNumber}</p>}
          </div>
          <div className="payslip-doc-title">
            <h1>Bulletin de paie</h1>
            <p>
              Période du {frDate(from)} au {frDate(to)}
            </p>
            <p>Paiement par virement</p>
          </div>
        </header>

        <section className="payslip-doc-info">
          <dl>
            <div><dt>Nom et prénom</dt><dd>{inputs.employee.name}</dd></div>
            <div><dt>Emploi</dt><dd>{inputs.employee.jobTitle ?? "—"}</dd></div>
            <div><dt>Service</dt><dd>{inputs.employee.department}</dd></div>
            <div><dt>Date d’embauche</dt><dd>{frDate(inputs.employee.startDate)}</dd></div>
          </dl>
          <dl>
            <div><dt>Contrat</dt><dd>{FR_CONTRACT[inputs.contract.contractType] ?? "—"}</dd></div>
            <div>
              <dt>N° CNSS</dt>
              <dd>
                {isExemptContract(inputs.contract.contractType)
                  ? "Non applicable (SIVP)"
                  : inputs.contract.cnssNumber ?? "—"}
              </dd>
            </div>
            <div><dt>Situation familiale</dt><dd>{family || "—"}</dd></div>
            <div>
              <dt>Banque / RIB</dt>
              <dd>{[inputs.contract.bankName, inputs.contract.rib].filter(Boolean).join(" · ") || "—"}</dd>
            </div>
          </dl>
        </section>

        <table className="payslip-doc-table">
          <thead>
            <tr>
              <th>Rubrique</th>
              <th>Base</th>
              <th>Taux</th>
              <th>Gains</th>
              <th>Retenues</th>
            </tr>
          </thead>
          <tbody>
            {earnings.map((line, index) => (
              <tr key={`e-${index}`}>
                <td>{line.label}</td>
                <td>{line.base == null ? "" : line.base.toLocaleString("fr-FR")}</td>
                <td>{line.code === "overtime" ? rate(line.rate) : line.rate == null ? "" : frAmount(line.rate)}</td>
                <td>{line.amount >= 0 ? frAmount(line.amount) : ""}</td>
                <td>{line.amount < 0 ? frAmount(-line.amount) : ""}</td>
              </tr>
            ))}
            <tr className="is-subtotal">
              <td>Salaire brut</td>
              <td />
              <td />
              <td colSpan={2}>{frAmount(payslip.gross)}</td>
            </tr>
            {withheld.map((line, index) => (
              <tr key={`w-${index}`}>
                <td>{line.label}</td>
                <td>{base(line.base)}</td>
                <td>{rate(line.rate)}</td>
                <td />
                <td>{frAmount(line.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Totaux</td>
              <td>{frAmount(totalGains)}</td>
              <td>{frAmount(totalWithheld)}</td>
            </tr>
          </tfoot>
        </table>

        <section className="payslip-doc-net">
          <div>
            <span>Net à payer</span>
            <strong>{frAmount(payslip.net)} TND</strong>
          </div>
          <p>
            Arrêté le présent bulletin à la somme de : <b>{amountInFrenchWords(payslip.net)}</b>
          </p>
        </section>

        <section className="payslip-doc-foot">
          <dl>
            <div><dt>Salaire imposable du mois</dt><dd>{frAmount(payslip.taxableIncome)}</dd></div>
            {employer.map((line, index) => (
              <div key={`p-${index}`}>
                <dt>
                  {line.label} ({rate(line.rate)})
                </dt>
                <dd>{frAmount(line.amount)}</dd>
              </div>
            ))}
            <div><dt>Coût total employeur</dt><dd>{frAmount(payslip.employerCost)}</dd></div>
          </dl>
          {isExemptContract(inputs.contract.contractType) && (
            <p>Contrat SIVP : exonéré de cotisations CNSS, d’IRPP et de CSS.</p>
          )}
          <p>Conservez ce bulletin sans limitation de durée.</p>
        </section>
      </article>
  );
}

// ---------------------------------------------------------------------------
// Employee: My payslips (validated months only; RLS filters)
// ---------------------------------------------------------------------------

export function MyPayslips({
  employeeId,
  flash: rawFlash,
}: {
  employeeId: string | null | undefined;
  flash: (message: string) => void;
}) {
  const flash = useStableFlash(rawFlash);
  const { t, dateLocale } = useLanguage();
  const [payslips, setPayslips] = useState<Payslip[] | null>(null);
  const [open, setOpen] = useState<Payslip | null>(null);

  useEffect(() => {
    if (!employeeId) return;
    let cancelled = false;
    loadMyPayslips(employeeId)
      .then((rows) => {
        if (!cancelled) setPayslips(rows);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        // Payroll not set up yet: show the empty state, not an error.
        if (!isMissingPayrollTable(error.message)) flash(error.message);
        setPayslips([]);
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId, flash]);

  return (
    <section className="card profile-section profile-section-wide my-payslips" id="payslips">
      <h2>{t("payslip.myTitle")}</h2>
      <p>{t("payslip.myNote")}</p>
      {payslips === null ? (
        <p className="contract-hint">{t("contract.loading")}</p>
      ) : payslips.length === 0 ? (
        <p className="contract-hint">{t("payslip.myEmpty")}</p>
      ) : (
        <div className="pay-item-list my-payslips-list">
          {payslips.map((payslip) => (
            <div className="pay-item" key={payslip.id}>
              <div>
                <b className="is-month">{monthLabel(payslip.period, dateLocale)}</b>
                <span>
                  {t("payroll.gross")} {formatTnd(payslip.gross, dateLocale)}
                </span>
              </div>
              <strong>{formatTnd(payslip.net, dateLocale)}</strong>
              <button type="button" className="secondary-button" onClick={() => setOpen(payslip)}>
                <FileText size={14} /> {t("payslip.open")}
              </button>
            </div>
          ))}
        </div>
      )}
      {open && <PayslipDocument payslips={[open]} onClose={() => setOpen(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Exports (CSV for the accountant and the bank portal)
// ---------------------------------------------------------------------------

function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PayrollExports({
  period,
  run,
  payslips,
  flash,
  onPrintAll,
  inProgress,
}: {
  period: string;
  run: PayrollRun;
  payslips: Payslip[];
  flash: (message: string) => void;
  onPrintAll: () => void;
  inProgress: boolean;
}) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState<string | null>(null);
  const published = run.status !== "draft";
  const months = quarterMonths(period);
  const quarter = Math.floor((Number(period.slice(5, 7)) - 1) / 3) + 1;
  const year = Number(period.slice(0, 4));
  const noRib = missingRib(payslips);

  const exportBank = () => {
    if (!published) return flash(t("export.validateFirst"));
    downloadCsv(`virements-${period}.csv`, bankTransferCsv(payslips, `Salaire ${period}`));
    if (noRib.length) {
      flash(t("export.missingRib", { names: noRib.map((item) => item.inputs.employee.name).join(", ") }));
    }
  };

  const exportJournal = () => {
    downloadCsv(
      `journal-paie-${period}${published ? "" : "-brouillon"}.csv`,
      payrollJournalCsv(payslips),
    );
  };

  const exportRange = async (kind: "quarter" | "year") => {
    if (busy) return;
    setBusy(kind);
    try {
      const from = kind === "quarter" ? monthRange(months[0]).from : `${year}-01-01`;
      const to = kind === "quarter" ? monthRange(months[2]).to : `${year}-12-31`;
      const rows = await loadPublishedPayslips(from, to);
      if (!rows.length) {
        flash(t("export.nothingValidated"));
      } else if (kind === "quarter") {
        downloadCsv(`cnss-${year}-T${quarter}.csv`, cnssQuarterCsv(rows, period));
      } else {
        downloadCsv(`retenues-${year}.csv`, annualTaxCsv(rows, year));
      }
    } catch (error) {
      flash((error as Error).message);
    }
    setBusy(null);
  };

  return (
    <section className="card payroll-exports">
      <div>
        <p className="eyebrow">{t("export.title")}</p>
        <p className="contract-hint">{t("export.note")}</p>
      </div>
      <div className="payroll-export-grid">
        <button
          type="button"
          className="payroll-export"
          onClick={onPrintAll}
          disabled={payslips.length === 0 || inProgress}
        >
          <Printer size={16} />
          <span>
            <b>{t("payslip.exportAll")}</b>
            <small>
              {inProgress
                ? t("payroll.validateAfterMonth")
                : published
                ? t("payslip.exportAllNote", { count: payslips.length })
                : t("payslip.exportAllDraft")}
            </small>
          </span>
        </button>
        <button type="button" className="payroll-export" onClick={exportBank} disabled={!published}>
          <Download size={16} />
          <span>
            <b>{t("export.bank")}</b>
            <small>{published ? t("export.bankNote") : t("export.validateFirst")}</small>
          </span>
        </button>
        <button type="button" className="payroll-export" onClick={exportJournal}>
          <Download size={16} />
          <span>
            <b>{t("export.journal")}</b>
            <small>{published ? t("export.journalNote") : t("export.journalDraftNote")}</small>
          </span>
        </button>
        <button type="button" className="payroll-export" onClick={() => void exportRange("quarter")}>
          <Download size={16} />
          <span>
            <b>{t("export.cnss", { quarter, year })}</b>
            <small>{busy === "quarter" ? t("panel.pleaseWait") : t("export.cnssNote")}</small>
          </span>
        </button>
        <button type="button" className="payroll-export" onClick={() => void exportRange("year")}>
          <Download size={16} />
          <span>
            <b>{t("export.annual", { year })}</b>
            <small>{busy === "year" ? t("panel.pleaseWait") : t("export.annualNote")}</small>
          </span>
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// "How much for N days?" — estimate from the contract, outside the time clock
// ---------------------------------------------------------------------------

function PaySimulator({ payslip }: { payslip: Payslip }) {
  const { t, dateLocale } = useLanguage();
  const [value, setValue] = useState("10");
  const [unit, setUnit] = useState<"days" | "hours">("days");
  const { contract, rates, auto } = payslip.inputs;
  const quantity = Math.max(0, Number(value.replace(",", ".")) || 0);
  const hours = unit === "days" ? quantity * SIMULATION_DAY_HOURS : quantity;
  const scheduled = auto.scheduledHours ?? 0;
  const result = simulatePay(contract, rates, hours, scheduled);
  const money = (amount: number) => formatTnd(amount, dateLocale);

  return (
    <div className="detail-block pay-simulator">
      <p className="eyebrow">{t("payroll.simTitle")}</p>
      <span className="contract-hint">{t("payroll.simNote", { hours: SIMULATION_DAY_HOURS })}</span>
      <div className="pay-simulator-input">
        <input
          id={`sim-${payslip.id}`}
          type="number"
          min="0"
          step={unit === "days" ? "0.5" : "0.25"}
          value={value}
          aria-label={t("payroll.simQuantity")}
          onChange={(event) => setValue(event.target.value)}
        />
        <select
          aria-label={t("payroll.simUnit")}
          value={unit}
          onChange={(event) => setUnit(event.target.value as "days" | "hours")}
        >
          <option value="days">{t("payroll.simDays")}</option>
          <option value="hours">{t("payroll.simHours")}</option>
        </select>
      </div>
      <dl>
        <div><dt>{t("payroll.simHourValue")}</dt><dd>{money(result.hourValue)}</dd></div>
        <div><dt>{t("payroll.simDayValue", { hours: SIMULATION_DAY_HOURS })}</dt><dd>{money(round3(result.hourValue * SIMULATION_DAY_HOURS))}</dd></div>
        <div><dt>{t("payroll.gross")}</dt><dd>{money(result.gross)}</dd></div>
        <div><dt>{t("payroll.cnss")}</dt><dd>{money(result.cnssEmployee)}</dd></div>
        <div><dt>{t("payroll.tax")}</dt><dd>{money(round3(result.irpp + result.css))}</dd></div>
        <div className="is-net"><dt>{t("payroll.net")}</dt><dd>{money(result.net)}</dd></div>
      </dl>
    </div>
  );
}
