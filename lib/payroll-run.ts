// Payroll runs: load, prepare (calculate and save) and lock a month.
// Admin-only; Supabase RLS in supabase/payroll.sql enforces it.

import type { Employee } from "@/lib/app-types";
import { isUnpaidLeaveType } from "@/lib/map-rows";
import {
  CONTRACT_SELECT,
  mapContract,
  type EmployeeContract,
  type EmployeeContractRow,
} from "@/lib/payroll";
import {
  calculatePayslip,
  round3,
  workingDaysInRange,
  type IrppBracket,
  type PayItem,
  type PayLine,
  type PayrollRates,
  type PayVariables,
} from "@/lib/payroll-calc";
import { createClient } from "@/lib/supabase/client";
import { loadTunisiaHolidays } from "@/lib/tunisia-holidays";

export type RunStatus = "draft" | "validated" | "paid";

export type PayrollRun = {
  id: string;
  period: string;
  status: RunStatus;
  validatedAt: string | null;
  paidAt: string | null;
};

export type PayrollSettings = PayrollRates & { year: number; verified: boolean };

export type PayComponent = {
  id: string;
  code: string;
  name: string;
  kind: "earning" | "deduction";
  subjectToCnss: boolean;
  taxable: boolean;
  active: boolean;
};

export type EmployeePayComponent = {
  id: string;
  employeeId: string;
  componentId: string;
  amount: number;
  startsOn: string;
  endsOn: string | null;
};

export type PayslipWarning =
  | "rates_unverified"
  | "no_cnss_number"
  | "no_rib"
  | "hourly_no_hours"
  | "negative_net"
  | "contract_ends";

export type PayslipInputs = {
  employee: {
    name: string;
    email: string;
    jobTitle: string | null;
    department: string;
    startDate: string | null;
  };
  contract: EmployeeContract;
  rates: PayrollRates;
  /** Values read from leave, attendance and the hire/end dates. */
  auto: PayVariables;
  /** Values the admin overrode for this month. */
  manual: Partial<PayVariables>;
  /** Recurring components attached to the employee. */
  fixed: PayItem[];
  /** One-off bonuses or deductions for this month. */
  oneOff: PayItem[];
};

export type Payslip = {
  id: string;
  runId: string;
  employeeId: string;
  period: string;
  inputs: PayslipInputs;
  gross: number;
  cnssEmployee: number;
  taxableIncome: number;
  irpp: number;
  css: number;
  otherDeductions: number;
  net: number;
  employerCnss: number;
  employerCost: number;
  warnings: PayslipWarning[];
  lines: PayLine[];
};

const PAYSLIP_SELECT =
  "id, run_id, employee_id, period, inputs, gross, cnss_employee, taxable_income, irpp, css, other_deductions, net, employer_cnss, employer_cost, warnings, payslip_lines ( code, label, kind, base, rate, amount, subject_to_cnss, taxable, position )";

type PayslipRow = {
  id: string;
  run_id: string;
  employee_id: string;
  period: string;
  inputs: PayslipInputs;
  gross: number | string;
  cnss_employee: number | string;
  taxable_income: number | string;
  irpp: number | string;
  css: number | string;
  other_deductions: number | string;
  net: number | string;
  employer_cnss: number | string;
  employer_cost: number | string;
  warnings: PayslipWarning[] | null;
  payslip_lines?: {
    code: string;
    label: string;
    kind: PayLine["kind"];
    base: number | string | null;
    rate: number | string | null;
    amount: number | string;
    subject_to_cnss: boolean;
    taxable: boolean;
    position: number;
  }[];
};

const num = (value: number | string | null | undefined) => Number(value ?? 0) || 0;

export function mapPayslip(row: PayslipRow): Payslip {
  return {
    id: row.id,
    runId: row.run_id,
    employeeId: row.employee_id,
    period: row.period,
    inputs: row.inputs,
    gross: num(row.gross),
    cnssEmployee: num(row.cnss_employee),
    taxableIncome: num(row.taxable_income),
    irpp: num(row.irpp),
    css: num(row.css),
    otherDeductions: num(row.other_deductions),
    net: num(row.net),
    employerCnss: num(row.employer_cnss),
    employerCost: num(row.employer_cost),
    warnings: row.warnings ?? [],
    lines: [...(row.payslip_lines ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        code: line.code,
        label: line.label,
        kind: line.kind,
        base: line.base == null ? null : num(line.base),
        rate: line.rate == null ? null : num(line.rate),
        amount: num(line.amount),
        subjectToCnss: line.subject_to_cnss,
        taxable: line.taxable,
      })),
  };
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

