/**
 * netlify/functions/_clickup-core.mjs
 *
 * Shared ClickUp fetching + normalization logic. Imported by both:
 *   - scripts/fetch-clickup.js (local CLI)
 *   - netlify/functions/nightly-rebuild.mjs (scheduled function)
 *
 * Plain Node ESM, no TypeScript. Keep parseTaskName/parseVenueLocation in
 * lock-step with src/lib/parse-name.ts — they implement the same algorithm.
 */

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const PAGE_SIZE = 100;

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
                  headers: { Authorization: token, Accept: 'application/json' },
        });

        if (!res.ok) {
                  const body = await res.text().catch(() => '');
                  throw new Error(`ClickUp API ${res.status} on page ${page}: ${body.slice(0, 200)}`);
        }

        const json = await res.json();
          const tasks = Array.isArray(json.tasks) ? json.tasks : [];
          all.push(...tasks);

        if (tasks.length < PAGE_SIZE) keepGoing = false;
          else {
                    page += 1;
                    if (page > 50) {
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
      const d = new Date(n);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
}

function shouldSkipName(name) {
      if (!name) return true;
      return SKIP_NAME_PATTERNS.some((re) => re.test(name));
}

function normalizePriority(p) {
      if (!p) return 'normal';
      const id = typeof p === 'object' ? p.id ?? p.priority : p;
      const map = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
      if (typeof id === 'string') return map[id] || 'normal';
      if (typeof id === 'number') return map[id] || 'normal';
      return 'normal';
}

function stripMarkdown(input) {
      if (!input) return '';
      let s = String(input);
      s = s.replace(/```[\s\S]*?```/g, ' ');
      s = s.replace(/`([^`]+)`/g, '$1');
      s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
      s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
      s = s.replace(/^\s{0,3}>\s?/gm, '');
      s = s.replace(/^\s{0,3}[-*+]\s+/gm, '');
      s = s.replace(/^\s{0,3}\d+\.\s+/gm, '');
      s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
      s = s.replace(/\*([^*]+)\*/g, '$1');
      s = s.replace(/__([^_]+)__/g, '$1');
      s = s.replace(/_([^_]+)_/g, '$1');
      s = s.replace(/\r/g, '');
      s = s.replace(/\n{2,}/g, '\n\n');
      s = s.replace(/[ \t]+/g, ' ').trim();
      return s;
}

function firstParagraph(text, maxLen = 280) {
      if (!text) return '';
      const para = text.split(/\n\s*\n/)[0]?.trim() ?? '';
      if (para.length <= maxLen) return para;
      const cut = para.slice(0, maxLen);
      const lastSpace = cut.lastIndexOf(' ');
      return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

function extractFirstUrl(text) {
      if (!text) return undefined;
      const match = String(text).match(/https?:\/\/[^\s)>"']+/i);
      if (!match) return undefined;
      return match[0].replace(/[.,;:!?)]+$/, '');
}

function collectKnownVenues(buckets) {
      const set = new Set();
      for (const b of buckets || []) {
              const venues = b?.matchRules?.venues || [];
              for (const v of venues) {
                        if (typeof v === 'string' && v.trim()) set.add(v.trim());
              }
      }
      return set;
}

/**
 * Parse a task name into { bands, venue, city, state, country }. See
 * src/lib/parse-name.ts for the matching TS implementation.
 */
export function parseTaskName(name, knownVenues = new Set()) {
      if (!name || typeof name !== 'string') {
              return { bands: [], venue: undefined, city: undefined, state: undefined, country: undefined };
      }

  const trimmed = name.trim();
      const isRelease = trimmed.startsWith('📀');

  let headlineSegment = trimmed;
      let venuePart = '';

  const emDash = trimmed.match(/^([^—–]+?)\s*[—–]\s*(.+)$/);
      if (emDash) {
              headlineSegment = emDash[1].trim();
              venuePart = emDash[2].trim();
      } else {
              const venueWord = trimmed.match(/^(.+?)\s+(?:with|at|@)\s+(.+)$/i);
              if (venueWord) {
                        headlineSegment = venueWord[1].trim();
                        venuePart = venueWord[2].trim();
              } else {
                        const dash = trimmed.match(/^(.+?)\s+-\s+(.+)$/);
                        if (dash) {
                                    headlineSegment = dash[1].trim();
                                    venuePart = dash[2].trim();
                        }
              }
      }

  let bands = parseBandsFromHeadline(headlineSegment, isRelease);
      let loc = parseVenueLocation(venuePart);

  if (knownVenues && knownVenues.size > 0) {
          const rescuedVenues = [];
          bands = bands.filter((b) => {
                    const norm = b.toLowerCase();
                    for (const v of knownVenues) {
                                if (norm === v.toLowerCase() || norm.includes(v.toLowerCase())) {
                                              rescuedVenues.push(v);
                                              return false;
                                }
                    }
                    return true;
          });
          if (rescuedVenues.length && !loc.venue) {
                    loc = { ...loc, venue: rescuedVenues[0] };
          }
  }

  return {
          bands,
          venue: loc.venue,
          city: loc.city,
          state: loc.state,
          country: loc.country,
  };
}

function parseBandsFromHeadline(headlineSegment, isRelease) {
      if (!headlineSegment) return [];
      let cleaned = headlineSegment.replace(/^\s*📀\s*/, '').trim();
      if (isRelease) return cleaned ? [cleaned] : [];
      return cleaned
        .split(/\s*\+\s*|\s*\/\s*|\s*&\s*|\s+w\/\s+/i)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Split a segment like "Coral Springs FL" into city + state when the trailing
 * 2-letter token is a US state code. Returns whatever it can.
 */
function splitCityState(segment) {
      if (!segment) return {};
      const trimmed = String(segment).trim();
      if (/^[A-Z]{2}$/.test(trimmed)) return { state: trimmed };
      const m = trimmed.match(/^(.+?)\s+([A-Z]{2})$/);
      if (m) return { city: m[1].trim(), state: m[2] };
      return { city: trimmed };
}

function parseVenueLocation(venuePart) {
      if (!venuePart) return {};
      const segs = venuePart.split(',').map((s) => s.trim()).filter(Boolean);
      if (segs.length === 0) return {};

  if (segs.length === 1) {
          const cs = splitCityState(segs[0]);
          if (cs.state) return { city: cs.city, state: cs.state };
          return { venue: segs[0] };
  }

  if (segs.length === 2) {
          const [a, b] = segs;
          const cs = splitCityState(b);
          if (cs.city && cs.state) return { venue: a, city: cs.city, state: cs.state };
          if (cs.state && !cs.city) return { venue: a, state: cs.state };
          return { city: a, country: b };
  }

  // 3+ segments: venue(s), city, last.
  const last = segs[segs.length - 1];
      const cs = splitCityState(last);
      if (cs.state) {
              if (!cs.city) {
                        const city = segs[segs.length - 2];
                        const venue = segs.slice(0, -2).join(', ');
                        return { venue, city, state: cs.state };
              }
              const venue = segs.slice(0, -1).join(', ');
              return { venue, city: cs.city, state: cs.state };
      }
      const city = segs[segs.length - 2];
      const venue = segs.slice(0, -2).join(', ');
      return { venue, city, country: last };
}

export function taskToEntry(task, opts = {}) {
      if (!task) return null;
      const name = (task.name || '').trim();
      if (!name) return null;
      if (shouldSkipName(name)) return null;

  const date = tsToIsoDate(task.due_date);
      if (!date) return null;

  const today = todayIso();
      if (date < today) return null;

  const isRelease = name.startsWith('📀');
      const { bands, venue, city, state, country } = parseTaskName(name, opts.knownVenues);

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
          endDate: undefined,
          venue: venue || undefined,
          city: city || undefined,
          state: state || undefined,
          country: country || undefined,
          bands,
          description,
          ticketUrl,
          priority,
          isRelease,
          isPast: false,
          clickupUrl,
          buckets: [],
  };
}

/* ----------------------------------------------------------------------------
 * Bucket categorization
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

function matchesBucketRules(entry, bucket) {
      const rules = bucket.matchRules || {};
      if (rules.isRelease) return entry.isRelease === true;
      if (rules.isFestival) {
              if (looksLikeFestival(entry.name)) return true;
              if (matchesAnyVenue(entry.venue, rules.venues || [])) return true;
              if (matchesAnyCity(entry.city, entry.name, rules.cities || [])) return true;
              if (matchesAnyBand(entry.bands, rules.bands || [])) return true;
              return false;
      }
      if (matchesAnyVenue(entry.venue, rules.venues || [])) return true;
      if (matchesAnyCity(entry.city, entry.name, rules.cities || [])) return true;
      if (matchesAnyBand(entry.bands, rules.bands || [])) return true;
      return false;
}

export function categorize(entry, buckets) {
      const matched = [];
      let primaryMatched = false;
      for (const bucket of buckets) {
              const rules = bucket.matchRules || {};
              if (rules.isFallback) continue;
              if (rules.isRelease) continue;
              if (matchesBucketRules(entry, bucket)) {
                        matched.push(bucket.id);
                        primaryMatched = true;
              }
      }
      if (!primaryMatched) {
              for (const bucket of buckets) {
                        const rules = bucket.matchRules || {};
                        if (!rules.isFallback) continue;
                        if (matchesBucketRules(entry, bucket)) matched.push(bucket.id);
              }
      }
      for (const bucket of buckets) {
              const rules = bucket.matchRules || {};
              if (!rules.isRelease) continue;
              if (matchesBucketRules(entry, bucket)) matched.push(bucket.id);
      }
      return matched;
}

export function buildConcertEntries(rawTasks, buckets) {
      const knownVenues = collectKnownVenues(buckets);
      const entries = [];
      for (const t of rawTasks) {
              try {
                        const e = taskToEntry(t, { knownVenues });
                        if (!e) continue;
                        e.buckets = categorize(e, buckets);
                        entries.push(e);
              } catch (err) {
                        console.warn(`Skipping task ${t?.id ?? '<unknown>'}: ${err?.message ?? err}`);
              }
      }
      for (const e of entries) {
              for (const b of e.bands || []) {
                        if (knownVenues.has(b)) {
                                    console.warn(`[parse warning] Task ${e.id} "${e.name}" has band "${b}" that matches a known venue. Fix the title.`);
                        }
              }
      }
      entries.sort((a, b) => a.date.localeCompare(b.date));
      return entries;
}

export function summarize(entries, buckets) {
      const counts = {};
      for (const b of buckets) counts[b.id] = 0;
      counts._uncategorized = 0;
      for (const e of entries) {
              if (!e.buckets.length) {
                        counts._uncategorized += 1;
                        continue;
              }
              for (const id of e.buckets) counts[id] = (counts[id] || 0) + 1;
      }
      return counts;
}
