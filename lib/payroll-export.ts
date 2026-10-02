// Payroll exports as CSV (semicolon-separated, comma decimals, UTF-8 BOM) so
// they open directly in French-locale Excel. Pure functions with no imports
// so they run under `npm test`.
//
// These are working files for the accountant and the bank portal, not the
// official CNSS e-declaration or a bank-specific upload format.

export type ExportPayslip = {
  period: string;
  employeeId: string;
  gross: number;
  cnssEmployee: number;
  taxableIncome: number;
  irpp: number;
  css: number;
  otherDeductions: number;
  net: number;
  employerCnss: number;
  employerCost: number;
  lines: { code: string; amount: number; base: number | null }[];
  inputs: {
    employee: { name: string; jobTitle: string | null; department: string };
    contract: { cnssNumber: string | null; rib: string | null; bankName: string | null };
  };
};

const BOM = "\uFEFF";

function cell(value: string | number | null | undefined) {
  if (value == null) return "";
  const text = typeof value === "number" ? decimal(value) : value;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 1234.5 → "1234,500" (no thousands separator, for spreadsheets). */
export function decimal(value: number) {
  return (Math.round(value * 1000) / 1000).toFixed(3).replace(".", ",");
}

export function toCsv(rows: (string | number | null | undefined)[][]) {
  return BOM + rows.map((row) => row.map(cell).join(";")).join("\r\n") + "\r\n";
}

const sum = (items: ExportPayslip[], pick: (item: ExportPayslip) => number) =>
  Math.round(items.reduce((total, item) => total + pick(item), 0) * 1000) / 1000;

const byName = (a: ExportPayslip, b: ExportPayslip) =>
  a.inputs.employee.name.localeCompare(b.inputs.employee.name);

const monthOf = (period: string) => period.slice(0, 7);

/** Bank transfer list for one month: who to pay, how much, to which RIB. */
export function bankTransferCsv(payslips: ExportPayslip[], reference: string) {
  const rows = [...payslips].sort(byName).filter((payslip) => payslip.net > 0);
  return toCsv([
    ["Nom et prénom", "Banque", "RIB", "Montant (TND)", "Référence"],
    ...rows.map((payslip) => [
      payslip.inputs.employee.name,
      payslip.inputs.contract.bankName,
      payslip.inputs.contract.rib ?? "RIB MANQUANT",
      payslip.net,
      reference,
    ]),
    ["Total", "", "", sum(rows, (payslip) => payslip.net), ""],
  ]);
}

/** Employees who cannot be paid by transfer (no RIB). */
export function missingRib(payslips: ExportPayslip[]) {
  return payslips.filter((payslip) => payslip.net > 0 && !payslip.inputs.contract.rib);
}

/** Journal de paie: one line per payslip with every total. */
export function payrollJournalCsv(payslips: ExportPayslip[]) {
  const rows = [...payslips].sort(byName);
  const line = (payslip: ExportPayslip, code: string) =>
    payslip.lines.filter((item) => item.code === code).reduce((total, item) => total + item.amount, 0);
  return toCsv([
    [
      "Mois",
      "Nom et prénom",
      "N° CNSS",
      "Emploi",
      "Service",
      "Salaire brut",
      "CNSS salariale",
      "Salaire imposable",
      "IRPP",
      "CSS",
      "Autres retenues",
      "Net à payer",
      "CNSS patronale",
      "Accident de travail",
      "Coût employeur",
    ],
    ...rows.map((payslip) => [
      monthOf(payslip.period),
      payslip.inputs.employee.name,
      payslip.inputs.contract.cnssNumber,
      payslip.inputs.employee.jobTitle,
      payslip.inputs.employee.department,
      payslip.gross,
      payslip.cnssEmployee,
      payslip.taxableIncome,
      payslip.irpp,
      payslip.css,
      payslip.otherDeductions,
      payslip.net,
      payslip.employerCnss,
      line(payslip, "work_accident"),
      payslip.employerCost,
    ]),
    [
      "Total",
      "",
      "",
      "",
      "",
      sum(rows, (p) => p.gross),
      sum(rows, (p) => p.cnssEmployee),
      sum(rows, (p) => p.taxableIncome),
      sum(rows, (p) => p.irpp),
      sum(rows, (p) => p.css),
      sum(rows, (p) => p.otherDeductions),
      sum(rows, (p) => p.net),
      sum(rows, (p) => p.employerCnss),
      sum(rows, (p) => line(p, "work_accident")),
      sum(rows, (p) => p.employerCost),
    ],
  ]);
}

/** The three months ("YYYY-MM") of the quarter containing `period`. */
export function quarterMonths(period: string) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const first = Math.floor((month - 1) / 3) * 3 + 1;
  return [0, 1, 2].map((offset) => `${year}-${String(first + offset).padStart(2, "0")}`);
}

