export type TunisiaHoliday = {
  date: string;
  name: string;
  localName: string;
};

type NagerHoliday = {
  date: string;
  name: string;
  localName: string;
};

const cache = new Map<number, TunisiaHoliday[]>();
const pending = new Map<number, Promise<TunisiaHoliday[]>>();

export async function loadTunisiaHolidays(year: number) {
  if (!Number.isFinite(year)) return [];
  const cached = cache.get(year);
  if (cached) return cached;
  const inflight = pending.get(year);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      const response = await fetch(`/api/holidays/${year}`);
      if (!response.ok) return [];
      const rows = (await response.json()) as NagerHoliday[];
      const holidays = (Array.isArray(rows) ? rows : [])
        .filter((row) => row?.date && row?.name)
        .map((row) => ({
          date: row.date,
          name: row.name,
          localName: row.localName || row.name,
        }));
      cache.set(year, holidays);
      return holidays;
    } catch {
      return [];
    } finally {
      pending.delete(year);
    }
  })();

  pending.set(year, request);
  return request;
}

export function holidaysInMonth(
  holidays: TunisiaHoliday[],
  year: number,
  month: number,
) {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  return holidays.filter((holiday) => holiday.date.startsWith(prefix));
}
