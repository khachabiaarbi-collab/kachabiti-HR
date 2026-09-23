"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { isoDate, mondayOf } from "@/lib/map-rows";

function parseIso(iso: string) {
  return new Date(`${iso}T00:00:00`);
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthCells(month: Date) {
  const first = startOfMonth(month);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, index) => {
      return new Date(first.getFullYear(), first.getMonth(), index + 1);
    }),
  ];
}

function inInclusiveRange(iso: string, start: string, end: string) {
  if (!start || !end) return false;
  const from = start < end ? start : end;
  const to = start < end ? end : start;
  return iso >= from && iso <= to;
}

function formatSingleLabel(value: string, placeholder: string, locale: string) {
  if (!value) return placeholder;
  return parseIso(value).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatRangeLabel(
  start: string,
  end: string,
  locale: string,
  emptyLabel: string,
) {
  if (!start && !end) return emptyLabel;
  const monthDay: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (start && !end) {
    return `${parseIso(start).toLocaleDateString(locale, monthDay)} – …`;
  }
  if (!start && end) {
    return `… – ${parseIso(end).toLocaleDateString(locale, monthDay)}`;
  }
  if (start === end) {
    return parseIso(start).toLocaleDateString(locale, {
      ...monthDay,
      year: "numeric",
    });
  }
  const from = parseIso(start);
  const to = parseIso(end);
  const sameYear = from.getFullYear() === to.getFullYear();
  return `${from.toLocaleDateString(locale, sameYear ? monthDay : { ...monthDay, year: "numeric" })} – ${to.toLocaleDateString(locale, { ...monthDay, year: "numeric" })}`;
}

function presetRange(kind: "week" | "month" | "30") {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (kind === "week") {
    const start = mondayOf(today);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: isoDate(start), end: isoDate(end) };
  }
  if (kind === "month") {
    const start = startOfMonth(today);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return { start: isoDate(start), end: isoDate(end) };
  }
  const start = new Date(today);
  start.setDate(today.getDate() - 29);
  return { start: isoDate(start), end: isoDate(today) };
}

function isDisabledDay(iso: string, min?: string, max?: string) {
  if (min && iso < min) return true;
  if (max && iso > max) return true;
  return false;
}

