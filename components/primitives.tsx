"use client";

import { createContext, useContext } from "react";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { Company, Employee } from "@/lib/app-types";
import { companyInitial } from "@/lib/company-profile-file";
import { DatePicker, DateRangePicker } from "@/components/date-range-picker";
import {
  filterOptionLabel,
  translateStatus,
  useT,
  leaveTypeLabel,
} from "@/lib/i18n";
import { leaveTypeTone } from "@/lib/map-rows";

export const TABLE_PAGE_SIZE = 8;

export function paginate<T>(items: T[], page: number, size = TABLE_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), pageCount);
  const startIndex = (current - 1) * size;
  return {
    items: items.slice(startIndex, startIndex + size),
    page: current,
    pageCount,
    start: items.length === 0 ? 0 : startIndex + 1,
    end: Math.min(startIndex + size, items.length),
    total: items.length,
  };
}

export function pageForId<T extends { id: string }>(
  items: T[],
  id: string | null,
  size = TABLE_PAGE_SIZE,
) {
  if (!id) return 1;
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return 1;
  return Math.floor(index / size) + 1;
}

function pageNumbers(page: number, pageCount: number) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const shown = new Set([1, pageCount, page, page - 1, page + 1]);
  if (page <= 3) {
    shown.add(2);
    shown.add(3);
    shown.add(4);
  }
  if (page >= pageCount - 2) {
    shown.add(pageCount - 3);
    shown.add(pageCount - 2);
    shown.add(pageCount - 1);
  }
  const ordered = [...shown]
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];
  for (const value of ordered) {
    const previous = items[items.length - 1];
    if (typeof previous === "number" && value - previous > 1) {
      items.push("ellipsis");
    }
    items.push(value);
  }
  return items;
}

/** Product name shown before sign-in, when no company is known yet. */
export const PRODUCT_NAME = "RHFlow";

/** The signed-in user's company; null on the sign-in screens. */
export const CompanyContext = createContext<Company | null>(null);

export function useCompany() {
  return useContext(CompanyContext);
}

/** Company logo, or its first letter when it has none. */
export function CompanyMark({
  company,
  className,
}: {
  company: Pick<Company, "name" | "logoUrl">;
  className: string;
}) {
  if (company.logoUrl) {
    return <img className={`${className} has-image`} src={company.logoUrl} alt="" />;
  }
  return (
    <span className={className} aria-hidden="true">
      {companyInitial(company.name)}
    </span>
  );
}

export function Avatar({
  e,
  small = false,
}: {
  e: Pick<Employee, "initials" | "color"> & { avatarUrl?: string | null };
  small?: boolean;
}) {
  if (e.avatarUrl) {
    return (
      <img
        className={`avatar ${small ? "avatar-small" : ""}`}
        src={e.avatarUrl}
        alt=""
      />
    );
  }
  return (
    <div className={`avatar ${e.color} ${small ? "avatar-small" : ""}`}>
      {e.initials}
    </div>
  );
}

export function Logo({ dark = false }: { dark?: boolean }) {
  const company = useCompany();
  const shown = company ?? { name: PRODUCT_NAME, logoUrl: null };
  return (
    <div className={`brand-logo ${dark ? "dark-logo" : ""}`}>
      <CompanyMark company={shown} className="brand-logo-image" />
      <b>{shown.name}</b>
    </div>
  );
}

export function Status({ status }: { status: string }) {
  const t = useT();
  const tone =
    status === "Pending"
      ? "status-pending"
      : status === "Approved" || status === "Active"
        ? "status-approved"
        : "status-declined";
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot" />
      {translateStatus(t, status)}
    </span>
  );
}

export function LeaveTypeLabel({ type }: { type: string }) {
  const t = useT();
  return (
    <span className={`status-pill type-pill ${leaveTypeTone(type)}`}>
      {leaveTypeLabel(t, type)}
    </span>
  );
}

export function Metric({
  label,
  value,
  note,
  tone,
  icon,
  trend,
  valueTone,
}: {
  label: string;
  value: string;
  note: string;
  tone: string;
  icon: React.ReactNode;
  trend?: { label: string; tone: "positive" | "negative" | "warning" | "info" };
  valueTone?: "negative" | "positive";
}) {
  return (
    <div className="card metric-card">
      <div className="metric-top">
        <p>{label}</p>
        <div className={`metric-icon metric-${tone}`}>{icon}</div>
      </div>
      <div className="metric-value-row">
        <strong className={valueTone ? `is-${valueTone}` : undefined}>
          {value}
        </strong>
        {trend && (
          <span className={`metric-trend is-${trend.tone}`}>{trend.label}</span>
        )}
      </div>
      <small>{note}</small>
    </div>
  );
}

export function Button({
  children,
  onClick,
  secondary = false,
  type,
  disabled = false,
  busy = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  secondary?: boolean;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Shows a spinner and blocks clicks while an action runs. */
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      className={`${secondary ? "secondary-button" : "primary-button"}${busy ? " is-busy" : ""}`}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <span className="button-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Field({
  label,
  type = "text",
  value,
  onChange,
  name,
  step,
  min,
  max,
  readOnly = false,
  required = false,
  hint,
  error,
}: {
  label: string;
  type?: string;
  value?: string;
  onChange?: (value: string) => void;
  name?: string;
  step?: string;
  min?: string;
  max?: string;
  readOnly?: boolean;
  required?: boolean;
  /** Helper text under the input. */
  hint?: string;
  /** Validation message; replaces the hint and marks the input invalid. */
  error?: string | null;
}) {
  const caption = error ? (
    <span className="field-error" role="alert">{error}</span>
  ) : hint ? (
    <span className="field-hint">{hint}</span>
  ) : null;
  const heading = (
    <span className="form-label-text">
      {label}
      {required && <span className="field-required" aria-hidden="true"> *</span>}
    </span>
  );
  if (type === "date") {
    return (
      <label className={`form-label${error ? " has-error" : ""}`}>
        {heading}
        <DatePicker
          name={name}
          value={onChange || readOnly ? value : undefined}
          min={min}
          max={max}
          readOnly={readOnly}
          onChange={onChange}
        />
        {caption}
      </label>
    );
  }

  return (
    <label className={`form-label${error ? " has-error" : ""}${readOnly ? " is-readonly" : ""}`}>
      {heading}
      <input
        type={type}
        name={name}
        step={step}
        min={min}
        max={max}
        autoComplete="off"
        readOnly={readOnly}
        required={required}
        aria-invalid={error ? true : undefined}
        {...(onChange
          ? { value: value ?? "", onChange: (e) => onChange(e.target.value) }
          : readOnly
            ? { value: value ?? "" }
            : { defaultValue: value })}
      />
      {caption}
    </label>
  );
}

