// Payslip calculation (fiche de paie, Tunisia). Pure functions with no imports
// so they run under `npm test` without the Next.js toolchain.
//
// Method: monthly CNSS on gross; IRPP on the annualised taxable income
// (×12) after professional expenses and family deductions, then divided by 12.
// The rates come from payroll_settings and must be verified by the accountant;
// the tests in payroll-calc.test.ts pin the method itself.

export type IrppBracket = { upTo: number | null; rate: number };

export type PayrollRates = {
  cnssEmployeeRate: number;
  cnssEmployerRate: number;
  workAccidentRate: number;
  cssRate: number;
  irppBrackets: IrppBracket[];
  professionalExpensesRate: number;
  professionalExpensesCap: number;
  headOfFamilyDeduction: number;
  childDeduction: number;
  maxChildren: number;
  overtimeRate: number;
};

export type PayContract = {
  payBasis: "monthly" | "hourly";
  baseSalary: number;
  hourlyRate: number | null;
  weeklyHours: number;
  headOfFamily: boolean;
  dependentChildren: number;
};

export type PayItem = {
  code: string;
  label: string;
  kind: "earning" | "deduction";
  amount: number;
  subjectToCnss: boolean;
  taxable: boolean;
};

export type PayVariables = {
  /** Hours worked in the month; used for hourly contracts. */
  workedHours: number;
  /** Working days of unpaid leave in the month. */
  unpaidDays: number;
  /** Working days before the hire date or after the contract end. */
  outsideContractDays: number;
  /** Unjustified absence hours to deduct. */
  absenceHours: number;
  /** Overtime hours paid at the overtime rate. */
  overtimeHours: number;
};

export type PayLineKind = "earning" | "deduction" | "contribution" | "employer";

export type PayLine = {
  code: string;
  label: string;
  kind: PayLineKind;
  base: number | null;
  rate: number | null;
  amount: number;
  subjectToCnss: boolean;
  taxable: boolean;
};

export type PayResult = {
  lines: PayLine[];
  gross: number;
  cnssBase: number;
  cnssEmployee: number;
  taxableIncome: number;
  annualTaxable: number;
  professionalExpenses: number;
  familyDeductions: number;
  annualNetTaxable: number;
  irpp: number;
  css: number;
  otherDeductions: number;
  net: number;
  employerCnss: number;
  workAccident: number;
  employerCost: number;
};

export const PAY_LABELS = {
  base: "Salaire de base",
  unpaid: "Retenue congé sans solde",
  outside: "Prorata entrée / sortie",
  absence: "Retenue absences",
  overtime: "Heures supplémentaires",
  cnss: "Cotisation CNSS",
  irpp: "IRPP",
  css: "Contribution sociale de solidarité",
  employerCnss: "CNSS patronale",
  workAccident: "Accident de travail",
} as const;

/** Round to millimes (3 decimals), half away from zero. */
export function round3(value: number) {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 1000 + Number.EPSILON)) / 1000;
}

/** Monthly hours for a weekly schedule: 48h → 208h, 40h → 173.333h. */
export function monthlyHours(weeklyHours: number) {
  return (weeklyHours * 52) / 12;
}

/** Hours in one working day: 6-day week above 40h, otherwise 5 days. */
export function dailyHours(weeklyHours: number) {
  return weeklyHours / (weeklyHours > 40 ? 6 : 5);
}

/** Progressive tax on a yearly amount. Brackets are cumulative upper bounds. */
export function progressiveTax(amount: number, brackets: IrppBracket[]) {
  let tax = 0;
  let lower = 0;
  for (const bracket of brackets) {
    if (amount <= lower) break;
    const upper = bracket.upTo ?? Infinity;
    tax += (Math.min(amount, upper) - lower) * bracket.rate;
    lower = upper;
  }
  return tax;
}

function line(
  code: string,
  label: string,
  kind: PayLineKind,
  amount: number,
  options: Partial<Pick<PayLine, "base" | "rate" | "subjectToCnss" | "taxable">> = {},
): PayLine {
  return {
    code,
    label,
    kind,
    base: options.base == null ? null : round3(options.base),
    rate: options.rate ?? null,
    amount: round3(amount),
    subjectToCnss: options.subjectToCnss ?? false,
    taxable: options.taxable ?? false,
  };
}

