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