/** "2026-09" → { from: "2026-09-01", to: "2026-09-30", year: 2026 } */
export function monthRange(period: string) {
  const [year, month] = period.slice(0, 7).split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, "0")}`, year, month };
}

export function shiftMonth(period: string, delta: number) {
  const { year, month } = monthRange(period);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(period: string, locale: string) {
  const { year, month } = monthRange(period);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

// ---------------------------------------------------------------------------
// Settings and components
// ---------------------------------------------------------------------------

type SettingsRow = {
  year: number;
  cnss_employee_rate: number | string;
  cnss_employer_rate: number | string;
  work_accident_rate: number | string;
  css_rate: number | string;
  irpp_brackets: { up_to: number | null; rate: number }[];
  professional_expenses_rate: number | string;
  professional_expenses_cap: number | string;
  head_of_family_deduction: number | string;
  child_deduction: number | string;
  max_children: number;
  overtime_rate: number | string;
  verified: boolean;
};

function mapSettings(row: SettingsRow): PayrollSettings {
  return {
    year: row.year,
    cnssEmployeeRate: num(row.cnss_employee_rate),
    cnssEmployerRate: num(row.cnss_employer_rate),
    workAccidentRate: num(row.work_accident_rate),
    cssRate: num(row.css_rate),
    irppBrackets: (row.irpp_brackets ?? []).map(
      (bracket): IrppBracket => ({
        upTo: bracket.up_to == null ? null : Number(bracket.up_to),
        rate: Number(bracket.rate),
      }),
    ),
    professionalExpensesRate: num(row.professional_expenses_rate),
    professionalExpensesCap: num(row.professional_expenses_cap),
    headOfFamilyDeduction: num(row.head_of_family_deduction),
    childDeduction: num(row.child_deduction),
    maxChildren: row.max_children,
    overtimeRate: num(row.overtime_rate),
    verified: row.verified,
  };
}

export function ratesOnly(settings: PayrollSettings): PayrollRates {
  const { year: _year, verified: _verified, ...rates } = settings;
  return rates;
}

export async function loadSettings(year: number) {
  const { data, error } = await createClient()
    .from("payroll_settings")
    .select("*")
    .eq("year", year)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapSettings(data as SettingsRow) : null;
}

export async function saveSettings(settings: PayrollSettings) {
  const { error } = await createClient()
    .from("payroll_settings")
    .upsert({
      year: settings.year,
      cnss_employee_rate: settings.cnssEmployeeRate,
      cnss_employer_rate: settings.cnssEmployerRate,
      work_accident_rate: settings.workAccidentRate,
      css_rate: settings.cssRate,
      irpp_brackets: settings.irppBrackets.map((bracket) => ({
        up_to: bracket.upTo,
        rate: bracket.rate,
      })),
      professional_expenses_rate: settings.professionalExpensesRate,
      professional_expenses_cap: settings.professionalExpensesCap,
      head_of_family_deduction: settings.headOfFamilyDeduction,
      child_deduction: settings.childDeduction,
      max_children: settings.maxChildren,
      overtime_rate: settings.overtimeRate,
      verified: settings.verified,
    });
  if (error) throw new Error(error.message);
}

type ComponentRow = {
  id: string;
  code: string;
  name: string;
  kind: "earning" | "deduction";
  subject_to_cnss: boolean;
  taxable: boolean;
  active: boolean;
};

const mapComponent = (row: ComponentRow): PayComponent => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: row.kind,
  subjectToCnss: row.subject_to_cnss,
  taxable: row.taxable,
  active: row.active,
});

export async function loadComponents() {
  const { data, error } = await createClient()
    .from("pay_components")
    .select("id, code, name, kind, subject_to_cnss, taxable, active")
    .order("kind")
    .order("name");
  if (error) throw new Error(error.message);
  return ((data ?? []) as ComponentRow[]).map(mapComponent);
}

export async function saveComponent(component: Omit<PayComponent, "id"> & { id?: string }) {
  const row = {
    code: component.code,
    name: component.name,
    kind: component.kind,
    subject_to_cnss: component.subjectToCnss,
    taxable: component.taxable,
    active: component.active,
  };
  const supabase = createClient();
  const { error } = component.id
    ? await supabase.from("pay_components").update(row).eq("id", component.id)
    : await supabase.from("pay_components").insert(row);
  if (error) throw new Error(error.message);
}

export function toPayItem(component: PayComponent, amount: number): PayItem {
  return {
    code: component.code,
    label: component.name,
    kind: component.kind,
    amount: round3(amount),
    subjectToCnss: component.subjectToCnss,
    taxable: component.taxable,
  };
}

type EmployeeComponentRow = {
  id: string;
  employee_id: string;
  component_id: string;
  amount: number | string;
  starts_on: string;
  ends_on: string | null;
};

const mapEmployeeComponent = (row: EmployeeComponentRow): EmployeePayComponent => ({
  id: row.id,
  employeeId: row.employee_id,
  componentId: row.component_id,
  amount: num(row.amount),
  startsOn: row.starts_on,
  endsOn: row.ends_on,
});

const EMPLOYEE_COMPONENT_SELECT = "id, employee_id, component_id, amount, starts_on, ends_on";

/** Components active on any day of [from, to]. */
export async function loadEmployeeComponents(from: string, to: string, employeeId?: string) {
  let query = createClient()
    .from("employee_pay_components")
    .select(EMPLOYEE_COMPONENT_SELECT)
    .lte("starts_on", to)
    .or(`ends_on.is.null,ends_on.gte.${from}`);
  if (employeeId) query = query.eq("employee_id", employeeId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as EmployeeComponentRow[]).map(mapEmployeeComponent);
}

export async function addEmployeeComponent(
  employeeId: string,
  componentId: string,
  amount: number,
  startsOn: string,
) {
  const { error } = await createClient().from("employee_pay_components").insert({
    employee_id: employeeId,
    component_id: componentId,
    amount: round3(amount),
    starts_on: startsOn,
  });
  if (error) throw new Error(error.message);
}

/** Stop a recurring component; drop it entirely if it never applied. */
export async function endEmployeeComponent(item: EmployeePayComponent, lastDay: string) {
  const supabase = createClient();
  const { error } =
    lastDay < item.startsOn
      ? await supabase.from("employee_pay_components").delete().eq("id", item.id)
      : await supabase.from("employee_pay_components").update({ ends_on: lastDay }).eq("id", item.id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Runs and payslips
// ---------------------------------------------------------------------------

type RunRow = {
  id: string;
  period: string;
  status: RunStatus;
  validated_at: string | null;
  paid_at: string | null;
};

const mapRun = (row: RunRow): PayrollRun => ({
  id: row.id,
  period: row.period,
  status: row.status,
  validatedAt: row.validated_at,
  paidAt: row.paid_at,
});

export async function loadRun(period: string) {
  const { from } = monthRange(period);
  const { data, error } = await createClient()
    .from("payroll_runs")
    .select("id, period, status, validated_at, paid_at")
    .eq("period", from)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapRun(data as RunRow) : null;
}

export async function loadPayslips(runId: string) {
  const { data, error } = await createClient()
    .from("payslips")
    .select(PAYSLIP_SELECT)
    .eq("run_id", runId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as PayslipRow[]).map(mapPayslip);
}

/** Validated or paid payslips of the signed-in employee (RLS filters). */
export async function loadMyPayslips(employeeId: string) {
  const { data, error } = await createClient()
    .from("payslips")
    .select(PAYSLIP_SELECT)
    .eq("employee_id", employeeId)
    .order("period", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as PayslipRow[]).map(mapPayslip);
}

export async function loadPayslip(id: string) {
  const { data, error } = await createClient()
    .from("payslips")
    .select(PAYSLIP_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapPayslip(data as PayslipRow) : null;
}

export async function setRunStatus(run: PayrollRun, status: RunStatus, rates?: PayrollRates) {
  const patch: Record<string, unknown> = { status };
  if (status === "validated" && rates) patch.settings_snapshot = rates;
  const { error } = await createClient().from("payroll_runs").update(patch).eq("id", run.id);
  if (error) throw new Error(error.message);
}

export async function deleteDraftRun(run: PayrollRun) {
  const { error } = await createClient().from("payroll_runs").delete().eq("id", run.id);
  if (error) throw new Error(error.message);
}

export function effectiveVariables(inputs: PayslipInputs): PayVariables {
  return { ...inputs.auto, ...inputs.manual };
}

function payslipWarnings(inputs: PayslipInputs, net: number, verified: boolean, to: string) {
  const warnings: PayslipWarning[] = [];
  if (!verified) warnings.push("rates_unverified");
  if (!inputs.contract.cnssNumber) warnings.push("no_cnss_number");
  if (!inputs.contract.rib) warnings.push("no_rib");
  if (inputs.contract.payBasis === "hourly" && effectiveVariables(inputs).workedHours <= 0) {
    warnings.push("hourly_no_hours");
  }
  if (net < 0) warnings.push("negative_net");
  if (inputs.contract.contractEnd && inputs.contract.contractEnd <= to) warnings.push("contract_ends");
  return warnings;
}

/** Calculate from inputs and replace the payslip (and its lines) of the run. */
async function writePayslip(
  runId: string,
  period: string,
  employeeId: string,
  inputs: PayslipInputs,
  verified: boolean,
) {
  const result = calculatePayslip(
    inputs.contract,
    inputs.rates,
    effectiveVariables(inputs),
    [...inputs.fixed, ...inputs.oneOff],
  );
  const supabase = createClient();
  const { data, error } = await supabase
    .from("payslips")
    .upsert(
      {
        run_id: runId,
        employee_id: employeeId,
        period,
        inputs,
        gross: result.gross,
        cnss_employee: result.cnssEmployee,
        taxable_income: result.taxableIncome,
        irpp: result.irpp,
        css: result.css,
        other_deductions: result.otherDeductions,
        net: result.net,
        employer_cnss: result.employerCnss,
        employer_cost: result.employerCost,
        warnings: payslipWarnings(inputs, result.net, verified, monthRange(period).to),
      },
      { onConflict: "run_id,employee_id" },
    )
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const payslipId = (data as { id: string }).id;
  const { error: deleteError } = await supabase
    .from("payslip_lines")
    .delete()
    .eq("payslip_id", payslipId);
  if (deleteError) throw new Error(deleteError.message);
  const { error: insertError } = await supabase.from("payslip_lines").insert(
    result.lines.map((line, position) => ({
      payslip_id: payslipId,
      position,
      code: line.code,
      label: line.label,
      kind: line.kind,
      base: line.base,
      rate: line.rate,
      amount: line.amount,
      subject_to_cnss: line.subjectToCnss,
      taxable: line.taxable,
    })),
  );
  if (insertError) throw new Error(insertError.message);
}

/** Save the admin's changes to one draft payslip and recalculate it. */
export async function updatePayslip(
  payslip: Payslip,
  manual: Partial<PayVariables>,
  oneOff: PayItem[],
  verified: boolean,
) {
  await writePayslip(
    payslip.runId,
    payslip.period,
    payslip.employeeId,
    { ...payslip.inputs, manual, oneOff },
    verified,
  );
}

export type PrepareResult = {
  run: PayrollRun;
  missingContract: Employee[];
};

/**
 * Create the month's draft run if needed, then (re)calculate every active
 * employee with a contract in force. Manual overrides and one-off items on
 * existing draft payslips are kept; contract, rates, leave and attendance are
 * read again.
 */
export async function prepareRun(
  period: string,
  employees: Employee[],
  settings: PayrollSettings,
): Promise<PrepareResult> {
  const supabase = createClient();
  const { from, to, year } = monthRange(period);

  let run = await loadRun(period);
  if (!run) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("payroll_runs")
      .insert({ period: from, created_by: user?.id ?? null })
      .select("id, period, status, validated_at, paid_at")
      .single();
    if (error) throw new Error(error.message);
    run = mapRun(data as RunRow);
  }
  if (run.status !== "draft") return { run, missingContract: [] };

  const [contractRows, components, employeeComponents, leaveRows, holidays, existing] =
    await Promise.all([
      supabase
        .from("employee_contracts")
        .select(CONTRACT_SELECT)
        .lte("effective_from", to)
        .order("effective_from", { ascending: false }),
      loadComponents(),
      loadEmployeeComponents(from, to),
      supabase
        .from("leave_requests")
        .select("employee_id, start_date, end_date, status, leave_types ( name, default_days )")
        .lte("start_date", to)
        .gte("end_date", from),
      loadTunisiaHolidays(year),
      loadPayslips(run.id),
    ]);
  if (contractRows.error) throw new Error(contractRows.error.message);
  if (leaveRows.error) throw new Error(leaveRows.error.message);

  const contracts = ((contractRows.data ?? []) as EmployeeContractRow[]).map(mapContract);
  const holidaySet = new Set(holidays.map((holiday) => holiday.date));
  const componentById = new Map(components.map((component) => [component.id, component]));
  const existingByEmployee = new Map(existing.map((payslip) => [payslip.employeeId, payslip]));

  type LeaveRow = {
    employee_id: string;
    start_date: string;
    end_date: string;
    status: string;
    leave_types: { name: string; default_days: number } | { name: string; default_days: number }[] | null;
  };
  const unpaidLeave = ((leaveRows.data ?? []) as LeaveRow[]).filter((row) => {
    const type = Array.isArray(row.leave_types) ? row.leave_types[0] : row.leave_types;
    return (
      row.status.toLowerCase() === "approved" &&
      type != null &&
      isUnpaidLeaveType({ name: type.name, defaultDays: Number(type.default_days) || 0 })
    );
  });

  const missingContract: Employee[] = [];
  const included = new Set<string>();

  for (const employee of employees) {
    if (employee.status === "Inactive") continue;
    // Latest version that started on or before the month end (list is newest first).
    const contract = contracts.find((item) => item.employeeId === employee.id);
    if (!contract || (contract.contractEnd && contract.contractEnd < from)) {
      if (!contract) missingContract.push(employee);
      continue;
    }

    const sixDayWeek = contract.weeklyHours > 40;
    const startsAfter = employee.startDate && employee.startDate > from ? employee.startDate : null;
    const endsBefore = contract.contractEnd && contract.contractEnd < to ? contract.contractEnd : null;
    const outsideContractDays =
      (startsAfter
        ? workingDaysInRange(from, previousDay(startsAfter), from, to, sixDayWeek, holidaySet)
        : 0) +
      (endsBefore
        ? workingDaysInRange(nextDay(endsBefore), to, from, to, sixDayWeek, holidaySet)
        : 0);
    const unpaidDays = unpaidLeave
      .filter((row) => row.employee_id === employee.id)
      .reduce(
        (sum, row) =>
          sum + workingDaysInRange(row.start_date, row.end_date, from, to, sixDayWeek, holidaySet),
        0,
      );
    const workedHours =
      contract.payBasis === "hourly" ? await workedHoursInMonth(employee.id, from, to) : 0;

    const previous = existingByEmployee.get(employee.id);
    const inputs: PayslipInputs = {
      employee: {
        name: employee.name,
        email: employee.email,
        jobTitle: employee.jobTitle,
        department: employee.department,
        startDate: employee.startDate,
      },
      contract,
      rates: ratesOnly(settings),
      auto: { workedHours, unpaidDays, outsideContractDays, absenceHours: 0, overtimeHours: 0 },
      manual: previous?.inputs.manual ?? {},
      fixed: employeeComponents
        .filter((item) => item.employeeId === employee.id)
        .flatMap((item) => {
          const component = componentById.get(item.componentId);
          return component ? [toPayItem(component, item.amount)] : [];
        }),
      oneOff: previous?.inputs.oneOff ?? [],
    };
    await writePayslip(run.id, from, employee.id, inputs, settings.verified);
    included.add(employee.id);
  }

  // Drop draft payslips of people no longer eligible (left, contract removed).
  const stale = existing.filter((payslip) => !included.has(payslip.employeeId));
  if (stale.length) {
    const { error } = await supabase
      .from("payslips")
      .delete()
      .in("id", stale.map((payslip) => payslip.id));
    if (error) throw new Error(error.message);
  }

  return { run, missingContract };
}

function nextDay(iso: string) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function previousDay(iso: string) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function workedHoursInMonth(employeeId: string, from: string, to: string) {
  const { data, error } = await createClient().rpc("attendance_report", {
    p_from: from,
    p_to: to,
    p_employee_id: employeeId,
    p_department_id: null,
    p_status: null,
    p_limit: 100,
    p_offset: 0,
  });
  if (error) return 0;
  const items = ((data as { items?: { workedMinutes?: number }[] } | null)?.items ?? []);
  return round3(items.reduce((sum, item) => sum + (Number(item.workedMinutes) || 0), 0) / 60);
}

// ---------------------------------------------------------------------------
// Employer details printed on payslips
// ---------------------------------------------------------------------------

export type PayrollCompany = {
  name: string;
  address: string | null;
  taxId: string | null;
  cnssEmployerNumber: string | null;
};

export async function loadCompany(): Promise<PayrollCompany> {
  const { data, error } = await createClient()
    .from("payroll_company")
    .select("name, address, tax_id, cnss_employer_number")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as
    | { name: string; address: string | null; tax_id: string | null; cnss_employer_number: string | null }
    | null;
  return {
    name: row?.name ?? "Kachabiti",
    address: row?.address ?? null,
    taxId: row?.tax_id ?? null,
    cnssEmployerNumber: row?.cnss_employer_number ?? null,
  };
}

export async function saveCompany(company: PayrollCompany) {
  const { error } = await createClient()
    .from("payroll_company")
    .update({
      name: company.name.trim() || "Kachabiti",
      address: company.address?.trim() || null,
      tax_id: company.taxId?.trim() || null,
      cnss_employer_number: company.cnssEmployerNumber?.trim() || null,
    })
    .eq("id", 1);
  if (error) throw new Error(error.message);
}