export function calculatePayslip(
  contract: PayContract,
  rates: PayrollRates,
  variables: PayVariables,
  items: PayItem[] = [],
): PayResult {
  const lines: PayLine[] = [];
  const hours = monthlyHours(contract.weeklyHours);
  const hourly =
    contract.payBasis === "hourly"
      ? contract.hourlyRate ?? 0
      : hours > 0
        ? contract.baseSalary / hours
        : 0;

  // Earnings
  const baseAmount =
    contract.payBasis === "hourly"
      ? hourly * Math.max(0, variables.workedHours)
      : contract.baseSalary;
  lines.push(
    line("base", PAY_LABELS.base, "earning", baseAmount, {
      base: contract.payBasis === "hourly" ? variables.workedHours : null,
      rate: contract.payBasis === "hourly" ? round3(hourly) : null,
      subjectToCnss: true,
      taxable: true,
    }),
  );

  if (contract.payBasis === "monthly") {
    // Absences cannot take the base below zero.
    let remaining = round3(baseAmount);
    const outside = Math.min(
      remaining,
      round3(
        hourly * dailyHours(contract.weeklyHours) * Math.max(0, variables.outsideContractDays),
      ),
    );
    if (outside > 0) {
      remaining = round3(remaining - outside);
      lines.push(
        line("outside", PAY_LABELS.outside, "earning", -outside, {
          base: variables.outsideContractDays,
          subjectToCnss: true,
          taxable: true,
        }),
      );
    }
    const unpaid = Math.min(
      remaining,
      round3(hourly * dailyHours(contract.weeklyHours) * Math.max(0, variables.unpaidDays)),
    );
    if (unpaid > 0) {
      remaining = round3(remaining - unpaid);
      lines.push(
        line("unpaid", PAY_LABELS.unpaid, "earning", -unpaid, {
          base: variables.unpaidDays,
          subjectToCnss: true,
          taxable: true,
        }),
      );
    }
    const absence = Math.min(remaining, round3(hourly * Math.max(0, variables.absenceHours)));
    if (absence > 0) {
      lines.push(
        line("absence", PAY_LABELS.absence, "earning", -absence, {
          base: variables.absenceHours,
          subjectToCnss: true,
          taxable: true,
        }),
      );
    }
  }

  if (variables.overtimeHours > 0) {
    lines.push(
      line(
        "overtime",
        PAY_LABELS.overtime,
        "earning",
        hourly * rates.overtimeRate * variables.overtimeHours,
        {
          base: variables.overtimeHours,
          rate: rates.overtimeRate,
          subjectToCnss: true,
          taxable: true,
        },
      ),
    );
  }

  for (const item of items) {
    if (item.kind !== "earning" || item.amount <= 0) continue;
    lines.push(
      line(item.code, item.label, "earning", item.amount, {
        subjectToCnss: item.subjectToCnss,
        taxable: item.taxable,
      }),
    );
  }

  const earnings = lines.filter((entry) => entry.kind === "earning");
  const gross = round3(earnings.reduce((sum, entry) => sum + entry.amount, 0));
  const cnssBase = round3(
    earnings.filter((entry) => entry.subjectToCnss).reduce((sum, entry) => sum + entry.amount, 0),
  );
  const taxableGross = round3(
    earnings.filter((entry) => entry.taxable).reduce((sum, entry) => sum + entry.amount, 0),
  );

  // Employee contributions
  const cnssEmployee = round3(Math.max(0, cnssBase) * rates.cnssEmployeeRate);
  lines.push(
    line("cnss", PAY_LABELS.cnss, "contribution", cnssEmployee, {
      base: cnssBase,
      rate: rates.cnssEmployeeRate,
    }),
  );

  // CNSS on taxable earnings only is deductible from taxable income.
  const taxableCnss = round3(
    Math.max(
      0,
      earnings
        .filter((entry) => entry.taxable && entry.subjectToCnss)
        .reduce((sum, entry) => sum + entry.amount, 0),
    ) * rates.cnssEmployeeRate,
  );
  const taxableIncome = round3(Math.max(0, taxableGross - taxableCnss));
  const annualTaxable = round3(taxableIncome * 12);
  const professionalExpenses = round3(
    Math.min(annualTaxable * rates.professionalExpensesRate, rates.professionalExpensesCap),
  );
  const children = Math.min(Math.max(0, contract.dependentChildren), rates.maxChildren);
  const familyDeductions = round3(
    (contract.headOfFamily ? rates.headOfFamilyDeduction : 0) + children * rates.childDeduction,
  );
  const annualNetTaxable = round3(
    Math.max(0, annualTaxable - professionalExpenses - familyDeductions),
  );
  const annualIrpp = progressiveTax(annualNetTaxable, rates.irppBrackets);
  const irpp = round3(annualIrpp / 12);
  // CSS applies only to income above the tax-free bracket.
  const css = annualIrpp > 0 ? round3((annualNetTaxable * rates.cssRate) / 12) : 0;

  lines.push(
    line("irpp", PAY_LABELS.irpp, "contribution", irpp, { base: taxableIncome }),
  );
  if (css > 0) {
    lines.push(
      line("css", PAY_LABELS.css, "contribution", css, {
        base: round3(annualNetTaxable / 12),
        rate: rates.cssRate,
      }),
    );
  }

  // Other deductions (advances, loans)
  for (const item of items) {
    if (item.kind !== "deduction" || item.amount <= 0) continue;
    lines.push(line(item.code, item.label, "deduction", item.amount));
  }
  const otherDeductions = round3(
    lines.filter((entry) => entry.kind === "deduction").reduce((sum, entry) => sum + entry.amount, 0),
  );

  const net = round3(gross - cnssEmployee - irpp - css - otherDeductions);

  // Employer side (not deducted from the employee)
  const employerCnss = round3(Math.max(0, cnssBase) * rates.cnssEmployerRate);
  const workAccident = round3(Math.max(0, cnssBase) * rates.workAccidentRate);
  lines.push(
    line("employer_cnss", PAY_LABELS.employerCnss, "employer", employerCnss, {
      base: cnssBase,
      rate: rates.cnssEmployerRate,
    }),
  );
  if (workAccident > 0) {
    lines.push(
      line("work_accident", PAY_LABELS.workAccident, "employer", workAccident, {
        base: cnssBase,
        rate: rates.workAccidentRate,
      }),
    );
  }
  const employerCost = round3(gross + employerCnss + workAccident);

  return {
    lines,
    gross,
    cnssBase,
    cnssEmployee,
    taxableIncome,
    annualTaxable,
    professionalExpenses,
    familyDeductions,
    annualNetTaxable,
    irpp,
    css,
    otherDeductions,
    net,
    employerCnss,
    workAccident,
    employerCost,
  };
}

