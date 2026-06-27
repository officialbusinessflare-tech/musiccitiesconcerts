/**
 * netlify/functions/_clickup-core.mjs
 *
 * Shared ClickUp fetching + normalization logic. Imported by both:
 *   - scripts/fetch-clickup.js  (local CLI)
 *   - netlify/functions/nightly-rebuild.mjs  (scheduled function)
 *
 * Plain Node ESM, no TypeScript. The categorize() port lives at the bottom
 * to keep the dependency graph simple (Node can't import .ts directly without
 * a loader, and we don't want to require a build step for the script).
 */

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const PAGE_SIZE = 100; // ClickUp returns up to 100 per page.

// Tasks whose names match any of these patterns are admin/meta — skip them.
const SKIP_NAME_PATTERNS = [
  /🎸\s*Concerts Sweep/i,
  /STRATEGIC CONCEPT/i,
  /Draft Content/i,
  /Virtual Summit/i,
  /Get Nemophila t-shirt/i,
  /Trip Logistics/i,
  /Attendance Priority/i,
  /Stage Schedule and Meet/i,
  /^\[NOT ATTENDING\]/i,
  /NOT ATTENDING/i,
  /⚠️/,
];

const FESTIVAL_HINTS = ['fest', 'festival', 'open air'];

/* ----------------------------------------------------------------------------
 * ClickUp API
 * -------------------------------------------------------------------------- */

/**
 * Fetch all tasks from a ClickUp list. Pages through automatically.
 *
 * @param {{ token: string, listId: string }} opts
 * @returns {Promise<object[]>} raw ClickUp task objects
 */
