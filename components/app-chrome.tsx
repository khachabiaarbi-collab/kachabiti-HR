"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bell,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
  Building2,
  CalendarDays,
} from "lucide-react";
import type { Employee, LeaveRequest, Notice, Role } from "@/lib/app-types";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Avatar, Logo } from "@/components/primitives";
import {
  formatRelativeTime,
  screenLabel,
  translateNotice,
  translateRole,
  translateStatus,
  useLanguage,
} from "@/lib/i18n";
import { isoDate } from "@/lib/map-rows";
import { createClient } from "@/lib/supabase/client";

const guestAvatar = { initials: "?", color: "avatar-slate" };

const adminNav = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Leave requests", icon: FileText },
  { label: "Team calendar", icon: CalendarDays },
  { label: "Attendance", icon: Clock3 },
  { label: "People", icon: Users },
  { label: "Departments", icon: Building2 },
  { label: "Analytics", icon: Activity },
];

export function Sidebar({
  active,
  setActive,
  logout,
  currentEmployee,
  requests = [],
}: {
  active: string;
  setActive: (label: string) => void;
  logout: () => void;
  currentEmployee: Employee | null;
  requests?: LeaveRequest[];
}) {
  const t = useLanguage().t;
  return (
    <aside className="sidebar admin-sidebar">
      <div className="sidebar-top">
        <Logo />
        <button className="icon-button mobile-menu">
          <Menu size={19} />
        </button>
      </div>
      <div className="mode-badge">
        <ShieldCheck size={14} /> {t("chrome.adminWorkspace")}
      </div>
      <div className="workspace-switcher">
        <div className="workspace-icon">K</div>
        <div>
          <p className="workspace-name">{t("chrome.workspaceName")}</p>
          <p className="workspace-subtitle">{t("chrome.workspaceSubtitle")}</p>
        </div>
        {/* <ChevronDown size={15} className="ml-auto" /> */}
      </div>
      <nav className="nav-list">
        <p className="nav-label">{t("nav.manage")}</p>
        {adminNav.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              className={`nav-item ${active === item.label ? "nav-item-active" : ""}`}
              onClick={() => setActive(item.label)}
            >
              <Icon size={18} />
              <span>{screenLabel(t, item.label)}</span>
              {item.label === "Leave requests" && (
                <span className="nav-count">{requests.length}</span>
              )}
            </button>
          );
        })}
        <p className="nav-label nav-label-spaced">{t("nav.workspace")}</p>
        <button
          className={`nav-item ${active === "Settings" ? "nav-item-active" : ""}`}
          onClick={() => setActive("Settings")}
        >
          <Settings size={18} />
          {t("nav.settings")}
        </button>
      </nav>
      <div className="sidebar-bottom">
        <div className="upgrade-card">
          <Activity size={16} />
          <div>
            <p className="upgrade-title">{t("chrome.liveWorkspace")}</p>
            <p className="upgrade-copy">{t("chrome.liveCopy")}</p>
          </div>
        </div>
        <div className="user-row">
          <Avatar e={currentEmployee ?? guestAvatar} small />
          <div>
            <p className="user-name">{currentEmployee?.name ?? "…"}</p>
            <p className="user-role">
              {translateRole(t, currentEmployee?.role ?? "Admin")}
            </p>
          </div>
          <button className="logout-icon" onClick={logout}>
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

export function EmployeeNav({
  active,
  setActive,
  children,
}: {
  active: string;
  setActive: (label: string) => void;
  children?: ReactNode;
}) {
  const t = useLanguage().t;
  return (
    <div className="employee-nav">
      <Logo />
      <nav>
        {["Overview", "Time clock", "My requests", "Calendar", "My profile"].map((item) => (
          <button
            key={item}
            className={active === item ? "active" : ""}
            onClick={() => setActive(item)}
          >
            {screenLabel(t, item)}
          </button>
        ))}
      </nav>
      <div className="employee-nav-actions">{children}</div>
    </div>
  );
}