function DatePickerPopover({
  open,
  triggerRef,
  popoverRef,
  align,
  viewMonth,
  setViewMonth,
  startDate,
  endDate,
  hoverDate,
  setHoverDate,
  onSelectDay,
  onPreset,
  onClear,
  min,
  max,
  showPresets,
  label,
  hasValue,
}: {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  align: "start" | "end";
  viewMonth: Date;
  setViewMonth: (updater: (month: Date) => Date) => void;
  startDate: string;
  endDate: string;
  hoverDate: string;
  setHoverDate: (value: string) => void;
  onSelectDay: (iso: string) => void;
  onPreset?: (kind: "week" | "month" | "30") => void;
  onClear: () => void;
  min?: string;
  max?: string;
  showPresets: boolean;
  label: string;
  hasValue: boolean;
}) {
  const { t, dateLocale } = useLanguage();
  const [style, setStyle] = useState<React.CSSProperties>({});
  const months = useMemo(() => [viewMonth, addMonths(viewMonth, 1)], [viewMonth]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(560, window.innerWidth - 16);
      const height = Math.min(460, window.innerHeight - 16);
      const left =
        align === "end"
          ? Math.min(
              Math.max(8, rect.right - width),
              window.innerWidth - width - 8,
            )
          : Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      const below = rect.bottom + 8;
      const top =
        below + height > window.innerHeight - 8 && rect.top > height + 8
          ? Math.max(8, rect.top - height - 8)
          : Math.min(below, window.innerHeight - height - 8);
      setStyle({
        position: "fixed",
        top,
        left,
        width,
        zIndex: 80,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [align, open, triggerRef, viewMonth]);

  if (!open || typeof document === "undefined") return null;

  const previewEnd = !endDate && startDate ? hoverDate : "";

  return createPortal(
    <div
      className="range-picker-popover"
      ref={popoverRef}
      role="dialog"
      aria-label={t("date.choose")}
      style={style}
    >
      {showPresets && onPreset ? (
        <div className="range-picker-presets">
          <button type="button" onClick={() => onPreset("week")}>
            {t("date.thisWeek")}
          </button>
          <button type="button" onClick={() => onPreset("month")}>
            {t("date.thisMonth")}
          </button>
          <button type="button" onClick={() => onPreset("30")}>
            {t("date.last30")}
          </button>
        </div>
      ) : null}
      <div className="range-picker-nav">
        <button
          type="button"
          aria-label={t("cal.prevMonth")}
          onClick={() => setViewMonth((month) => addMonths(month, -1))}
        >
          <ChevronLeft size={16} />
        </button>
        <div>
          {months.map((month) => (
            <strong key={month.toISOString()}>
              {month.toLocaleDateString(dateLocale, {
                month: "long",
                year: "numeric",
              })}
            </strong>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("cal.nextMonth")}
          onClick={() => setViewMonth((month) => addMonths(month, 1))}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="range-picker-months">
        {months.map((month) => (
          <div className="range-picker-month" key={month.toISOString()}>
            <div className="range-picker-weekdays">
              {(["cal.mo", "cal.tu", "cal.we", "cal.th", "cal.fr", "cal.sa", "cal.su"] as const).map((day) => (
                <span key={day}>{t(day)}</span>
              ))}
            </div>
            <div className="range-picker-grid">
              {monthCells(month).map((date, index) => {
                if (!date) {
                  return <span key={`empty-${index}`} />;
                }
                const iso = isoDate(date);
                const rangeEnd = endDate || previewEnd;
                const selected = iso === startDate || iso === endDate;
                const hasSpan = Boolean(
                  startDate && rangeEnd && startDate !== rangeEnd,
                );
                const inRange =
                  hasSpan && inInclusiveRange(iso, startDate, rangeEnd);
                const rangeStart =
                  hasSpan && startDate
                    ? rangeEnd < startDate
                      ? rangeEnd
                      : startDate
                    : "";
                const rangeStop =
                  hasSpan && startDate
                    ? rangeEnd > startDate
                      ? rangeEnd
                      : startDate
                    : "";
                const isStart = iso === rangeStart;
                const isEnd = iso === rangeStop;
                const today = iso === isoDate();
                const disabled = isDisabledDay(iso, min, max);
                return (
                  <span
                    key={iso}
                    className={[
                      "range-day",
                      inRange ? "is-in-range" : "",
                      isStart ? "is-start" : "",
                      isEnd ? "is-end" : "",
                      selected ? "is-selected" : "",
                      today ? "is-today" : "",
                      disabled ? "is-disabled" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onMouseEnter={() => setHoverDate(iso)}
                      onMouseLeave={() => setHoverDate("")}
                      onClick={() => onSelectDay(iso)}
                    >
                      {date.getDate()}
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="range-picker-footer">
        <small>{label}</small>
        <button type="button" onClick={onClear} disabled={!hasValue}>
          {t("date.clear")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function usePickerOpen(
  triggerRef: React.RefObject<HTMLElement | null>,
  popoverRef: React.RefObject<HTMLDivElement | null>,
) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, popoverRef, triggerRef]);

  return { open, setOpen };
}

export function DatePicker({
  value,
  onChange,
  name,
  min,
  max,
  readOnly = false,
  placeholder,
}: {
  value?: string;
  onChange?: (value: string) => void;
  name?: string;
  min?: string;
  max?: string;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const { t, dateLocale } = useLanguage();
  const resolvedPlaceholder = placeholder ?? t("date.selectDate");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [inner, setInner] = useState(value ?? "");
  const current = onChange ? (value ?? "") : inner;
  const setValue = onChange ?? setInner;
  const { open, setOpen } = usePickerOpen(triggerRef, popoverRef);
  const [hoverDate, setHoverDate] = useState("");
  const [viewMonth, setViewMonth] = useState(() =>
    startOfMonth(current ? parseIso(current) : new Date()),
  );

  useEffect(() => {
    if (!open) return;
    setViewMonth(startOfMonth(current ? parseIso(current) : new Date()));
  }, [current, open]);

  const selectDay = (iso: string) => {
    if (isDisabledDay(iso, min, max)) return;
    setValue(iso);
    setOpen(false);
    setHoverDate("");
  };

  return (
    <div className="range-picker range-picker-field">
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <button
        ref={triggerRef}
        type="button"
        className={`range-picker-trigger${open ? " is-open" : ""}${current ? " has-value" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={readOnly}
        onClick={() => {
          if (!readOnly) setOpen((next) => !next);
        }}
      >
        <CalendarDays size={14} />
        <span>{formatSingleLabel(current, resolvedPlaceholder, dateLocale)}</span>
        {current && !readOnly ? (
          <span
            className="range-picker-clear"
            role="button"
            aria-label={t("date.clearDate")}
            onClick={(event) => {
              event.stopPropagation();
              setValue("");
            }}
          >
            <X size={12} />
          </span>
        ) : null}
      </button>
      <DatePickerPopover
        open={open && !readOnly}
        triggerRef={triggerRef}
        popoverRef={popoverRef}
        align="start"
        viewMonth={viewMonth}
        setViewMonth={setViewMonth}
        startDate={current}
        endDate={current}
        hoverDate={hoverDate}
        setHoverDate={setHoverDate}
        onSelectDay={selectDay}
        onClear={() => {
          setValue("");
          setHoverDate("");
        }}
        min={min}
        max={max}
        showPresets={false}
        label={formatSingleLabel(current, resolvedPlaceholder, dateLocale)}
        hasValue={Boolean(current)}
      />
    </div>
  );
}

export function DateRangePicker({
  startDate,
  endDate,
  onStartDate,
  onEndDate,
  min,
  max,
}: {
  startDate: string;
  endDate: string;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
  min?: string;
  max?: string;
}) {
  const { t, dateLocale } = useLanguage();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { open, setOpen } = usePickerOpen(triggerRef, popoverRef);
  const [hoverDate, setHoverDate] = useState("");
  const [viewMonth, setViewMonth] = useState(() =>
    startOfMonth(startDate ? parseIso(startDate) : new Date()),
  );
  const hasValue = Boolean(startDate || endDate);

  useEffect(() => {
    if (!open) return;
    setViewMonth(startOfMonth(startDate ? parseIso(startDate) : new Date()));
  }, [open, startDate]);

  const selectDay = (iso: string) => {
    if (isDisabledDay(iso, min, max)) return;
    if (!startDate || (startDate && endDate)) {
      onStartDate(iso);
      onEndDate("");
      return;
    }
    if (iso < startDate) {
      onEndDate(startDate);
      onStartDate(iso);
      return;
    }
    onEndDate(iso);
  };

  const applyPreset = (kind: "week" | "month" | "30") => {
    const range = presetRange(kind);
    onStartDate(range.start);
    onEndDate(range.end);
    setViewMonth(startOfMonth(parseIso(range.start)));
    setHoverDate("");
  };

  const clearRange = () => {
    onStartDate("");
    onEndDate("");
    setHoverDate("");
  };

  return (
    <div className="range-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`range-picker-trigger${open ? " is-open" : ""}${hasValue ? " has-value" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((next) => !next)}
      >
        <CalendarDays size={14} />
        <span>{formatRangeLabel(startDate, endDate, dateLocale, t("date.selectDates"))}</span>
        {hasValue ? (
          <span
            className="range-picker-clear"
            role="button"
            aria-label={t("date.clearDates")}
            onClick={(event) => {
              event.stopPropagation();
              clearRange();
            }}
          >
            <X size={12} />
          </span>
        ) : null}
      </button>
      <DatePickerPopover
        open={open}
        triggerRef={triggerRef}
        popoverRef={popoverRef}
        align="end"
        viewMonth={viewMonth}
        setViewMonth={setViewMonth}
        startDate={startDate}
        endDate={endDate}
        hoverDate={hoverDate}
        setHoverDate={setHoverDate}
        onSelectDay={selectDay}
        onPreset={applyPreset}
        onClear={clearRange}
        min={min}
        max={max}
        showPresets
        label={formatRangeLabel(startDate, endDate, dateLocale, t("date.selectDates"))}
        hasValue={hasValue}
      />
    </div>
  );
}
