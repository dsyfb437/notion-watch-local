export const DEFAULT_ROOT = ""; // New installations configure their own entry page.
export function pageRef(
  input: string,
  base = "https://app.notion.com",
): { id: string; url: string } | null {
  try {
    const u = new URL(input, base);
    if (u.origin !== "https://app.notion.com" || u.username || u.password)
      return null;
    const id = u.pathname
      .match(
        /([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i,
      )?.[1]
      ?.replaceAll("-", "")
      .toLowerCase();
    if (!id) return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()])
      if (key !== "v") u.searchParams.delete(key);
    return { id, url: u.href };
  } catch {
    return null;
  }
}
export function editDate(raw: string, observed: number): string | null {
  raw = raw.replace(/[\u00a0\u202f]/g, " ").trim();
  const hour24 = (h: string, part?: string) => {
    const value = +h;
    if (part) {
      if (value < 1 || value > 12) return null;
      return (value % 12) + (part.toLowerCase() === "pm" ? 12 : 0);
    }
    return value <= 23 ? value : null;
  };
  const relative = raw.match(
    /^(Today|Yesterday|The day before yesterday)\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)?$/i,
  );
  if (relative) {
    const h = hour24(relative[2], relative[4]);
    if (h === null) return null;
    const label =
      relative[1].toLowerCase() === "today"
        ? "今天"
        : relative[1].toLowerCase() === "yesterday"
          ? "昨天"
          : "前天";
    raw = `${label} ${h}:${relative[3]}`;
  }
  const english = raw.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)?)?$/i,
  );
  if (english) {
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];
    const month = months.indexOf(english[1].slice(0, 3).toLowerCase()) + 1;
    const h = english[4] ? hour24(english[4], english[6]) : undefined;
    if (h === null) return null;
    raw = `${english[3] ? english[3] + "年" : ""}${month}月${english[2]}日${h !== undefined ? " " + h + ":" + english[5] : ""}`;
  }
  const now = new Date(observed);
  let y = now.getFullYear(),
    m = now.getMonth() + 1,
    d = now.getDate();
  let match = raw.trim().match(/^(今天|昨天|前天)\s+(\d{1,2}):(\d{2})$/);
  let h: string | undefined, min: string | undefined;
  if (match) {
    const delta = match[1] === "昨天" ? 1 : match[1] === "前天" ? 2 : 0;
    const date = new Date(y, m - 1, d - delta);
    y = date.getFullYear();
    m = date.getMonth() + 1;
    d = date.getDate();
    h = match[2];
    min = match[3];
  } else {
    match = raw
      .trim()
      .match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (!match) return null;
    if (match[1]) y = +match[1];
    m = +match[2];
    d = +match[3];
    h = match[4];
    min = match[5];
    if (!match[1] && new Date(y, m - 1, d).getTime() > observed + 86400000) y--;
  }
  const date = new Date(y, m - 1, d, +(h || 0), +(min || 0));
  if (
    date.getMonth() + 1 !== m ||
    date.getDate() !== d ||
    +(h || 0) > 23 ||
    +(min || 0) > 59
  )
    return null;
  const pad = (x: string | number) => String(x).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}${h ? ` ${pad(h)}:${min}` : ""}`;
}
export interface Child {
  id: string;
  url: string;
  title: string;
}
export interface Frame {
  id: string | null;
  documentId?: string | null;
  title: string;
  ready: boolean;
  children: Child[];
  warnings: string[];
  bottom: boolean;
  position: number;
  height: number;
  author?: string;
  rawTime?: string;
  observed: number;
  error?: string;
}
export interface Page extends Child {
  author?: string;
  editKey?: string;
  rawTime?: string;
  lastSuccessfulAt?: number;
  lastAttemptAt?: number;
  error?: string;
  warnings?: string[];
  depth: number;
  parent?: string;
  children?: Child[];
  lastDiscoveryAt?: number;
}
export interface Update {
  id: string;
  pageId: string;
  url: string;
  title: string;
  author: string;
  editKey: string;
  detectedAt: number;
  kind: "updated" | "discovered";
  notified: boolean;
  read?: boolean;
}
export function changed(previous: Page | undefined, next: Page): boolean {
  if (!previous?.editKey || !next.editKey) return false;
  const a = previous.editKey,
    b = next.editKey;
  // A UI precision change (minute to date-only) is not an edit.
  const sameTime =
    a.length === 10 || b.length === 10
      ? a.slice(0, 10) === b.slice(0, 10)
      : a === b;
  return !sameTime || previous.author !== next.author;
}

const DAY = 86400000;
// Weekly reports are titled with a date range such as "11.16-11.22第十二周 周报".
// Parse the range nearest to now; unparseable titles are kept in scope.
export function weekRange(
  title: string,
  now: number,
): { start: number; end: number } | null {
  const re = /(\d{1,2})\.(\d{1,2})(?:\s*[-–—~至]\s*(\d{1,2})\.(\d{1,2}))?/g;
  let best: { start: number; end: number; distance: number } | null = null;
  for (let m = re.exec(title); m; m = re.exec(title)) {
    const sm = +m[1],
      sd = +m[2],
      em = m[3] ? +m[3] : sm,
      ed = m[4] ? +m[4] : sd;
    if (
      sm < 1 ||
      sm > 12 ||
      em < 1 ||
      em > 12 ||
      sd < 1 ||
      sd > 31 ||
      ed < 1 ||
      ed > 31
    )
      continue;
    for (const year of [
      new Date(now).getFullYear() - 1,
      new Date(now).getFullYear(),
      new Date(now).getFullYear() + 1,
    ]) {
      const startDate = new Date(year, sm - 1, sd),
        endYear = year + (em < sm ? 1 : 0),
        endDate = new Date(endYear, em - 1, ed);
      if (
        startDate.getMonth() !== sm - 1 ||
        startDate.getDate() !== sd ||
        endDate.getMonth() !== em - 1 ||
        endDate.getDate() !== ed
      )
        continue;
      const distance = Math.abs(endDate.getTime() - now);
      if (!best || distance < best.distance)
        best = { start: startDate.getTime(), end: endDate.getTime(), distance };
    }
  }
  return best ? { start: best.start, end: best.end } : null;
}
// Monday includes the previous week (weekend edits); other days include the current
// week and anything newer. Pages without a date range stay in scope.
export function inRecentScope(title: string, now: number): boolean {
  const range = weekRange(title, now);
  if (!range) return true;
  const d = new Date(now),
    day = (d.getDay() + 6) % 7;
  const monday = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - day,
  ).getTime();
  const cutoff = monday - (d.getDay() === 1 ? 7 * DAY : 0);
  return range.end >= cutoff;
}
