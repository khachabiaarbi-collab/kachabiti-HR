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
import { Avatar, Logo } from "@/components/primitives";
import { isoDate } from "@/lib/map-rows";
import { createClient } from "@/lib/supabase/client";

const guestAvatar = { initials: "?", color: "avatar-slate" };

const adminNav = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Leave requests", icon: FileText },
  { label: "Team calendar", icon: CalendarDays },
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
  return (
    <aside className="sidebar admin-sidebar">
      <div className="sidebar-top">
        <Logo />
        <button className="icon-button mobile-menu">
          <Menu size={19} />
        </button>
      </div>
      <div className="mode-badge">
        <ShieldCheck size={14} /> Admin workspace
      </div>
      <div className="workspace-switcher">
        <div className="workspace-icon">K</div>
        <div>
          <p className="workspace-name">Kachabiti HR</p>
          <p className="workspace-subtitle">Company workspace</p>
        </div>
        {/* <ChevronDown size={15} className="ml-auto" /> */}
      </div>
      <nav className="nav-list">
        <p className="nav-label">Manage</p>
        {adminNav.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              className={`nav-item ${active === item.label ? "nav-item-active" : ""}`}
              onClick={() => setActive(item.label)}
            >
              <Icon size={18} />
              <span>{item.label}</span>
              {item.label === "Leave requests" && (
                <span className="nav-count">{requests.length}</span>
              )}
            </button>
          );
        })}
        <p className="nav-label nav-label-spaced">Workspace</p>
        <button
          className={`nav-item ${active === "Settings" ? "nav-item-active" : ""}`}
          onClick={() => setActive("Settings")}
        >
          <Settings size={18} />
          Settings
        </button>
      </nav>
      <div className="sidebar-bottom">
        <div className="upgrade-card">
          <Activity size={16} />
          <div>
            <p className="upgrade-title">Live workspace</p>
            <p className="upgrade-copy">Everything is in sync.</p>
          </div>
        </div>
        <div className="user-row">
          <Avatar e={currentEmployee ?? guestAvatar} small />
          <div>
            <p className="user-name">{currentEmployee?.name ?? "…"}</p>
            <p className="user-role">{currentEmployee?.role ?? "Admin"}</p>
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
  return (
    <div className="employee-nav">
      <Logo />
      <nav>
        {["Overview", "My requests", "Calendar", "My profile"].map((item) => (
          <button
            key={item}
            className={active === item ? "active" : ""}
            onClick={() => setActive(item)}
          >
            {item}
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
          aria-label="Search people and requests"
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
          placeholder="Search people, requests..."
          aria-label="Search people and requests"
        />
        {globalSearch && (
          <button
            type="button"
            className="global-search-clear"
            aria-label="Clear search"
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
                <b>Employees</b>
                {peopleHits.length === 0 ? (
                  <span className="search-empty">No matching people</span>
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
            <b>Requests</b>
            {requestHits.length === 0 ? (
              <span className="search-empty">No matching requests</span>
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
                      {request.name} · {request.status}
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
          aria-label="Notifications"
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
      <span className="mode-badge light">{role} mode</span>
      <div className="account-wrap">
        <button
          type="button"
          className="top-avatar"
          aria-label="Account menu"
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
              <p>{currentEmployee?.name ?? "Account"}</p>
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
              {settingsLabel}
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
              Log out
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
    { label: "Today", items: today },
    { label: "Earlier", items: earlier },
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
        <b>Notifications</b>
        {(unreadIds.length > 0 || canUnreadNew) && (
          <button type="button" onClick={markAll}>
            {canUnreadNew ? "Mark as unread" : "Mark all as read"}
          </button>
        )}
      </div>
      {notices.length === 0 ? (
        <p className="notification-group">No notifications yet</p>
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
                  <p>{notice.text}</p>
                  <small>{notice.time}</small>
                </div>
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
