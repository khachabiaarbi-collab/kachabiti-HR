// Run with `npm test`. Expected values were computed independently (decimal
// arithmetic, half-up rounding to millimes) from the method in payroll-calc.ts
// and the 2026 starting rates. Add the accountant's reference payslips here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountInFrenchWords,
  calculatePayslip,
  progressiveTax,
  round3,
  workingDaysInRange,
  type PayContract,
  type PayrollRates,
  type PayVariables,
} from "./payroll-calc";

const rates2026: PayrollRates = {
  cnssEmployeeRate: 0.0918,
  cnssEmployerRate: 0.1657,
  workAccidentRate: 0,
  cssRate: 0.005,
  irppBrackets: [
    { upTo: 5000, rate: 0 },
    { upTo: 10000, rate: 0.15 },
    { upTo: 20000, rate: 0.25 },
    { upTo: 30000, rate: 0.3 },
    { upTo: 40000, rate: 0.33 },
    { upTo: 50000, rate: 0.36 },
    { upTo: 70000, rate: 0.38 },
    { upTo: null, rate: 0.4 },
  ],
  professionalExpensesRate: 0.1,
  professionalExpensesCap: 2000,
  headOfFamilyDeduction: 300,
  childDeduction: 100,
  maxChildren: 4,
  overtimeRate: 1.25,
};

const monthly = (baseSalary: number, extra: Partial<PayContract> = {}): PayContract => ({
  payBasis: "monthly",
  baseSalary,
  hourlyRate: null,
  weeklyHours: 48,
  headOfFamily: false,
  dependentChildren: 0,
  ...extra,
});

const noVariables: PayVariables = { workedHours: 0, unpaidDays: 0, absenceHours: 0, overtimeHours: 0 };

test("1500 TND, single, no extras", () => {
  const result = calculatePayslip(monthly(1500), rates2026, noVariables);
  assert.equal(result.gross, 1500);
  assert.equal(result.cnssEmployee, 137.7);
  assert.equal(result.taxableIncome, 1362.3);
  assert.equal(result.professionalExpenses, 1634.76);
  assert.equal(result.annualNetTaxable, 14712.84);
  assert.equal(result.irpp, 160.684);
  assert.equal(result.css, 6.13);
  assert.equal(result.net, 1195.486);
  assert.equal(result.employerCnss, 248.55);
  assert.equal(result.employerCost, 1748.55);
});

test("3000 TND, head of family with 2 children, expenses capped", () => {
  const result = calculatePayslip(
    monthly(3000, { headOfFamily: true, dependentChildren: 2 }),
    rates2026,
    noVariables,
  );
  assert.equal(result.cnssEmployee, 275.4);
  assert.equal(result.professionalExpenses, 2000);
  assert.equal(result.familyDeductions, 500);
  assert.equal(result.annualNetTaxable, 30195.2);
  assert.equal(result.irpp, 526.201);
  assert.equal(result.css, 12.581);
  assert.equal(result.net, 2185.818);
});

test("low salary pays no IRPP and no CSS", () => {
  const result = calculatePayslip(monthly(500), rates2026, noVariables);
  assert.equal(result.irpp, 0);
  assert.equal(result.css, 0);
  assert.equal(result.net, 454.1);
  assert.ok(!result.lines.some((line) => line.code === "css"));
});

test("unpaid day, overtime, bonus and advance", () => {
  const result = calculatePayslip(
    monthly(1850),
    rates2026,
    { workedHours: 0, unpaidDays: 1, absenceHours: 0, overtimeHours: 10 },
    [
      { code: "transport", label: "Prime de transport", kind: "earning", amount: 80, subjectToCnss: true, taxable: true },
      { code: "advance", label: "Avance sur salaire", kind: "deduction", amount: 200, subjectToCnss: false, taxable: false },
    ],
  );
  const byCode = Object.fromEntries(result.lines.map((line) => [line.code, line.amount]));
  assert.equal(byCode.unpaid, -71.154);
  assert.equal(byCode.overtime, 111.178);
  assert.equal(result.gross, 1970.024);
  assert.equal(result.cnssEmployee, 180.848);
  assert.equal(result.irpp, 259.794);
  assert.equal(result.css, 8.113);
  assert.equal(result.otherDeductions, 200);
  assert.equal(result.net, 1321.269);
});

test("high salary reaches the 40% bracket", () => {
  const result = calculatePayslip(monthly(8000), rates2026, noVariables);
  assert.equal(result.irpp, 2235.407);
  assert.equal(result.css, 35.495);
  assert.equal(result.net, 4994.698);
});

test("non-taxable bonus adds to net but not to IRPP", () => {
  const plain = calculatePayslip(monthly(1500), rates2026, noVariables);
  const withBonus = calculatePayslip(monthly(1500), rates2026, noVariables, [
    { code: "gift", label: "Prime exceptionnelle", kind: "earning", amount: 100, subjectToCnss: false, taxable: false },
  ]);
  assert.equal(withBonus.irpp, plain.irpp);
  assert.equal(withBonus.cnssEmployee, plain.cnssEmployee);
  assert.equal(withBonus.net, round3(plain.net + 100));
});

test("absences never push the base below zero", () => {
  const result = calculatePayslip(
    monthly(1000),
    rates2026,
    { workedHours: 0, unpaidDays: 40, absenceHours: 50, overtimeHours: 0 },
  );
  assert.equal(result.gross, 0);
  assert.equal(result.net, 0);
});

test("hourly contract pays worked hours", () => {
  const result = calculatePayslip(
    { ...monthly(0), payBasis: "hourly", hourlyRate: 7.5 },
    rates2026,
    { workedHours: 160, unpaidDays: 3, absenceHours: 0, overtimeHours: 0 },
  );
  assert.equal(result.gross, 1200);
  assert.ok(!result.lines.some((line) => line.code === "unpaid"));
});

test("progressive tax", () => {
  assert.equal(progressiveTax(5000, rates2026.irppBrackets), 0);
  assert.equal(round3(progressiveTax(10000, rates2026.irppBrackets)), 750);
  assert.equal(round3(progressiveTax(80000, rates2026.irppBrackets)), 24750);
});

test("working days skip Sundays (and Saturdays on a 5-day week) and holidays", () => {
  // September 2026: 1st is a Tuesday.
  assert.equal(workingDaysInRange("2026-09-01", "2026-09-30", "2026-09-01", "2026-09-30", true), 26);
  assert.equal(workingDaysInRange("2026-09-01", "2026-09-30", "2026-09-01", "2026-09-30", false), 22);
  assert.equal(workingDaysInRange("2026-08-28", "2026-09-02", "2026-09-01", "2026-09-30", true), 2);
  assert.equal(
    workingDaysInRange("2026-09-01", "2026-09-03", "2026-09-01", "2026-09-30", true, new Set(["2026-09-02"])),
    2,
  );
});

test("amount in French words", () => {
  assert.equal(amountInFrenchWords(1195.486), "mille cent quatre-vingt-quinze dinars et quatre cent quatre-vingt-six millimes");
  assert.equal(amountInFrenchWords(2000), "deux mille dinars");
  assert.equal(amountInFrenchWords(71.1), "soixante et onze dinars et cent millimes");
  assert.equal(amountInFrenchWords(200000), "deux cent mille dinars");
  assert.equal(amountInFrenchWords(1), "un dinar");
});