/** Mon–Sat (6-day week) or Mon–Fri working days of [start, end] inside [from, to]. */
export function workingDaysInRange(
  start: string,
  end: string,
  from: string,
  to: string,
  sixDayWeek: boolean,
  holidays: ReadonlySet<string> = new Set(),
) {
  const first = start > from ? start : from;
  const last = end < to ? end : to;
  if (first > last) return 0;
  let count = 0;
  const cursor = new Date(`${first}T00:00:00Z`);
  const stop = new Date(`${last}T00:00:00Z`);
  while (cursor <= stop) {
    const day = cursor.getUTCDay();
    const iso = cursor.toISOString().slice(0, 10);
    const working = day !== 0 && (sixDayWeek || day !== 6);
    if (working && !holidays.has(iso)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Amount in French words for "Arrêté le présent bulletin à la somme de …". */
export function amountInFrenchWords(amount: number) {
  const units = [
    "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
    "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
  ];
  const tens = ["", "dix", "vingt", "trente", "quarante", "cinquante", "soixante"];

  const below100 = (n: number): string => {
    if (n <= 16) return units[n];
    if (n < 20) return `dix-${units[n - 10]}`;
    if (n < 70) {
      const ten = Math.floor(n / 10);
      const unit = n % 10;
      if (unit === 0) return tens[ten];
      return unit === 1 ? `${tens[ten]} et un` : `${tens[ten]}-${units[unit]}`;
    }
    if (n < 80) return n === 71 ? "soixante et onze" : `soixante-${below100(n - 60)}`;
    if (n === 80) return "quatre-vingts";
    return `quatre-vingt-${below100(n - 80)}`;
  };

  const below1000 = (n: number): string => {
    const hundred = Math.floor(n / 100);
    const rest = n % 100;
    const head =
      hundred === 0 ? "" : hundred === 1 ? "cent" : `${units[hundred]} cent${rest === 0 ? "s" : ""}`;
    if (rest === 0) return head || "zéro";
    return head ? `${head} ${below100(rest)}` : below100(rest);
  };

  const words = (n: number): string => {
    if (n < 1000) return below1000(n);
    if (n < 1_000_000) {
      const thousands = Math.floor(n / 1000);
      const rest = n % 1000;
      // "cents" and "vingts" lose their s before "mille".
      const head =
        thousands === 1 ? "mille" : `${below1000(thousands).replace(/(cent|vingt)s$/, "$1")} mille`;
      return rest ? `${head} ${below1000(rest)}` : head;
    }
    const millions = Math.floor(n / 1_000_000);
    const rest = n % 1_000_000;
    const head = `${below1000(millions)} million${millions > 1 ? "s" : ""}`;
    return rest ? `${head} ${words(rest)}` : head;
  };

  const total = Math.round(Math.max(0, amount) * 1000);
  const dinars = Math.floor(total / 1000);
  const millimes = total % 1000;
  const dinarText = `${words(dinars)} dinar${dinars > 1 ? "s" : ""}`;
  return millimes ? `${dinarText} et ${words(millimes)} millimes` : dinarText;
}
