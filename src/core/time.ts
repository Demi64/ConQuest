// 日付・時刻の小道具。時刻はUTCのISO文字列、日付は設定のタイムゾーンでの YYYY-MM-DD。

export const nowIso = (): string => new Date().toISOString();

export function localDate(tz: string, d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** そのタイムゾーンでの「YYYY-MM-DDTHH:MM」 */
export function localDateTime(tz: string, d: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

const toUtc = (date: string): Date => new Date(`${date}T00:00:00Z`);

export function addDays(date: string, n: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86400000);
}

/** 0=日 … 6=土 */
export function weekday(date: string): number {
  return toUtc(date).getUTCDay();
}

export function lastDayOfMonth(date: string): number {
  const d = toUtc(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DUE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

export function isValidDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(toUtc(s).getTime()) && toUtc(s).toISOString().slice(0, 10) === s;
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** そのタイムゾーンでの「YYYY-MM-DDTHH:MM」を、UTCの時刻に直す */
export function zonedToUtc(dateTime: string, tz: string): Date {
  const asUtc = new Date(`${dateTime}:00Z`);
  const shown = new Date(`${localDateTime(tz, asUtc)}:00Z`);
  return new Date(asUtc.getTime() - (shown.getTime() - asUtc.getTime()));
}