export function RequestTabs({
  value,
  onChange,
}: {
  value: "leaves" | "authorizations";
  onChange: (value: "leaves" | "authorizations") => void;
}) {
  const t = useT();
  return (
    <div className="request-tabs" role="tablist" aria-label={t("tabs.aria")}>
      <button
        type="button"
        role="tab"
        aria-selected={value === "leaves"}
        className={value === "leaves" ? "is-active" : undefined}
        onClick={() => onChange("leaves")}
      >
        {t("tabs.leaves")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === "authorizations"}
        className={value === "authorizations" ? "is-active" : undefined}
        onClick={() => onChange("authorizations")}
      >
        {t("tabs.authorizations")}
      </button>
    </div>
  );
}

export function Header({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action: React.ReactNode;
}) {
  const t = useT();
  return (
    <section className="welcome-row compact">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-subtitle">{t("header.subtitle")}</p>
      </div>
      {action}
    </section>
  );
}

/** The People-tab dropdown: a button trigger and a checkmarked list. */
export function ModernSelect({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  block = false,
  active = false,
  prefix,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
  disabled?: boolean;
  /** Fill the parent field instead of staying a compact filter. */
  block?: boolean;
  /** Filled trigger, used when a table filter is narrowed. */
  active?: boolean;
  prefix?: string;
}) {
  return (
    <Select.Root
      items={options}
      value={value}
      modal={false}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <Select.Trigger
        className={`modern-select${active ? " is-active" : ""}${block ? " is-block" : ""}`}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        {prefix && <span className="modern-select-prefix">{prefix}</span>}
        <Select.Value className="modern-select-value" />
        <Select.Icon className="modern-select-icon">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="modern-select-positioner"
          sideOffset={6}
          align="start"
          alignItemWithTrigger={false}
        >
          <Select.Popup className="modern-select-popup">
            <Select.List className="modern-select-list">
              {options.map((option, index) => (
                <Select.Item
                  key={`${option.value}-${index}`}
                  value={option.value}
                  className="modern-select-item"
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="modern-select-check">
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/** Dropdown used by the table filters; "All" is the cleared state. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const active = value !== "All";
  return (
    <ModernSelect
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={label}
      active={active}
      prefix={active ? label : undefined}
    />
  );
}

export function FilterBar({
  search,
  setSearch,
  filters,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  onReset,
}: {
  search: string;
  setSearch: (value: string) => void;
  filters: {
    value: string;
    setValue: (value: string) => void;
    options: string[];
    label?: string;
    optionLabel?: (option: string) => string;
  }[];
  startDate?: string;
  setStartDate?: (value: string) => void;
  endDate?: string;
  setEndDate?: (value: string) => void;
  onReset?: () => void;
}) {
  const t = useT();
  const filterLabel = (label?: string) => {
    if (label === "Status") return t("filter.status");
    if (label === "Leave type") return t("filter.leaveType");
    if (label === "Department") return t("filter.department");
    return label;
  };
  return (
    <div className="filter-bar">
      <div className="search-field">
        <Search size={15} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("filter.search")}
        />
      </div>
      {filters.map((filter, index) => (
        <FilterSelect
          key={index}
          label={filterLabel(filter.label)}
          value={filter.value}
          onChange={filter.setValue}
          options={filter.options.map((option) => ({
            value: option,
            label: filter.optionLabel
              ? filter.optionLabel(option)
              : filter.label === "Leave type" && option !== "All"
                ? leaveTypeLabel(t, option)
                : filterOptionLabel(t, option),
          }))}
        />
      ))}
      {setStartDate && setEndDate && (
        <DateRangePicker
          startDate={startDate ?? ""}
          endDate={endDate ?? ""}
          onStartDate={setStartDate}
          onEndDate={setEndDate}
        />
      )}
      {onReset && (
        <button type="button" className="secondary-button" onClick={onReset}>
          {t("common.reset")}
        </button>
      )}
    </div>
  );
}

export function Pagination({
  page,
  pageCount,
  total,
  start,
  end,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  start: number;
  end: number;
  onPage: (page: number) => void;
}) {
  const t = useT();
  if (total === 0) return null;

  return (
    <div className="table-pagination">
      <span>{t("pagination.range", { start, end, total })}</span>
      <div className="table-pagination-pages">
        <button
          type="button"
          aria-label={t("pagination.previous")}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        {pageNumbers(page, pageCount).map((item, index) =>
          item === "ellipsis" ? (
            <span key={`ellipsis-${index}`}>…</span>
          ) : (
            <button
              type="button"
              key={item}
              className={item === page ? "is-current" : undefined}
              onClick={() => onPage(item)}
            >
              {item}
            </button>
          ),
        )}
        <button
          type="button"
          aria-label={t("pagination.next")}
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
