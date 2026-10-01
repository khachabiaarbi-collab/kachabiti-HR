"use client";

import { useEffect, useState } from "react";
import { Button, Field } from "@/components/primitives";
import { useLanguage } from "@/lib/i18n";
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
import { createClient } from "@/lib/supabase/client";

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
          cnss_number: form.cnssNumber.trim() || null,
          marital_status: form.maritalStatus,
          head_of_family: form.headOfFamily,
          dependent_children: children,
          bank_name: form.bankName.trim() || null,
          rib: rib || null,
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
      <div className="detail-block">
        <p className="eyebrow">{t("contract.title")}</p>
        <span>{t("contract.loading")}</span>
      </div>
    );
  }

  if (state === "missing") {
    return (
      <div className="detail-block">
        <p className="eyebrow">{t("contract.title")}</p>
        <span>{t("contract.missingTable")}</span>
      </div>
    );
  }

  const isNewVersion = !contracts.some((item) => item.effectiveFrom === form.effectiveFrom);

  return (
    <div className="detail-block contract-block">
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
      <Field
        label={t("contract.cnssNumber")}
        name="cnss_number"
        value={form.cnssNumber}
        onChange={(value) => set("cnssNumber", value)}
      />

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
    </div>
  );
}
