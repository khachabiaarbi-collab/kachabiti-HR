"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { en, fr, type MessageKey } from "@/lib/messages";

export type Locale = "en" | "fr";

const STORAGE_KEY = "kachabiti-locale";
const dictionaries = { en, fr } as const;

type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

type LanguageContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
  dateLocale: string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] == null ? "" : String(vars[name]),
  );
}

function persistLocale(next: Locale) {
  window.localStorage.setItem(STORAGE_KEY, next);
  document.cookie = `${STORAGE_KEY}=${next}; path=/; max-age=31536000; SameSite=Lax`;
}

export function LanguageProvider({
  children,
  initialLocale = "en",
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    initialLocale === "fr" ? "fr" : "en",
  );

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "fr" || stored === "en") {
      if (stored !== locale) setLocaleState(stored);
      persistLocale(stored);
      return;
    }
    persistLocale(locale);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    persistLocale(next);
  };

  const value = useMemo<LanguageContextValue>(() => {
    const dict = dictionaries[locale];
    return {
      locale,
      setLocale,
      dateLocale: locale === "fr" ? "fr-FR" : "en-US",
      t: (key, vars) => interpolate(dict[key] ?? en[key] ?? key, vars),
    };
  }, [locale]);

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return value;
}

export function useT() {
  return useLanguage().t;
}

export function translateStatus(t: Translate, status: string) {
  const value = status.toLowerCase();
  if (value === "pending") return t("status.pending");
  if (value === "approved") return t("status.approved");
  if (value === "rejected") return t("status.rejected");
  if (value === "active") return t("status.active");
  if (value === "inactive") return t("status.inactive");
  return status;
}

export function translateRole(t: Translate, role: string) {
  const value = role.toLowerCase();
  if (value === "admin" || value === "administrator") return t("role.administrator");
  if (value === "manager") return t("role.manager");
  if (value === "employee") return t("role.employee");
  return role;
}

export function screenLabel(t: Translate, label: string) {
  const labels: Record<string, MessageKey> = {
    Overview: "nav.overview",
    "Time clock": "nav.timeClock",
    "My requests": "nav.myRequests",
    Calendar: "nav.calendar",
    "My profile": "nav.myProfile",
    "Leave requests": "nav.leaveRequests",
    "Team calendar": "nav.teamCalendar",
    Attendance: "nav.attendance",
    People: "nav.people",
    Departments: "nav.departments",
    Analytics: "nav.analytics",
    Settings: "nav.settings",
  };
  const key = labels[label];
  return key ? t(key) : label;
}

export function filterOptionLabel(t: Translate, option: string) {
  if (option === "All") return t("common.all");
  if (option === "Unassigned") return t("department.unassigned");
  return translateStatus(t, option);
}

export function formatDaysLabel(t: Translate, count: number) {
  return count === 1 ? t("common.oneDay") : t("common.daysCount", { count });
}

export function formatRelativeTime(
  t: Translate,
  iso: string,
  dateLocale: string,
) {
  const then = new Date(iso).getTime();
  const delta = Math.round((Date.now() - then) / 1000);
  if (Number.isNaN(then) || delta < 45) return t("time.justNow");
  const minutes = Math.round(delta / 60);
  if (minutes < 60) return t("time.minAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return hours === 1
      ? t("time.hourAgo")
      : t("time.hoursAgo", { count: hours });
  }
  const days = Math.round(hours / 24);
  if (days === 1) return t("time.yesterday");
  if (days < 7) return t("time.daysAgo", { count: days });
  return new Date(iso).toLocaleDateString(dateLocale, {
    month: "short",
    day: "numeric",
  });
}

export function translateNotice(
  t: Translate,
  text: string,
  kind: string,
) {
  const status =
    kind === "approved"
      ? t("status.approved").toLowerCase()
      : kind === "rejected"
        ? t("status.rejected").toLowerCase()
        : t("status.pending").toLowerCase();

  const leaveSelf = text.match(
    /^Your leave request \((.+)\) was submitted for approval\.$/,
  );
  if (leaveSelf) {
    return t("notice.leaveSubmittedSelf", { type: leaveSelf[1] });
  }
  const leaveDecided = text.match(/^Your leave request \((.+)\) was \w+\.$/);
  if (leaveDecided) {
    return t("notice.leaveDecidedSelf", { type: leaveDecided[1], status });
  }
  const leaveStaff = text.match(
    /^(.+) submitted a leave request \((.+), (.+)\)\.$/,
  );
  if (leaveStaff) {
    return t("notice.leaveSubmittedStaff", {
      name: leaveStaff[1],
      type: leaveStaff[2],
      dates: leaveStaff[3],
    });
  }
  const authzSelfSubmit = text.match(
    /^Your authorization for (.+) was submitted for approval\.$/,
  );
  if (authzSelfSubmit) {
    return t("notice.authzSubmittedSelf", { date: authzSelfSubmit[1] });
  }
  const authzSelfDecided = text.match(/^Your authorization for (.+) was \w+\.$/);
  if (authzSelfDecided) {
    return t("notice.authzDecidedSelf", {
      date: authzSelfDecided[1],
      status,
    });
  }
  const authzStaff = text.match(/^(.+) submitted an authorization for (.+)\.$/);
  if (authzStaff) {
    return t("notice.authzSubmittedStaff", {
      name: authzStaff[1],
      date: authzStaff[2],
    });
  }
  const attSelfSubmit = text.match(
    /^Your attendance correction for (.+) was submitted for approval\.$/,
  );
  if (attSelfSubmit) {
    return t("notice.attSubmittedSelf", { date: attSelfSubmit[1] });
  }
  const attSelfDecided = text.match(
    /^Your attendance correction for (.+) was \w+\.$/,
  );
  if (attSelfDecided) {
    return t("notice.attDecidedSelf", { date: attSelfDecided[1], status });
  }
  const attStaff = text.match(
    /^(.+) submitted an attendance correction for (.+)\.$/,
  );
  if (attStaff) {
    return t("notice.attSubmittedStaff", {
      name: attStaff[1],
      date: attStaff[2],
    });
  }
  return text;
}