export async function fetchClickUpTasks({ token, listId }) {
  if (!token) throw new Error('fetchClickUpTasks: token is required');
  if (!listId) throw new Error('fetchClickUpTasks: listId is required');

  const all = [];
  let page = 0;
  let keepGoing = true;

  while (keepGoing) {
    const url = new URL(`${CLICKUP_API}/list/${listId}/task`);
    url.searchParams.set('include_closed', 'false');
    url.searchParams.set('order_by', 'due_date');
    url.searchParams.set('reverse', 'false');
    url.searchParams.set('page', String(page));

    const res = await fetch(url, {
      headers: {
        Authorization: token,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ClickUp API ${res.status} on page ${page}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    const tasks = Array.isArray(json.tasks) ? json.tasks : [];
    all.push(...tasks);

    // ClickUp signals end-of-results by returning fewer than PAGE_SIZE tasks.
    if (tasks.length < PAGE_SIZE) {
      keepGoing = false;
    } else {
      page += 1;
      if (page > 50) {
        // Safety brake — 5,000 tasks is way past anything reasonable.
        console.warn('fetchClickUpTasks: hit safety brake at 50 pages.');
        keepGoing = false;
      }
    }
  }

  return all;
}

/* ----------------------------------------------------------------------------
 * Task -> ConcertEntry normalization
 * -------------------------------------------------------------------------- */

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function tsToIsoDate(ts) {
  if (!ts && ts !== 0) return null;
  const n = typeof ts === 'string' ? Number(ts) : ts;
  if (!Number.isFinite(n)) return null;
  // ClickUp gives ms epoch as a stringified number.
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function shouldSkipName(name) {
  if (!name) return true;
  return SKIP_NAME_PATTERNS.some((re) => re.test(name));
}

// ClickUp priority schema: 1=urgent, 2=high, 3=normal, 4=low.
function normalizePriority(p) {
  if (!p) return 'normal';
  const id = typeof p === 'object' ? p.id ?? p.priority : p;
  const map = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
  if (typeof id === 'string') return map[id] || 'normal';
  if (typeof id === 'number') return map[id] || 'normal';
  return 'normal';
}

/**
 * Strip markdown for a clean preview. Not exhaustive — handles the common
 * cases (links, bold, italic, headings, lists, code).
 */
function stripMarkdown(input) {
  if (!input) return '';
  let s = String(input);
  // Code fences and inline code
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]+)`/g, '$1');
  // Images and links: keep text, drop URL
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Headings, blockquotes, list markers
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, '');
  s = s.replace(/^\s{0,3}\d+\.\s+/gm, '');
  // Bold/italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/_([^_]+)_/g, '$1');
  // Collapse whitespace
  s = s.replace(/\r/g, '');
  s = s.replace(/\n{2,}/g, '\n\n');
  s = s.replace(/[ \t]+/g, ' ').trim();
  return s;
}

function firstParagraph(text, maxLen = 280) {
  if (!text) return '';
  const para = text.split(/\n\s*\n/)[0]?.trim() ?? '';
  if (para.length <= maxLen) return para;
  // Cut at last word boundary before maxLen.
  const cut = para.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

function extractFirstUrl(text) {
  if (!text) return undefined;
  const match = String(text).match(/https?:\/\/[^\s)>"']+/i);
  if (!match) return undefined;
  // Trim trailing punctuation that often hangs on URLs in markdown.
  return match[0].replace(/[.,;:!?)]+$/, '');
}

/**
 * Parse a task name like:
 *   "Nemophila — Conduit, Orlando, FL"
 *   "BABYMETAL + LOVEBITES - Hard Rock Live, Hollywood, FL"
 *   "Wacken Open Air — Wacken, Germany"
 *   "📀 LOVEBITES — Judgement Day (EP release)"
 *
 * Returns { headlineSegment, venuePart } using the first em-dash or hyphen as
 * the splitter. headlineSegment may contain multiple bands joined by + / & etc.
 */
function splitOnDash(name) {
  // Em-dash, en-dash, or space-hyphen-space.
  const m = name.match(/^([^—–]+?)\s*[—–]\s*(.+)$/);
  if (m) return { headlineSegment: m[1].trim(), venuePart: m[2].trim() };

  const m2 = name.match(/^(.+?)\s+-\s+(.+)$/);
  if (m2) return { headlineSegment: m2[1].trim(), venuePart: m2[2].trim() };

  return { headlineSegment: name.trim(), venuePart: '' };
}

/**
 * From the headline segment, extract a list of band candidates.
 * Splits on +, /, &, ' w/ ', or comma when it doesn't look like a city.
 */
function parseBands(headlineSegment) {
  if (!headlineSegment) return [];
  // Strip the leading disc emoji if present.
  const cleaned = headlineSegment.replace(/^\s*📀\s*/, '').trim();
  if (!cleaned) return [];

  // Primary splitters — these almost always separate bands.
  const parts = cleaned
    .split(/\s*\+\s*|\s*\/\s*|\s*&\s*|\s+w\/\s+|\s+with\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  // Don't try to be clever about commas — too easy to slice a band name in
  // half (e.g. "Black, White & Crüe"). Return what we have.
  return parts;
}

/**
 * From the venue-side string, pull out venue / city / state / country.
 *
 * Common shapes:
 *   "Conduit, Orlando, FL"
 *   "Hard Rock Live, Hollywood, FL"
 *   "O2 Academy Islington, London, UK"
 *   "Wacken, Germany"
 *   "Tokyo GRIT, Tokyo, Japan"
 *
 * Heuristic: split on commas. Last segment = state/country, second-to-last =
 * city, everything else = venue.
 */
function parseVenueLocation(venuePart) {
  if (!venuePart) return {};
  const segs = venuePart
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (segs.length === 0) return {};
  if (segs.length === 1) return { venue: segs[0] };
  if (segs.length === 2) {
    // "Wacken, Germany" — city + country, no venue.
    // Heuristic: if first looks like a US state code (2 chars upper), treat as venue+state.
    const [a, b] = segs;
    if (/^[A-Z]{2}$/.test(b)) return { venue: a, state: b };
    return { city: a, country: b };
  }

  const last = segs[segs.length - 1];
  const city = segs[segs.length - 2];
  const venue = segs.slice(0, -2).join(', ');

  const result = { venue, city };
  if (/^[A-Z]{2}$/.test(last)) {
    result.state = last;
  } else {
    result.country = last;
  }
  return result;
}

/**
 * Convert one raw ClickUp task into a ConcertEntry, or null if it should be skipped.
 */
export function taskToEntry(task) {
  if (!task) return null;
  const name = (task.name || '').trim();
  if (!name) return null;
  if (shouldSkipName(name)) return null;

  const date = tsToIsoDate(task.due_date);
  if (!date) return null;

  const today = todayIso();
  if (date < today) return null;

  // ClickUp does not surface a separate end_date on the standard task endpoint —
  // multi-day festivals are typically represented with a single due_date. We
  // leave endDate undefined unless a custom field provides it.
  const endDate = undefined;

  const isRelease = name.startsWith('📀');
  const { headlineSegment, venuePart } = splitOnDash(name);
  const bands = parseBands(headlineSegment);
  const { venue, city, state, country } = parseVenueLocation(venuePart);

  const rawDescription = task.markdown_description || task.description || '';
  const cleaned = stripMarkdown(rawDescription);
  const description = firstParagraph(cleaned, 280) || undefined;
  const ticketUrl = extractFirstUrl(rawDescription);

  const priority = normalizePriority(task.priority);
  const clickupUrl = task.url || `https://app.clickup.com/t/${task.id}`;

  return {
    id: String(task.id),
    name,
    date,
    endDate,
    venue: venue || undefined,
    city: city || undefined,
    state: state || undefined,
    country: country || undefined,
    bands,
    description,
    ticketUrl,
    priority,
    isRelease,
    isPast: false, // we already filtered out past entries
    clickupUrl,
    buckets: [], // filled in by buildConcertEntries
  };
}

/* ----------------------------------------------------------------------------
 * Bucket categorization (JS port of src/lib/categorize.ts)
 * -------------------------------------------------------------------------- */

function includesCi(haystack, needle) {
  if (!haystack) return false;
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

function matchesAnyBand(entryBands, bandKeywords) {
  if (!bandKeywords?.length || !entryBands?.length) return false;
  const lowered = entryBands.map((b) => b.toLowerCase());
  return bandKeywords.some((kw) => {
    const k = kw.toLowerCase();
    return lowered.some((b) => b.includes(k) || k.includes(b));
  });
}

function matchesAnyVenue(venue, venueKeywords) {
  if (!venue || !venueKeywords?.length) return false;
  return venueKeywords.some((kw) => includesCi(venue, kw));
}

function matchesAnyCity(city, name, cityKeywords) {
  if (!cityKeywords?.length) return false;
  return cityKeywords.some((kw) => includesCi(city, kw) || includesCi(name, kw));
}

function looksLikeFestival(name) {
  const lower = String(name || '').toLowerCase();
  return FESTIVAL_HINTS.some((h) => lower.includes(h));
}

export function categorize(entry, buckets) {
  const matched = [];
  for (const bucket of buckets) {
    const rules = bucket.matchRules || {};
    let isMatch = false;

    if (rules.isRelease && entry.isRelease) isMatch = true;

    if (!isMatch && rules.isFestival) {
      if (looksLikeFestival(entry.name)) isMatch = true;
      if (!isMatch && matchesAnyVenue(entry.venue, rules.venues || [])) isMatch = true;
    }

    if (!isMatch && matchesAnyVenue(entry.venue, rules.venues || [])) isMatch = true;
    if (!isMatch && matchesAnyCity(entry.city, entry.name, rules.cities || [])) isMatch = true;
    if (!isMatch && matchesAnyBand(entry.bands, rules.bands || [])) isMatch = true;

    if (isMatch) matched.push(bucket.id);
  }
  return matched;
}

/* ----------------------------------------------------------------------------
 * Top-level helper
 * -------------------------------------------------------------------------- */

/**
 * Take an array of raw ClickUp tasks plus the loaded bucket configs and
 * return a categorized, date-sorted ConcertEntry array.
 */
export function buildConcertEntries(rawTasks, buckets) {
  const entries = [];
  for (const t of rawTasks) {
    try {
      const e = taskToEntry(t);
      if (!e) continue;
      e.buckets = categorize(e, buckets);
      entries.push(e);
    } catch (err) {
      // Be defensive — don't let one bad task crash the run.
      console.warn(`Skipping task ${t?.id ?? '<unknown>'}: ${err?.message ?? err}`);
    }
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

/**
 * Summarize counts by bucket for logging.
 */
export function summarize(entries, buckets) {
  const counts = {};
  for (const b of buckets) counts[b.id] = 0;
  counts._uncategorized = 0;
  for (const e of entries) {
    if (!e.buckets.length) {
      counts._uncategorized += 1;
      continue;
    }
    for (const id of e.buckets) {
      counts[id] = (counts[id] || 0) + 1;
    }
  }
  return counts;
}
