/** Move one schedule row and keep `position` 1…n. */

export function moveSegment<T>(items: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items;
  }
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function withSegmentPositions<T extends { position: number }>(items: T[]) {
  return items.map((item, index) => ({ ...item, position: index + 1 }));
}

export type CopiedSegment = {
  isoWeekday: number;
  kind: "work" | "break";
  startTime: string;
  endTime: string;
};

export function cloneSegment(segment: CopiedSegment): CopiedSegment {
  return {
    isoWeekday: segment.isoWeekday,
    kind: segment.kind,
    startTime: segment.startTime.slice(0, 5),
    endTime: segment.endTime.slice(0, 5),
  };
}

export function parseCopiedSegment(raw: string): CopiedSegment | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const isoWeekday = Number(value.isoWeekday);
    const startTime = String(value.startTime ?? "").slice(0, 5);
    const endTime = String(value.endTime ?? "").slice(0, 5);
    if (
      !Number.isInteger(isoWeekday) ||
      isoWeekday < 1 ||
      isoWeekday > 7 ||
      (value.kind !== "work" && value.kind !== "break") ||
      !/^\d{2}:\d{2}$/.test(startTime) ||
      !/^\d{2}:\d{2}$/.test(endTime) ||
      startTime >= endTime
    ) {
      return null;
    }
    return { isoWeekday, kind: value.kind, startTime, endTime };
  } catch {
    return null;
  }
}

export function insertAfter<T>(items: T[], index: number, item: T): T[] {
  const at = Math.min(Math.max(index + 1, 0), items.length);
  return [...items.slice(0, at), item, ...items.slice(at)];
}
