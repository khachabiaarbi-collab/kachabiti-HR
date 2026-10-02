import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annualTaxCsv,
  bankTransferCsv,
  cnssQuarterCsv,
  decimal,
  missingRib,
  payrollJournalCsv,
  quarterMonths,
  toCsv,
  type ExportPayslip,
} from "./payroll-export";

const slip = (
  name: string,
  period: string,
  net: number,
  extra: { rib?: string | null; cnssBase?: number; gross?: number; accident?: number } = {},
): ExportPayslip => ({
  period,
  employeeId: name,
  gross: extra.gross ?? net + 300,
  cnssEmployee: 100,
  taxableIncome: net + 200,
  irpp: 150,
  css: 5,
  otherDeductions: 45,
  net,
  employerCnss: 180,
  employerCost: (extra.gross ?? net + 300) + 180,
  lines: [
    { code: "base", amount: extra.gross ?? net + 300, base: null },
    { code: "cnss", amount: 100, base: extra.cnssBase ?? net + 300 },
    ...(extra.accident ? [{ code: "work_accident", amount: extra.accident, base: null }] : []),
  ],
  inputs: {
    employee: { name, jobTitle: "Dev", department: "Product" },
    contract: { cnssNumber: `CNSS-${name}`, rib: extra.rib === undefined ? "08000000123456789012" : extra.rib, bankName: "BIAT" },
  },
});

const rowsOf = (csv: string) => csv.replace(/^\uFEFF/, "").trim().split("\r\n").map((row) => row.split(";"));

test("CSV escaping, BOM and French decimals", () => {
  const csv = toCsv([["a;b", 'say "hi"', 1234.5]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.slice(1), '"a;b";"say ""hi""";1234,500\r\n');
  assert.equal(decimal(0.1 + 0.2), "0,300");
});

test("bank transfer list sorts by name, totals net, flags missing RIB", () => {
  const payslips = [slip("Zied", "2026-09-01", 1000), slip("Amira", "2026-09-01", 1500.25, { rib: null }), slip("Nour", "2026-09-01", 0)];
  const rows = rowsOf(bankTransferCsv(payslips, "Salaire 2026-09"));
  assert.deepEqual(rows[0], ["Nom et prénom", "Banque", "RIB", "Montant (TND)", "Référence"]);
  assert.deepEqual(rows[1], ["Amira", "BIAT", "RIB MANQUANT", "1500,250", "Salaire 2026-09"]);
  assert.equal(rows[2][0], "Zied");
  assert.equal(rows.length, 4); // zero net is left out
  assert.deepEqual(rows[3], ["Total", "", "", "2500,250", ""]);
  assert.deepEqual(missingRib(payslips).map((p) => p.inputs.employee.name), ["Amira"]);
});

test("journal has one line per payslip and a total line", () => {
  const rows = rowsOf(payrollJournalCsv([slip("B", "2026-09-01", 1000, { accident: 6.5 }), slip("A", "2026-09-01", 2000)]));
  assert.equal(rows.length, 4);
  assert.equal(rows[1][1], "A");
  assert.equal(rows[1][0], "2026-09");
  assert.equal(rows[2][13], "6,500");
  assert.equal(rows[3][11], "3000,000"); // total net
  assert.equal(rows[3][14], "3960,000"); // total employer cost
});

test("quarter months", () => {
  assert.deepEqual(quarterMonths("2026-08"), ["2026-07", "2026-08", "2026-09"]);
  assert.deepEqual(quarterMonths("2026-12-01"), ["2026-10", "2026-11", "2026-12"]);
});

test("CNSS quarter uses the CNSS base per month and ignores other quarters", () => {
  const payslips = [
    slip("A", "2026-07-01", 1000, { cnssBase: 1300 }),
    slip("A", "2026-08-01", 1000, { cnssBase: 1250 }),
    slip("A", "2026-09-01", 1000, { cnssBase: 1300 }),
    slip("B", "2026-09-01", 2000, { cnssBase: 2300 }),
    slip("A", "2026-10-01", 9999, { cnssBase: 9999 }),
  ];
  const rows = rowsOf(cnssQuarterCsv(payslips, "2026-09"));
  assert.deepEqual(rows[0].slice(2, 5), ["Salaire 2026-07", "Salaire 2026-08", "Salaire 2026-09"]);
  assert.deepEqual(rows[1], ["CNSS-A", "A", "1300,000", "1250,000", "1300,000", "3850,000", "300,000", "540,000"]);
  assert.deepEqual(rows[2].slice(2, 6), ["0,000", "0,000", "2300,000", "2300,000"]);
  assert.deepEqual(rows[3].slice(2, 6), ["1300,000", "1250,000", "3600,000", "6150,000"]);
});

test("annual summary counts months and sums IRPP for the year only", () => {
  const payslips = [
    slip("A", "2026-01-01", 1000),
    slip("A", "2026-02-01", 1000),
    slip("A", "2025-12-01", 1000),
  ];
  const rows = rowsOf(annualTaxCsv(payslips, 2026));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].slice(0, 4), ["2026", "A", "CNSS-A", "2"]);
  assert.equal(rows[1][7], "300,000");
  assert.equal(rows[2][9], "2000,000");
});
