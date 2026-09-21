import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { Employee } from "@/lib/app-types";
import { DatePicker, DateRangePicker } from "@/components/date-range-picker";
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

const LOGO_SRC =
  "https://hebbkx1anhila5yf.public.blob.vercel-storage.com/469362479_122124207824423950_2630084246229930837_n%20%281%29-dMJX1LqphsKk0byhJm634qPx7gW1Mb.jpg";

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
  return (
    <div className={`brand-logo ${dark ? "dark-logo" : ""}`}>
      <img className="brand-logo-image" src={LOGO_SRC} alt="Kachabiti logo" />
      <b>kachabiti HR</b>
    </div>
  );
}

export function Status({ status }: { status: string }) {
  const tone =
    status === "Pending"
      ? "status-pending"
      : status === "Approved" || status === "Active"
        ? "status-approved"
        : "status-declined";
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

export function LeaveTypeLabel({ type }: { type: string }) {
  return (
    <span className={`status-pill type-pill ${leaveTypeTone(type)}`}>
      {type}
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
}: {
  children: React.ReactNode;
  onClick?: () => void;
  secondary?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={secondary ? "secondary-button" : "primary-button"}
      onClick={onClick}
    >
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
}) {
  if (type === "date") {
    return (
      <label className="form-label">
        {label}
        <DatePicker
          name={name}
          value={onChange || readOnly ? value : undefined}
          min={min}
          max={max}
          readOnly={readOnly}
          onChange={onChange}
        />
      </label>
    );
  }

  return (
    <label className="form-label">
      {label}
      <input
        type={type}
        name={name}
        step={step}
        min={min}
        max={max}
        autoComplete="off"
        readOnly={readOnly}
        {...(onChange
          ? { value: value ?? "", onChange: (e) => onChange(e.target.value) }
          : readOnly
            ? { value: value ?? "" }
            : { defaultValue: value })}
      />
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
  return (
    <div className="request-tabs" role="tablist" aria-label="Request type">
      <button
        type="button"
        role="tab"
        aria-selected={value === "leaves"}
        className={value === "leaves" ? "is-active" : undefined}
        onClick={() => onChange("leaves")}
      >
        Leaves
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === "authorizations"}
        className={value === "authorizations" ? "is-active" : undefined}
        onClick={() => onChange("authorizations")}
      >
        Authorizations
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
  return (
    <section className="welcome-row compact">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-subtitle">
          Keep your team, time off, and policies in one place.
        </p>
      </div>
      {action}
    </section>
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
  }[];
  startDate?: string;
  setStartDate?: (value: string) => void;
  endDate?: string;
  setEndDate?: (value: string) => void;
  onReset?: () => void;
}) {
  return (
    <div className="filter-bar">
      <div className="search-field">
        <Search size={15} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
        />
      </div>
      {filters.map((filter, index) => (
        <select
          key={index}
          className="filter-select"
          aria-label={filter.label}
          value={filter.value}
          onChange={(e) => filter.setValue(e.target.value)}
        >
          {filter.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
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
          Reset
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
  if (total === 0) return null;

  return (
    <div className="table-pagination">
      <span>
        {start}–{end} of {total}
      </span>
      <div className="table-pagination-pages">
        <button
          type="button"
          aria-label="Previous page"
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
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
