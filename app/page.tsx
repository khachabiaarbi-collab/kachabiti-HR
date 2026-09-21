"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { AdminView } from "@/components/admin-views";
import { EmployeeNav, Sidebar, TopActions } from "@/components/app-chrome";
import { AuthScreen } from "@/components/auth-screen";
import { EmployeeView } from "@/components/employee-views";
import {
  DepartmentModal,
  EmployeeDetail,
  EmployeeModal,
  EventModal,
  AuthorizationModal,
  RequestModal,
} from "@/components/modals";
import { Logo } from "@/components/primitives";
import type {
  Authorization,
  CompanyEvent,
  Department,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  ModalKind,
  Notice,
  NoticeFocus,
  Role,
} from "@/lib/app-types";
import {
  mapAuthorization,
  mapDepartment,
  mapEmployee,
  mapEvent,
  mapLeaveBalance,
  mapLeaveRequest,
  mapLeaveType,
  mapNotice,
  toUiRole,
  type AuthorizationRow,
  type DepartmentRow,
  type EmployeeRow,
  type EventRow,
  type LeaveBalanceRow,
  type LeaveRequestRow,
  type LeaveTypeRow,
  type NotificationRow,
} from "@/lib/map-rows";

async function loadWorkspace() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [
    employeesRes,
    departmentsRes,
    requestsRes,
    balancesRes,
    leaveTypesRes,
    eventsRes,
    noticesRes,
    authorizationsRes,
  ] = await Promise.all([
    supabase
      .from("employees")
      .select(
        "id, full_name, email, phone, job_title, role, status, start_date, monthly_leave_days, avatar_url, department_id",
      )
      .order("full_name"),
    supabase.from("departments").select("id, name, manager_id").order("name"),
    supabase
      .from("leave_requests")
      .select(
        "id, employee_id, leave_type_id, start_date, end_date, status, reason, created_at, approver_id, attachment_path, attachment_name, employees!leave_requests_employee_id_fkey ( full_name ), leave_types ( name )",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("leave_balances")
      .select("employee_id, leave_type_id, days_remaining, leave_types ( name )"),
    supabase
      .from("leave_types")
      .select("id, name, default_days, code")
      .order("name"),
    supabase
      .from("events")
      .select("id, title, start_date, end_date, type")
      .order("start_date"),
    supabase
      .from("notifications")
      .select("id, type, message, read, created_at, user_id, leave_request_id, authorization_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("authorizations")
      .select(
        "id, employee_id, date, start_time, end_time, duration_minutes, reason, status, created_at, approver_id, employees!authorizations_employee_id_fkey ( full_name )",
      )
      .order("created_at", { ascending: false }),
  ]);

  let requestRows = (requestsRes.data ?? []) as LeaveRequestRow[];
  if (requestsRes.error) {
    const retry = await supabase
      .from("leave_requests")
      .select(
        "id, employee_id, leave_type_id, start_date, end_date, status, reason, created_at, approver_id, employees!leave_requests_employee_id_fkey ( full_name ), leave_types ( name )",
      )
      .order("created_at", { ascending: false });
    requestRows = (retry.data ?? []) as LeaveRequestRow[];
  }

  let authorizationRows = (authorizationsRes.data ?? []) as AuthorizationRow[];
  if (authorizationsRes.error) {
    const retry = await supabase
      .from("authorizations")
      .select(
        "id, employee_id, date, start_time, end_time, duration_minutes, reason, status, created_at, approver_id",
      )
      .order("created_at", { ascending: false });
    authorizationRows = (retry.data ?? []) as AuthorizationRow[];
  }

  let employeeRows = (employeesRes.data ?? []) as EmployeeRow[];
  if (employeesRes.error) {
    const retry = await supabase
      .from("employees")
      .select(
        "id, full_name, email, phone, job_title, role, status, start_date, avatar_url, department_id",
      )
      .order("full_name");
    employeeRows = (retry.data ?? []) as EmployeeRow[];
  }
  const departmentRows = (departmentsRes.data ?? []) as DepartmentRow[];
  const departmentNameById = new Map(
    departmentRows.map((row) => [row.id, row.name]),
  );
  const mappedEmployees = employeeRows.map((row) =>
    mapEmployee(
      row,
      row.department_id
        ? (departmentNameById.get(row.department_id) ?? "Unassigned")
        : "Unassigned",
    ),
  );
  const mappedDepartments = departmentRows.map((row) =>
    mapDepartment(row, mappedEmployees, employeeRows),
  );
  const departmentByEmployeeId = new Map(
    mappedEmployees.map((employee) => [employee.id, employee.department]),
  );

  return {
    employees: mappedEmployees,
    departments: mappedDepartments,
    requests: requestRows.map((row) =>
      mapLeaveRequest(
        row,
        departmentByEmployeeId.get(row.employee_id) ?? "Unassigned",
      ),
    ),
    balances: ((balancesRes.data ?? []) as LeaveBalanceRow[]).map(mapLeaveBalance),
    leaveTypes: await (async () => {
      if (!leaveTypesRes.error) {
        return ((leaveTypesRes.data ?? []) as LeaveTypeRow[]).map(mapLeaveType);
      }
      const retry = await supabase
        .from("leave_types")
        .select("id, name, default_days")
        .order("name");
      return ((retry.data ?? []) as LeaveTypeRow[]).map(mapLeaveType);
    })(),
    events: ((eventsRes.data ?? []) as EventRow[]).map(mapEvent),
    notices: await (async () => {
      if (!noticesRes.error) {
        return ((noticesRes.data ?? []) as NotificationRow[]).map(mapNotice);
      }
      const retry = await supabase
        .from("notifications")
        .select("id, type, message, read, created_at")
        .order("created_at", { ascending: false });
      return ((retry.data ?? []) as NotificationRow[]).map(mapNotice);
    })(),
    authorizations: authorizationRows.map((row) => {
      const mapped = mapAuthorization(
        row,
        departmentByEmployeeId.get(row.employee_id) ?? "Unassigned",
      );
      if (mapped.name !== "Unknown") return mapped;
      return {
        ...mapped,
        name:
          mappedEmployees.find((employee) => employee.id === mapped.employeeId)
            ?.name ?? "Unknown",
      };
    }),
    currentEmployee:
      mappedEmployees.find((employee) => employee.id === user.id) ?? null,
  };
}

export default function Page() {
  const pathname = usePathname();
  const [path, setPath] = useState(pathname);
  const [active, setActive] = useState("Overview");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [events, setEvents] = useState<CompanyEvent[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [authorizations, setAuthorizations] = useState<Authorization[]>([]);
  const [currentEmployee, setCurrentEmployee] = useState<Employee | null>(null);
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [showNotices, setShowNotices] = useState(false);
  const [noticeFocus, setNoticeFocus] = useState<NoticeFocus | null>(null);
  const [globalSearch, setGlobalSearch] = useState("");

  useEffect(() => {
    const syncPath = () => {
      const url = new URL(window.location.href);
      setPath(url.pathname);
      if (url.searchParams.get("profile") === "1") {
        setActive("My profile");
        url.searchParams.delete("profile");
        const next = `${url.pathname}${url.search}`;
        window.history.replaceState({}, "", next);
      }
    };
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        window.location.reload();
        return;
      }
      syncPath();
    };
    syncPath();
    window.addEventListener("popstate", syncPath);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("popstate", syncPath);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  const applyWorkspace = (
    data: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>,
  ) => {
    setEmployees(data.employees);
    setDepartments(data.departments);
    setRequests(data.requests);
    setBalances(data.balances);
    setLeaveTypes(data.leaveTypes);
    setEvents(data.events);
    setNotices(data.notices);
    setAuthorizations(data.authorizations);
    setCurrentEmployee(data.currentEmployee);
  };

  const reload = async () => {
    const data = await loadWorkspace();
    if (data) applyWorkspace(data);
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const data = await loadWorkspace();
      if (cancelled || !data) return;
      applyWorkspace(data);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      path === "/login" ||
      path === "/forgot-password" ||
      path === "/reset-password"
    ) {
      return;
    }

    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const listen = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled || !user) return;

      channel = supabase
        .channel(`notifications:${user.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            if (payload.eventType === "INSERT" && payload.new) {
              const next = mapNotice(payload.new as NotificationRow);
              setNotices((current) => {
                if (current.some((notice) => notice.id === next.id)) {
                  return current;
                }
                return [next, ...current];
              });
              return;
            }
            if (payload.eventType === "UPDATE" && payload.new) {
              const next = mapNotice(payload.new as NotificationRow);
              setNotices((current) =>
                current.map((notice) =>
                  notice.id === next.id ? next : notice,
                ),
              );
              return;
            }
            if (payload.eventType === "DELETE" && payload.old) {
              const id = (payload.old as { id?: string }).id;
              if (!id) return;
              setNotices((current) =>
                current.filter((notice) => notice.id !== id),
              );
            }
          },
        )
        .subscribe();
    };

    void listen();
    return () => {
      cancelled = true;
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
  }, [path]);

  const navigate = (to: string) => {
    window.history.pushState({}, "", to);
    setPath(to);
  };

  const logout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.replace("/login");
  };

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 2600);
  };

  const isEmployee = path.startsWith("/dashboard");
  const role: Role = toUiRole(currentEmployee?.role, isEmployee ? "Employee" : "Admin");

  const openNotice = async (item: Notice) => {
    const authorization =
      Boolean(item.authorizationId) || /authorization/i.test(item.text);
    const focus: NoticeFocus = {
      tab: authorization ? "authorizations" : "leaves",
      id: item.authorizationId ?? item.leaveRequestId ?? null,
    };
    setShowNotices(false);
    setActive(isEmployee ? "My requests" : "Leave requests");
    setNoticeFocus(focus);
    await reload();
    setNoticeFocus({ ...focus });
  };

  const openSearchRequest = (request: LeaveRequest) => {
    setGlobalSearch("");
    setActive(isEmployee ? "My requests" : "Leave requests");
    setNoticeFocus({ tab: "leaves", id: request.id });
  };

  if (
    path === "/login" ||
    path === "/forgot-password" ||
    path === "/reset-password"
  ) {
    return <AuthScreen path={path} navigate={navigate} />;
  }

  return (
    <div
      className={`app-shell ${isEmployee ? "employee-shell" : "admin-shell"}`}
    >
      {isEmployee ? (
        <EmployeeNav
          active={active}
          setActive={setActive}
        >
          <TopActions
            role={role}
            logout={logout}
            setActive={setActive}
            notices={notices}
            setNotices={setNotices}
            showNotices={showNotices}
            setShowNotices={setShowNotices}
            globalSearch={globalSearch}
            setGlobalSearch={setGlobalSearch}
            currentEmployee={currentEmployee}
            employees={employees}
            requests={requests}
            onOpenNotice={openNotice}
            onOpenRequest={openSearchRequest}
          />
        </EmployeeNav>
      ) : (
        <Sidebar
          active={active}
          setActive={setActive}
          logout={logout}
          currentEmployee={currentEmployee}
          requests={requests}
        />
      )}
      <main className="main-content">
        {!isEmployee && (
          <header className="topbar">
            <div className="breadcrumb">
              <span className="breadcrumb-muted">{role} workspace</span>
              <ChevronRight size={14} />
              <span>{active}</span>
            </div>
            <TopActions
              role={role}
              logout={logout}
              setActive={setActive}
              notices={notices}
              setNotices={setNotices}
              showNotices={showNotices}
              setShowNotices={setShowNotices}
              globalSearch={globalSearch}
              setGlobalSearch={setGlobalSearch}
              currentEmployee={currentEmployee}
              employees={employees}
              requests={requests}
              onOpenNotice={openNotice}
              onOpenRequest={openSearchRequest}
            />
          </header>
        )}
        {isEmployee && (
          <header className="employee-mobile-top">
            <Logo />
            <TopActions
              role={role}
              logout={logout}
              setActive={setActive}
              notices={notices}
              setNotices={setNotices}
              showNotices={showNotices}
              setShowNotices={setShowNotices}
              globalSearch={globalSearch}
              setGlobalSearch={setGlobalSearch}
              currentEmployee={currentEmployee}
              employees={employees}
              requests={requests}
              onOpenNotice={openNotice}
              onOpenRequest={openSearchRequest}
            />
          </header>
        )}
        <div className="page-wrap">
          {isEmployee ? (
            <EmployeeView
              active={active}
              requests={requests}
              authorizations={authorizations}
              flash={flash}
              setModal={setModal}
              currentEmployee={currentEmployee}
              balances={balances}
              leaveTypes={leaveTypes}
              events={events}
              noticeFocus={noticeFocus}
              onNoticeFocusHandled={() => setNoticeFocus(null)}
              reload={reload}
            />
          ) : (
            <AdminView
              active={active}
              requests={requests}
              authorizations={authorizations}
              setRequests={setRequests}
              employees={employees}
              setEmployees={setEmployees}
              departments={departments}
              setDepartments={setDepartments}
              setSelected={setSelected}
              navigate={navigate}
              flash={flash}
              setModal={setModal}
              globalSearch={globalSearch}
              currentEmployee={currentEmployee}
              events={events}
              balances={balances}
              setBalances={setBalances}
              leaveTypes={leaveTypes}
              noticeFocus={noticeFocus}
              onNoticeFocusHandled={() => setNoticeFocus(null)}
              reload={reload}
            />
          )}
        </div>
      </main>
      {notice && (
        <div className="toast">
          <Check size={17} />
          {notice}
        </div>
      )}
      {modal === "request" && (
        <RequestModal
          leaveTypes={leaveTypes}
          balances={balances}
          requests={requests}
          employeeId={currentEmployee?.id ?? null}
          close={() => setModal(null)}
          flash={flash}
          onSubmitted={async () => {
            setModal(null);
            await reload();
            flash("Leave request submitted for approval");
          }}
        />
      )}
      {modal === "authorization" && (
        <AuthorizationModal
          authorizations={authorizations}
          currentEmployeeId={currentEmployee?.id ?? null}
          close={() => setModal(null)}
          flash={flash}
          onSubmitted={async () => {
            setModal(null);
            await reload();
            flash("Authorization submitted for approval");
          }}
        />
      )}
      {modal === "event" && (
        <EventModal
          close={() => setModal(null)}
          flash={flash}
          onSaved={async () => {
            setModal(null);
            await reload();
            flash("Company event added to calendar");
          }}
        />
      )}
      {modal === "department" && (
        <DepartmentModal
          employees={employees}
          close={() => setModal(null)}
          flash={flash}
          onSaved={async () => {
            setModal(null);
            await reload();
            flash("Department added successfully");
          }}
        />
      )}
      {modal === "employee" && (
        <EmployeeModal
          departments={departments}
          close={() => setModal(null)}
          flash={flash}
          onInvited={async () => {
            setModal(null);
            await reload();
            flash("Invite sent. They can set a password from their email.");
          }}
        />
      )}
      {selected && (
        <EmployeeDetail
          key={selected.id}
          employee={selected}
          departments={departments}
          leaveTypes={leaveTypes}
          balances={balances}
          close={() => setSelected(null)}
          flash={flash}
          onSaved={(employee, nextSolde) => {
            const nextEmployees = employees.map((item) =>
              item.id === employee.id ? employee : item,
            );
            setEmployees(nextEmployees);
            setDepartments((current) =>
              current.map((department) => ({
                ...department,
                count: nextEmployees.filter(
                  (item) => item.departmentId === department.id,
                ).length,
              })),
            );
            setBalances((current) => [
              ...current.filter((item) => item.employeeId !== employee.id),
              ...nextSolde,
            ]);
            if (currentEmployee?.id === employee.id) {
              setCurrentEmployee(employee);
            }
            setSelected(employee);
          }}
        />
      )}
    </div>
  );
}
