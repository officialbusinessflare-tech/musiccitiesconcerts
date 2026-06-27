———/**
   * Parse a ClickUp Artist Birthdays task into a BirthdayEntry.
   *
   * Expected name format: "{Person Name} Birthday {Affiliation}"
   */

import type { BirthdayEntry } from './types.js';

type RawClickUpTask = {
    id: string;
    name?: string;
    due_date?: string | number | null;
    url?: string;
    description?: string;
    markdown_description?: string;
};

function decodeEntities(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
}

function extractStatus(s: string): { core: string; status?: string } {
    const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!m) return { core: s.trim() };
    return { core: m[1].trim(), status: m[2].trim() };
}

export function parseBirthdayName(rawName: string): {
    person: string;
    affiliation?: string;
    status?: string;
} {
    if (!rawName) return { person: '' };
    const decoded = decodeEntities(rawName.trim());
    const { core, status } = extractStatus(decoded);

  const m = core.match(/^(.+?)\s+Birthday\s+(.+)$/i);
    if (!m) return { person: core, status };

  const person = m[1].trim();
    const affRaw = m[2].trim();
    const affiliation = affRaw && affRaw.toLowerCase() !== 'solo' ? affRaw : undefined;

  return { person, affiliation, status };
}

function tsToYMD(ts: string | number | null | undefined): string | null {
    if (ts == null) return null;
    const n = typeof ts === 'string' ? Number(ts) : ts;
    if (!Number.isFinite(n)) return null;
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

export function taskToBirthday(task: RawClickUpTask): BirthdayEntry | null {
    if (!task) return null;
    const name = (task.name || '').trim();
    if (!name) return null;

  const { person, affiliation, status } = parseBirthdayName(name);
    if (!person) return null;

  const rawDate = tsToYMD(task.due_date) ?? undefined;
    let month: number | undefined;
    let day: number | undefined;
    if (rawDate) {
          const [, mo, da] = rawDate.split('-').map(Number);
          if (mo && da) {
                  month = mo;
                  day = da;
          }
    }

  const clickupUrl = task.url || `https://app.clickup.com/t/${task.id}`;
    const desc = (task.markdown_description || task.description || '').trim();

  return {
        id: String(task.id),
        name,
        person,
        affiliation,
        rawDate,
        month,
        day,
        description: desc || undefined,
        status,
        clickupUrl,
  };
}

export function buildBirthdayEntries(rawTasks: RawClickUpTask[]): BirthdayEntry[] {
    const entries: BirthdayEntry[] = [];
    for (const t of rawTasks) {
          try {
                  const e = taskToBirthday(t);
                  if (e) entries.push(e);
          } catch (err) {
                  console.warn(`[birthdays] Skipping ${t?.id ?? '<unknown>'}: ${(err as Error)?.message ?? err}`);
          }
    }
    const now = new Date();
    const todayKey = now.getMonth() * 100 + now.getDate();
    function upcomingKey(e: BirthdayEntry): number {
          if (e.month == null || e.day == null) return Number.MAX_SAFE_INTEGER;
          const key = (e.month - 1) * 100 + e.day;
          return key < todayKey ? key + 1300 : key;
    }
    entries.sort((a, b) => upcomingKey(a) - upcomingKey(b));
    return entries;
}