/**
 * Quarterly CNSS summary: salary declared per employee for each month of the
 * quarter (the CNSS base), with employee and employer contributions.
 */
export function cnssQuarterCsv(payslips: ExportPayslip[], period: string) {
  const months = quarterMonths(period);
  const inQuarter = payslips.filter((payslip) => months.includes(monthOf(payslip.period)));
  const people = new Map<string, ExportPayslip[]>();
  for (const payslip of inQuarter) {
    people.set(payslip.employeeId, [...(people.get(payslip.employeeId) ?? []), payslip]);
  }
  const rows = [...people.values()]
    .map((items) => items.sort((a, b) => a.period.localeCompare(b.period)))
    .sort((a, b) => byName(a[0], b[0]));
  const monthBase = (items: ExportPayslip[], month: string) =>
    sum(items.filter((item) => monthOf(item.period) === month), cnssBase);
  return toCsv([
    [
      "N° CNSS",
      "Nom et prénom",
      ...months.map((month) => `Salaire ${month}`),
      "Total trimestre",
      "CNSS salariale",
      "CNSS patronale",
    ],
    ...rows.map((items) => [
      items[0].inputs.contract.cnssNumber,
      items[0].inputs.employee.name,
      ...months.map((month) => monthBase(items, month)),
      sum(items, cnssBase),
      sum(items, (p) => p.cnssEmployee),
      sum(items, (p) => p.employerCnss),
    ]),
    [
      "Total",
      "",
      ...months.map((month) => monthBase(inQuarter, month)),
      sum(inQuarter, cnssBase),
      sum(inQuarter, (p) => p.cnssEmployee),
      sum(inQuarter, (p) => p.employerCnss),
    ],
  ]);
}

/** Salary subject to CNSS: the base stored on the employee CNSS line. */
export function cnssBase(payslip: ExportPayslip) {
  return payslip.lines.find((item) => item.code === "cnss")?.base ?? payslip.gross;
}

/** Yearly per-employee totals, the basis of the certificat de retenue à la source. */
export function annualTaxCsv(payslips: ExportPayslip[], year: number) {
  const inYear = payslips.filter((payslip) => payslip.period.startsWith(`${year}-`));
  const people = new Map<string, ExportPayslip[]>();
  for (const payslip of inYear) {
    people.set(payslip.employeeId, [...(people.get(payslip.employeeId) ?? []), payslip]);
  }
  const rows = [...people.values()].sort((a, b) => byName(a[0], b[0]));
  return toCsv([
    [
      "Année",
      "Nom et prénom",
      "N° CNSS",
      "Mois payés",
      "Salaire brut",
      "CNSS salariale",
      "Salaire imposable",
      "IRPP retenu",
      "CSS retenue",
      "Net payé",
    ],
    ...rows.map((items) => [
      String(year),
      items[0].inputs.employee.name,
      items[0].inputs.contract.cnssNumber,
      String(items.length),
      sum(items, (p) => p.gross),
      sum(items, (p) => p.cnssEmployee),
      sum(items, (p) => p.taxableIncome),
      sum(items, (p) => p.irpp),
      sum(items, (p) => p.css),
      sum(items, (p) => p.net),
    ]),
    [
      "Total",
      "",
      "",
      "",
      sum(inYear, (p) => p.gross),
      sum(inYear, (p) => p.cnssEmployee),
      sum(inYear, (p) => p.taxableIncome),
      sum(inYear, (p) => p.irpp),
      sum(inYear, (p) => p.css),
      sum(inYear, (p) => p.net),
    ],
  ]);
}
