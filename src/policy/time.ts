const DAY_MS = 86_400_000;

export interface LocalParts {
  date: string;
  hour: number;
  minute: number;
}

export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), minute: Number(get("minute")) };
}

export function localDate(at: Date, timeZone: string): string {
  return localParts(at, timeZone).date;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidYmd(ymd: string): boolean {
  const m = YMD.exec(ymd);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === ymd;
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / DAY_MS);
}

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function zonedLocalToUtc(localIso: string, timeZone: string): Date | undefined {
  const m = LOCAL_DATETIME.exec(localIso);
  if (!m || !isValidYmd(localIso.slice(0, 10))) return undefined;
  const [hour, minute] = [Number(m[4]), Number(m[5])];
  if (hour > 23 || minute > 59) return undefined;
  const wallClock = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute);
  let guess = wallClock;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const shown = Date.UTC(
      Number(p.date.slice(0, 4)),
      Number(p.date.slice(5, 7)) - 1,
      Number(p.date.slice(8, 10)),
      p.hour,
      p.minute,
    );
    guess += wallClock - shown;
  }
  return new Date(guess);
}

export function withinWindow(hour: number, window: { startHour: number; endHour: number }): boolean {
  return hour >= window.startHour && hour < window.endHour;
}