export function TopActions({
  role,
  logout,
  setActive,
  notices,
  setNotices,
  showNotices,
  setShowNotices,
  globalSearch,
  setGlobalSearch,
  currentEmployee,
  employees = [],
  requests = [],
  onOpenNotice,
  onOpenRequest,
}: {
  role: Role;
  logout: () => void;
  setActive: (label: string) => void;
  notices: Notice[];
  setNotices: (notices: Notice[]) => void;
  showNotices: boolean;
  setShowNotices: (value: boolean) => void;
  globalSearch: string;
  setGlobalSearch: (value: string) => void;
  currentEmployee: Employee | null;
  employees?: Employee[];
  requests?: LeaveRequest[];
  onOpenNotice?: (notice: Notice) => void;
  onOpenRequest?: (request: LeaveRequest) => void;
}) {
  const { t, dateLocale } = useLanguage();
  const [showAccount, setShowAccount] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const unread = notices.filter((notice) => !notice.read).length;
  const settingsLabel = role === "Employee" ? "My profile" : "Settings";

  useEffect(() => {
    if (!showAccount && !showNotices && !showSearch) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (showNotices && !target.closest(".notification-wrap")) {
        setShowNotices(false);
      }
      if (showAccount && !target.closest(".account-wrap")) {
        setShowAccount(false);
      }
      if (showSearch && !searchRef.current?.contains(target)) {
        setShowSearch(false);
        setGlobalSearch("");
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShowAccount(false);
      setShowNotices(false);
      setShowSearch(false);
      setGlobalSearch("");
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [
    setGlobalSearch,
    setShowNotices,
    showAccount,
    showNotices,
    showSearch,
  ]);

  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  const q = globalSearch.trim().toLowerCase();
  const peopleHits = (role === "Employee" ? [] : employees)
    .filter((employee) =>
      (employee.name + employee.email + employee.department + (employee.jobTitle ?? ""))
        .toLowerCase()
        .includes(q),
    )
    .slice(0, 4);
  const searchableRequests =
    role === "Employee" && currentEmployee
      ? requests.filter((request) => request.employeeId === currentEmployee.id)
      : requests;
  const requestHits = searchableRequests
    .filter((request) =>
      (request.name + request.type + request.status).toLowerCase().includes(q),
    )
    .slice(0, 4);

  return (
    <div className="topbar-actions">
      <div
        ref={searchRef}
        className={`global-search ${showSearch || globalSearch ? "expanded" : ""}`}
      >
        <button
          type="button"
          className="global-search-trigger"
          aria-label={t("search.aria")}
          aria-expanded={showSearch}
          onClick={() => {
            setShowAccount(false);
            setShowNotices(false);
            setShowSearch(true);
          }}
        >
          <Search size={16} />
        </button>
        <input
          ref={searchInputRef}
          value={globalSearch}
          onChange={(e) => setGlobalSearch(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.aria")}
        />
        {globalSearch && (
          <button
            type="button"
            className="global-search-clear"
            aria-label={t("search.clear")}
            onClick={() => {
              setGlobalSearch("");
              searchInputRef.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
        {showSearch && q && (
          <div className="search-results">
            {role !== "Employee" && (
              <>
                <b>{t("search.employees")}</b>
                {peopleHits.length === 0 ? (
                  <span className="search-empty">{t("search.noPeople")}</span>
                ) : (
                  peopleHits.map((employee) => (
                    <button
                      type="button"
                      key={employee.id}
                      onClick={() => {
                        setGlobalSearch(employee.name);
                        setShowSearch(false);
                        setActive("People");
                      }}
                    >
                      <Users size={14} />
                      <span>
                        <strong>{employee.name}</strong>
                        <small>{employee.department}</small>
                      </span>
                    </button>
                  ))
                )}
              </>
            )}
            <b>{t("search.requests")}</b>
            {requestHits.length === 0 ? (
              <span className="search-empty">{t("search.noRequests")}</span>
            ) : (
              requestHits.map((request) => (
                <button
                  type="button"
                  key={request.id}
                  onClick={() => {
                    setGlobalSearch("");
                    setShowSearch(false);
                    if (onOpenRequest) {
                      onOpenRequest(request);
                    } else {
                      setActive(
                        role === "Employee" ? "My requests" : "Leave requests",
                      );
                    }
                  }}
                >
                  <FileText size={14} />
                  <span>
                    <strong>{request.type}</strong>
                    <small>
                      {t("search.requestMeta", {
                        name: request.name,
                        status: translateStatus(t, request.status),
                      })}
                    </small>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <div className="notification-wrap">
        <button
          type="button"
          className="icon-button notification-button"
          aria-label={t("notices.title")}
          aria-haspopup="true"
          aria-expanded={showNotices}
          onClick={() => {
            setShowAccount(false);
            setShowNotices(!showNotices);
          }}
        >
          <Bell size={18} />
          {unread > 0 && <span>{unread}</span>}
        </button>
        {showNotices && (
          <NotificationPanel
            notices={notices}
            setNotices={setNotices}
            onOpenNotice={onOpenNotice}
          />
        )}
      </div>
      <LanguageSwitcher compact />
      <span className="mode-badge light">
        {t("chrome.mode", { role: translateRole(t, role) })}
      </span>
      <div className="account-wrap">
        <button
          type="button"
          className="top-avatar"
          aria-label={t("chrome.accountMenu")}
          aria-haspopup="menu"
          aria-expanded={showAccount}
          onClick={() => {
            setShowNotices(false);
            setShowAccount((open) => !open);
          }}
        >
          {currentEmployee?.avatarUrl ? (
            <img src={currentEmployee.avatarUrl} alt="" />
          ) : (
            (currentEmployee?.initials ?? "?")
          )}
        </button>
        {showAccount && (
          <div className="account-menu" role="menu">
            <div className="account-menu-head">
              <p>{currentEmployee?.name ?? t("chrome.account")}</p>
              <span>{currentEmployee?.email ?? ""}</span>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setShowAccount(false);
                setActive(settingsLabel);
              }}
            >
              <Settings size={16} />
              {screenLabel(t, settingsLabel)}
            </button>
            <button
              type="button"
              role="menuitem"
              className="account-logout"
              onClick={() => {
                setShowAccount(false);
                logout();
              }}
            >
              <LogOut size={16} />
              {t("chrome.logOut")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function noticeIsToday(notice: Notice) {
  if (!notice.createdAt) return false;
  return isoDate(new Date(notice.createdAt)) === isoDate();
}

function NotificationPanel({
  notices,
  setNotices,
  onOpenNotice,
}: {
  notices: Notice[];
  setNotices: (notices: Notice[]) => void;
  onOpenNotice?: (notice: Notice) => void;
}) {
  const { t, dateLocale } = useLanguage();
  const [justReadIds, setJustReadIds] = useState<string[]>([]);
  const icon = {
    approved: <Check />,
    rejected: <X />,
    pending: <Clock3 />,
    reminder: <Bell />,
  };
  const today = notices.filter(noticeIsToday);
  const earlier = notices.filter((notice) => !noticeIsToday(notice));
  const groups = [
    { label: t("notices.today"), items: today },
    { label: t("notices.earlier"), items: earlier },
  ].filter((group) => group.items.length > 0);

  const unreadIds = notices
    .filter((notice) => !notice.read)
    .map((notice) => notice.id);
  const canUnreadNew = unreadIds.length === 0 && justReadIds.length > 0;

  const setRead = async (ids: string[], read: boolean) => {
    if (ids.length === 0) return;
    setNotices(
      notices.map((notice) =>
        ids.includes(notice.id) ? { ...notice, read } : notice,
      ),
    );
    const supabase = createClient();
    await supabase.from("notifications").update({ read }).in("id", ids);
  };

  const markAll = () => {
    if (canUnreadNew) {
      const ids = justReadIds.filter((id) =>
        notices.some((notice) => notice.id === id),
      );
      setJustReadIds([]);
      void setRead(ids, false);
      return;
    }
    setJustReadIds(unreadIds);
    void setRead(unreadIds, true);
  };

  const openItem = async (notice: Notice) => {
    if (!notice.read) {
      setJustReadIds((ids) => ids.filter((id) => id !== notice.id));
      await setRead([notice.id], true);
    }
    onOpenNotice?.(notice);
  };

  return (
    <div className="notification-panel">
      <div className="notification-head">
        <b>{t("notices.title")}</b>
        {(unreadIds.length > 0 || canUnreadNew) && (
          <button type="button" onClick={markAll}>
            {canUnreadNew ? t("notices.markUnread") : t("notices.markAllRead")}
          </button>
        )}
      </div>
      {notices.length === 0 ? (
        <p className="notification-group">{t("notices.empty")}</p>
      ) : (
        groups.map((group) => (
          <div key={group.label}>
            <p className="notification-group">{group.label}</p>
            {group.items.map((notice) => (
              <button
                type="button"
                className={`notification-item ${notice.read ? "read" : ""}`}
                key={notice.id}
                onClick={() => openItem(notice)}
              >
                <span className={`notice-icon ${notice.kind}`}>
                  {icon[notice.kind]}
                </span>
                <div>
                  <p>{translateNotice(t, notice.text, notice.kind)}</p>
                  <small>
                    {notice.createdAt
                      ? formatRelativeTime(t, notice.createdAt, dateLocale)
                      : notice.time}
                  </small>
                </div>
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
