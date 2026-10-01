// Payroll (fiche de paie) types and row mapping. Tables: supabase/payroll.sql.

export const CONTRACT_TYPES = ["cdi", "cdd", "sivp", "karama", "internship", "other"] as const;
export const PAY_BASES = ["monthly", "hourly"] as const;
export const MARITAL_STATUSES = ["single", "married", "divorced", "widowed"] as const;

export type ContractType = (typeof CONTRACT_TYPES)[number];
export type PayBasis = (typeof PAY_BASES)[number];
export type MaritalStatus = (typeof MARITAL_STATUSES)[number];

export type EmployeeContract = {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  contractType: ContractType;
  contractEnd: string | null;
  payBasis: PayBasis;
  baseSalary: number;
  hourlyRate: number | null;
  weeklyHours: number;
  cnssNumber: string | null;
  maritalStatus: MaritalStatus;
  headOfFamily: boolean;
  dependentChildren: number;
  bankName: string | null;
  rib: string | null;
};

export type EmployeeContractRow = {
  id: string;
  employee_id: string;
  effective_from: string;
  contract_type: string;
  contract_end: string | null;
  pay_basis: string;
  base_salary: number | string;
  hourly_rate: number | string | null;
  weekly_hours: number | string;
  cnss_number: string | null;
  marital_status: string;
  head_of_family: boolean;
  dependent_children: number;
  bank_name: string | null;
  rib: string | null;
};

export const CONTRACT_SELECT =
  "id, employee_id, effective_from, contract_type, contract_end, pay_basis, base_salary, hourly_rate, weekly_hours, cnss_number, marital_status, head_of_family, dependent_children, bank_name, rib";

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function mapContract(row: EmployeeContractRow): EmployeeContract {
  return {
    id: row.id,
    employeeId: row.employee_id,
    effectiveFrom: row.effective_from,
    contractType: oneOf(CONTRACT_TYPES, row.contract_type, "other"),
    contractEnd: row.contract_end,
    payBasis: oneOf(PAY_BASES, row.pay_basis, "monthly"),
    baseSalary: Number(row.base_salary) || 0,
    hourlyRate: row.hourly_rate == null ? null : Number(row.hourly_rate),
    weeklyHours: Number(row.weekly_hours) || 48,
    cnssNumber: row.cnss_number,
    maritalStatus: oneOf(MARITAL_STATUSES, row.marital_status, "single"),
    headOfFamily: row.head_of_family,
    dependentChildren: row.dependent_children,
    bankName: row.bank_name,
    rib: row.rib,
  };
}

/** The version in force on `onDate` (ISO), else the earliest future one. */
export function currentContract(
  contracts: EmployeeContract[],
  onDate: string,
): EmployeeContract | null {
  const sorted = [...contracts].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return (
    sorted.find((contract) => contract.effectiveFrom <= onDate) ??
    sorted[sorted.length - 1] ??
    null
  );
}

/** Contract types that require an end date. */
export function contractNeedsEnd(type: ContractType) {
  return type === "cdd" || type === "sivp" || type === "karama" || type === "internship";
}

/** TND amounts carry 3 decimals (millimes). */
export function formatTnd(amount: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "TND",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(amount);
}

export function isMissingPayrollTable(message: string | undefined) {
  return Boolean(
    message &&
      /employee_contracts|payroll_/.test(message) &&
      /does not exist|schema cache|Could not find/i.test(message),
  );
}
