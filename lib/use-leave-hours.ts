"use client";

import { useCallback, useEffect, useState } from "react";

import type { LeaveHourSelf } from "@/lib/leave-hours";

export function useLeaveHourBalance() {
  const [balance, setBalance] = useState<LeaveHourSelf | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/attendance/leave-hours", {
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json()) as LeaveHourSelf;
      if (typeof payload.balanceDays === "number" && payload.thisMonth) {
        setBalance(payload);
      }
    } catch {
      // Keep the last figure if the refresh fails.
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  return { balance, reload };
}

export type VacationFigure = {
  balanceDays: number;
  /** Opening balance minus approved deductions (what the admin edits). */
  ledgerDays: number | null;
  earnedDays: number | null;
  monthlyRate: number;
};

/**
 * Vacation balance (ledger + time-clock accrual) per employee: everyone for
 * staff, only the signed-in employee otherwise. Refreshes every minute.
 */
export function useVacationBalances(mode: "staff" | "self" | null, selfId: string | null) {
  const [figures, setFigures] = useState<Map<string, VacationFigure> | null>(null);

  const reload = useCallback(async () => {
    if (!mode || (mode === "self" && !selfId)) return;
    try {
      const response = await fetch(
        mode === "staff" ? "/api/attendance/leave-hours?balances=1" : "/api/attendance/leave-hours",
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as
        | { items?: (VacationFigure & { employeeId: string })[] }
        | (LeaveHourSelf & { ledgerDays?: number; earnedDays?: number });
      const next = new Map<string, VacationFigure>();
      if (mode === "staff" && "items" in payload && Array.isArray(payload.items)) {
        for (const item of payload.items) {
          next.set(item.employeeId, {
            balanceDays: item.balanceDays,
            ledgerDays: item.ledgerDays ?? null,
            earnedDays: item.earnedDays ?? null,
            monthlyRate: item.monthlyRate,
          });
        }
      } else if (mode === "self" && selfId && "balanceDays" in payload) {
        next.set(selfId, {
          balanceDays: payload.balanceDays,
          ledgerDays: payload.ledgerDays ?? null,
          earnedDays: payload.earnedDays ?? null,
          monthlyRate: payload.monthlyRate,
        });
      }
      setFigures(next);
    } catch {
      // Keep the last figures if the refresh fails.
    }
  }, [mode, selfId]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  return { figures, reload };
}
