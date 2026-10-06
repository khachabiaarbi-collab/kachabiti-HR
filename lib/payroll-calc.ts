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
  /** "sivp" contracts are exempt from CNSS, IRPP and CSS. */
  contractType?: string;
};

/** Contract types with no CNSS (employee or employer), IRPP or CSS. */
export const EXEMPT_CONTRACT_TYPES = ["sivp"];

export function isExemptContract(contractType: string | undefined) {
  return contractType != null && EXEMPT_CONTRACT_TYPES.includes(contractType);
}

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
  /** Scheduled working days with no punch and no approved leave. */
  absentDays: number;
  /** Unjustified absence hours to deduct. */
  absenceHours: number;
  /**
   * Month in progress only: hours earned so far (punched, authorized, holidays,
   * paid leave). The base is then paid for these hours and the rest of the
   * month is not paid yet. Leave unset for a finished month.
   */
  earnedHours?: number | null;
  /** Overtime hours paid at the overtime rate. */
  overtimeHours: number;
  /**
   * Time-clock pay (monthly contracts): scheduled hours of the whole month.
   * When > 0 the salary is paid per hour: absenceHours (past), outsideHours,
   * unpaidHours and notYetHours are deducted at salary ÷ scheduledHours, and
   * the day-based fields above are ignored.
   */
  scheduledHours?: number | null;
  outsideHours?: number;
  unpaidHours?: number;
  notYetHours?: number;
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
  absentDays: "Retenue absences non justifiées",
  remaining: "Période du mois non encore travaillée",
  absenceHours: "Retenue heures non travaillées",
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
  // Payslips saved before a variable existed have it undefined.
  const v = (value: number | undefined) => Math.max(0, Number(value) || 0);
  const exempt = isExemptContract(contract.contractType);
  const clockMode = contract.payBasis === "monthly" && v(variables.scheduledHours ?? 0) > 0;
  const hours = clockMode ? v(variables.scheduledHours ?? 0) : monthlyHours(contract.weeklyHours);
  const hourly =
    contract.payBasis === "hourly"
      ? contract.hourlyRate ?? 0
      : hours > 0
        ? contract.baseSalary / hours
        : 0;

  // Earnings
  const baseAmount =
    contract.payBasis === "hourly"
      ? hourly * v(variables.workedHours)
      : contract.baseSalary;
  lines.push(
    line("base", PAY_LABELS.base, "earning", baseAmount, {
      base: contract.payBasis === "hourly" ? variables.workedHours : clockMode ? hours : null,
      rate: contract.payBasis === "hourly" || clockMode ? round3(hourly) : null,
      subjectToCnss: true,
      taxable: true,
    }),
  );

  if (clockMode) {
    // Paid per hour against the month's schedule; deductions cannot exceed the base.
    let remaining = round3(baseAmount);
    const deduct = (code: string, label: string, amountHours: number | undefined) => {
      const value = Math.min(remaining, round3(hourly * v(amountHours)));
      if (value <= 0) return;
      remaining = round3(remaining - value);
      lines.push(
        line(code, label, "earning", -value, {
          base: v(amountHours),
          rate: round3(hourly),
          subjectToCnss: true,
          taxable: true,
        }),
      );
    };
    deduct("outside", PAY_LABELS.outside, variables.outsideHours);
    deduct("unpaid", PAY_LABELS.unpaid, variables.unpaidHours);
    deduct("absence", PAY_LABELS.absenceHours, variables.absenceHours);
    deduct("remaining", PAY_LABELS.remaining, variables.notYetHours);
  } else if (contract.payBasis === "monthly") {
    // Absences cannot take the base below zero.
    let remaining = round3(baseAmount);
    const outside = Math.min(
      remaining,
      round3(
        hourly * dailyHours(contract.weeklyHours) * v(variables.outsideContractDays),
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
      round3(hourly * dailyHours(contract.weeklyHours) * v(variables.unpaidDays)),
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
    const absentDays = Math.min(
      remaining,
      round3(hourly * dailyHours(contract.weeklyHours) * v(variables.absentDays)),
    );
    if (absentDays > 0) {
      remaining = round3(remaining - absentDays);
      lines.push(
        line("absent_days", PAY_LABELS.absentDays, "earning", -absentDays, {
          base: variables.absentDays,
          subjectToCnss: true,
          taxable: true,
        }),
      );
    }
    const absence = Math.min(remaining, round3(hourly * v(variables.absenceHours)));
    if (absence > 0) {
      remaining = round3(remaining - absence);
      lines.push(
        line("absence", PAY_LABELS.absence, "earning", -absence, {
          base: variables.absenceHours,
          subjectToCnss: true,
          taxable: true,
        }),
      );
    }
    // A month in progress pays only the hours earned up to today.
    if (variables.earnedHours != null) {
      const earned = round3(hourly * v(variables.earnedHours));
      const notYet = Math.max(0, round3(remaining - earned));
      if (notYet > 0) {
        lines.push(
          line("remaining", PAY_LABELS.remaining, "earning", -notYet, {
            subjectToCnss: true,
            taxable: true,
          }),
        );
      }
    }
  }

  if (v(variables.overtimeHours) > 0) {
    lines.push(
      line(
        "overtime",
        PAY_LABELS.overtime,
        "earning",
        hourly * rates.overtimeRate * v(variables.overtimeHours),
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

  // Employee contributions (none on an exempt contract such as SIVP)
  const cnssEmployee = exempt ? 0 : round3(Math.max(0, cnssBase) * rates.cnssEmployeeRate);
  if (!exempt) {
    lines.push(
      line("cnss", PAY_LABELS.cnss, "contribution", cnssEmployee, {
        base: cnssBase,
        rate: rates.cnssEmployeeRate,
      }),
    );
  }

  // CNSS on taxable earnings only is deductible from taxable income.
  const taxableCnss = round3(
    Math.max(
      0,
      earnings
        .filter((entry) => entry.taxable && entry.subjectToCnss)
        .reduce((sum, entry) => sum + entry.amount, 0),
    ) * rates.cnssEmployeeRate,
  );
  const taxableIncome = exempt ? 0 : round3(Math.max(0, taxableGross - taxableCnss));
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

  if (!exempt) {
    lines.push(
      line("irpp", PAY_LABELS.irpp, "contribution", irpp, { base: taxableIncome }),
    );
  }
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
  const employerCnss = exempt ? 0 : round3(Math.max(0, cnssBase) * rates.cnssEmployerRate);
  const workAccident = exempt ? 0 : round3(Math.max(0, cnssBase) * rates.workAccidentRate);
  if (!exempt) {
    lines.push(
      line("employer_cnss", PAY_LABELS.employerCnss, "employer", employerCnss, {
        base: cnssBase,
        rate: rates.cnssEmployerRate,
      }),
    );
  }
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

// ---------------------------------------------------------------------------
// Attendance → payroll variables
// ---------------------------------------------------------------------------

export type AttendanceDay = {
  date: string;
  scheduledMinutes: number;
  workedMinutes: number;
  authorizedMinutes: number;
  /** Tunis local "HH:MM" windows, used by the quarter-hour rules when present. */
  segments?: { start: string; end: string }[];
  sessions?: { in: string; out: string | null }[];
  authorizations?: { start: string; end: string }[];
};

export type AttendanceSummary = {
  /** Days counted, from the 1st to `countedUntil` (the month end, or today in a month in progress). */
  countedUntil: string;
  scheduledDays: number;
  workedDays: number;
  holidayDays: number;
  paidLeaveDays: number;
  unpaidDays: number;
  outsideContractDays: number;
  absentDays: number;
  missingHours: number;
  workedHours: number;
  /** Hours that count as paid so far: punched (capped at the schedule), authorized, holidays, paid leave. */
  earnedHours: number;
  /** Quarter-hour reading of the month (time-clock pay). */
  clock?: ClockMonth;
};

/**
 * The month's scheduled hours split five ways; the parts always add up to
 * `scheduledHours`.
 */
export type ClockMonth = {
  scheduledHours: number;
  /** Worked (quarter-hour rules), authorized, public holidays and paid leave. */
  creditedHours: number;
  /** Before the hire date or after the contract end. */
  outsideHours: number;
  unpaidHours: number;
  /** Past scheduled time not credited: absences, lateness, early leaving. */
  absenceHours: number;
  /** Month in progress: the rest of today and the days after. */
  notYetHours: number;
  overtimeHours: number;
  lateCount: number;
  earlyLeaveCount: number;
  absentDays: number;
};

/** Reads a month with the quarter-hour rules (see creditDay). */
export function summarizeClockMonth(
  days: AttendanceDay[],
  options: {
    employedFrom: string | null;
    employedTo: string | null;
    holidays: ReadonlySet<string>;
    leave: ReadonlyMap<string, boolean>;
    /** Month in progress: today's date and the current time "HH:MM". */
    today?: string | null;
    now?: string | null;
  },
): ClockMonth {
  const minutes = { scheduled: 0, credited: 0, outside: 0, unpaid: 0, absence: 0, notYet: 0, overtime: 0 };
  let lateCount = 0;
  let earlyLeaveCount = 0;
  let absentDays = 0;
  const today = options.today ?? null;

  for (const day of days) {
    const scheduled = day.scheduledMinutes;
    if (scheduled <= 0) continue;
    minutes.scheduled += scheduled;
    const employed =
      (!options.employedFrom || day.date >= options.employedFrom) &&
      (!options.employedTo || day.date <= options.employedTo);
    if (!employed) {
      minutes.outside += scheduled;
      continue;
    }
    if (today !== null && day.date > today) {
      minutes.notYet += scheduled;
      continue;
    }
    const leave = options.leave.get(day.date);
    if (options.holidays.has(day.date) || leave === false) {
      minutes.credited += scheduled;
      continue;
    }
    if (leave === true) {
      minutes.unpaid += scheduled;
      continue;
    }
    const isToday = today !== null && day.date === today;
    const credit = day.segments
      ? creditDay(day.segments, day.sessions ?? [], day.authorizations ?? [], isToday ? options.now ?? null : null)
      : {
          creditedMinutes: Math.min(scheduled, Math.max(0, day.workedMinutes) + Math.max(0, day.authorizedMinutes)),
          overtimeMinutes: 0,
          lateCount: 0,
          earlyLeaveCount: 0,
        };
    const credited = Math.min(scheduled, credit.creditedMinutes);
    minutes.credited += credited;
    minutes.overtime += credit.overtimeMinutes;
    lateCount += credit.lateCount;
    // Today is not over: leaving "early" cannot be judged yet.
    if (!isToday) earlyLeaveCount += credit.earlyLeaveCount;
    if (isToday) {
      minutes.notYet += scheduled - credited;
    } else {
      minutes.absence += scheduled - credited;
      if (credited === 0) absentDays += 1;
    }
  }

  const hours = (value: number) => round3(value / 60);
  return {
    scheduledHours: hours(minutes.scheduled),
    creditedHours: hours(minutes.credited),
    outsideHours: hours(minutes.outside),
    unpaidHours: hours(minutes.unpaid),
    absenceHours: hours(minutes.absence),
    notYetHours: hours(minutes.notYet),
    overtimeHours: hours(minutes.overtime),
    lateCount,
    earlyLeaveCount,
    absentDays,
  };
}

/**
 * Reads one employee's month of attendance. For each scheduled working day
 * inside the contract: a public holiday or approved paid leave is paid; unpaid
 * leave is counted as unpaid; no punch at all is an absent day; a short day
 * loses the time missing beyond the grace period and approved authorizations.
 * Scheduled days outside the contract are counted separately (pro-rata).
 */
export function summarizeAttendance(
  days: AttendanceDay[],
  options: {
    countedUntil: string;
    employedFrom: string | null;
    employedTo: string | null;
    holidays: ReadonlySet<string>;
    /** Approved leave by date: true when unpaid. */
    leave: ReadonlyMap<string, boolean>;
    graceMinutes: number;
    /** Set while the month is in progress: today's date. */
    today?: string | null;
  },
): AttendanceSummary {
  const summary: AttendanceSummary = {
    countedUntil: options.countedUntil,
    scheduledDays: 0,
    workedDays: 0,
    holidayDays: 0,
    paidLeaveDays: 0,
    unpaidDays: 0,
    outsideContractDays: 0,
    absentDays: 0,
    missingHours: 0,
    workedHours: 0,
    earnedHours: 0,
  };
  let missingMinutes = 0;
  let workedMinutes = 0;
  let earnedMinutes = 0;
  const today = options.today ?? null;

  for (const day of days) {
    if (day.date > options.countedUntil) continue;
    const employed =
      (!options.employedFrom || day.date >= options.employedFrom) &&
      (!options.employedTo || day.date <= options.employedTo);
    const future = today !== null && day.date > today;
    if (employed && !future) workedMinutes += Math.max(0, day.workedMinutes);
    if (day.scheduledMinutes <= 0) continue;
    if (future) continue;
    if (options.holidays.has(day.date)) {
      if (employed) {
        summary.holidayDays += 1;
        earnedMinutes += day.scheduledMinutes;
      }
      continue;
    }
    if (!employed) {
      summary.outsideContractDays += 1;
      continue;
    }
    summary.scheduledDays += 1;
    const leave = options.leave.get(day.date);
    if (leave !== undefined) {
      if (leave) summary.unpaidDays += 1;
      else {
        summary.paidLeaveDays += 1;
        earnedMinutes += day.scheduledMinutes;
      }
      continue;
    }
    earnedMinutes += Math.min(
      day.scheduledMinutes,
      Math.max(0, day.workedMinutes) + Math.max(0, day.authorizedMinutes),
    );
    if (today !== null && day.date === today) {
      // Today is not over: time not worked yet is not an absence.
      if (day.workedMinutes > 0) summary.workedDays += 1;
      continue;
    }
    if (day.workedMinutes <= 0 && day.authorizedMinutes <= 0) {
      summary.absentDays += 1;
      continue;
    }
    if (day.workedMinutes > 0) summary.workedDays += 1;
    const missing = day.scheduledMinutes - day.workedMinutes - day.authorizedMinutes;
    if (missing > options.graceMinutes) missingMinutes += missing;
  }

  summary.missingHours = round3(missingMinutes / 60);
  summary.workedHours = round3(workedMinutes / 60);
  summary.earnedHours = round3(earnedMinutes / 60);
  return summary;
}

// ---------------------------------------------------------------------------
// Quarter-hour discipline rules (time clock → credited time)
// ---------------------------------------------------------------------------
//
// Time counts in quarter hours and only inside the schedule:
// - an entry is moved up to the next quarter (07:55 → 08:00 at the schedule
//   start, 08:01 or 08:10 → 08:15); there is no tolerance;
// - an exit is moved down to the previous quarter (08:50 → 08:45) and never
//   counts past the end of the schedule (17:05 or 17:30 → 17:00);
// - approved authorizations count as worked time;
// - overtime is the time after the end of the schedule, counted only when the
//   full scheduled day was earned and the extra reaches one hour.

export type TimeWindow = { start: string; end: string };
export type PunchSession = { in: string; out: string | null };

export type DayCredit = {
  creditedMinutes: number;
  overtimeMinutes: number;
  /** Arrived after the start of a scheduled segment (morning or after the break). */
  lateCount: number;
  /** Left before the end of a scheduled segment. */
  earlyLeaveCount: number;
};

const QUARTER = 15;
const OVERTIME_MINIMUM = 60;

export function clockMinutes(value: string) {
  const [hours = "0", minutes = "0"] = value.split(":");
  return (Number(hours) || 0) * 60 + (Number(minutes.slice(0, 2)) || 0);
}

const ceilQuarter = (minutes: number) => Math.ceil(minutes / QUARTER) * QUARTER;
const floorQuarter = (minutes: number) => Math.floor(minutes / QUARTER) * QUARTER;

function mergeIntervals(intervals: [number, number][]) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

function overlap(intervals: [number, number][], [from, to]: [number, number]) {
  return intervals.reduce(
    (total, [a, b]) => total + Math.max(0, Math.min(b, to) - Math.max(a, from)),
    0,
  );
}

/**
 * Credited time of one day. `now` ("HH:MM") closes a session still open today;
 * open sessions on other days are ignored (incomplete day).
 */
export function creditDay(
  segments: TimeWindow[],
  sessions: PunchSession[],
  authorizations: TimeWindow[] = [],
  now: string | null = null,
): DayCredit {
  const schedule = segments
    .map(({ start, end }): [number, number] => [clockMinutes(start), clockMinutes(end)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const worked = mergeIntervals(
    sessions.flatMap(({ in: entry, out }): [number, number][] => {
      const exit = out ?? now;
      if (!exit) return [];
      return [[ceilQuarter(clockMinutes(entry)), floorQuarter(clockMinutes(exit))]];
    }),
  );
  const covered = mergeIntervals([
    ...worked,
    ...authorizations.map(({ start, end }): [number, number] => [clockMinutes(start), clockMinutes(end)]),
  ]);

  const scheduled = schedule.reduce((total, [a, b]) => total + (b - a), 0);
  const creditedMinutes = schedule.reduce((total, window) => total + overlap(covered, window), 0);

  let lateCount = 0;
  let earlyLeaveCount = 0;
  for (const [a, b] of schedule) {
    const inside = covered.filter(([x, y]) => y > a && x < b);
    if (!inside.length) continue;
    if (inside[0][0] > a) lateCount += 1;
    if (inside[inside.length - 1][1] < b) earlyLeaveCount += 1;
  }

  const dayEnd = schedule.length ? schedule[schedule.length - 1][1] : 0;
  const extra = schedule.length ? overlap(worked, [dayEnd, 24 * 60]) : 0;
  const overtimeMinutes =
    scheduled > 0 && creditedMinutes >= scheduled && extra >= OVERTIME_MINIMUM ? extra : 0;

  return { creditedMinutes, overtimeMinutes, lateCount, earlyLeaveCount };
}
