/**
 * Hardened re-parser for ClickUp task names. Mirrors the logic in
 * netlify/functions/_clickup-core.mjs so the dashboard can re-parse stale
 * entries from concerts.json at build time — picking up author-side typos
 * ("Nemophila with Conduit") and venue-name-as-band errors without waiting
 * for the nightly rebuild.
 *
 * Keep this in lock-step with the .mjs version. If you change one, change
 * the other.
 */

import type { BucketConfig, ConcertEntry } from './types.js';

type ParsedName = {
      bands: string[];
      venue?: string;
      city?: string;
      state?: string;
      country?: string;
};

export function collectKnownVenues(buckets: BucketConfig[]): Set<string> {
      const set = new Set<string>();
      for (const b of buckets || []) {
              const venues = b?.matchRules?.venues ?? [];
              for (const v of venues) {
                        if (typeof v === 'string' && v.trim()) set.add(v.trim());
              }
      }
      return set;
}

export function parseTaskName(name: string, knownVenues: Set<string> = new Set()): ParsedName {
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
          const rescuedVenues: string[] = [];
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

function parseBandsFromHeadline(headlineSegment: string, isRelease: boolean): string[] {
      if (!headlineSegment) return [];
      let cleaned = headlineSegment.replace(/^\s*📀\s*/, '').trim();
      if (isRelease) return cleaned ? [cleaned] : [];
      return cleaned
        .split(/\s*\+\s*|\s*\/\s*|\s*&\s*|\s+w\/\s+/i)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * If the last comma-separated segment looks like "City ST" (no comma between
 * city and state), split it. Examples:
 *   "Miami FL"            → city="Miami", state="FL"
 *   "Fort Lauderdale FL"  → city="Fort Lauderdale", state="FL"
 *   "Tokyo"               → city="Tokyo" (no state suffix)
 *   "FL"                  → state="FL" (state alone)
 */
function splitCityState(segment: string): { city?: string; state?: string } {
      if (!segment) return {};
      const trimmed = segment.trim();
      // State alone
  if (/^[A-Z]{2}$/.test(trimmed)) return { state: trimmed };
      // "City ST" with state code at the end
  const m = trimmed.match(/^(.+?)\s+([A-Z]{2})$/);
      if (m) return { city: m[1].trim(), state: m[2] };
      // No state code — treat as city alone
  return { city: trimmed };
}

function parseVenueLocation(venuePart: string): {
      venue?: string;
      city?: string;
      state?: string;
      country?: string;
} {
      if (!venuePart) return {};
      const segs = venuePart.split(',').map((s) => s.trim()).filter(Boolean);
      if (segs.length === 0) return {};

  if (segs.length === 1) {
          // Could be "Miami FL" or "Tokyo" or "Conduit".
        const cs = splitCityState(segs[0]);
          if (cs.state) {
                    // Looks like city+state; treat as such with no venue.
            return { city: cs.city, state: cs.state };
          }
          // No state suffix — single token treated as venue.
        return { venue: segs[0] };
  }

  if (segs.length === 2) {
          // Two segments. Try to interpret the last one as "City ST" first.
        const [a, b] = segs;
          const cs = splitCityState(b);
          if (cs.city && cs.state) {
                    return { venue: a, city: cs.city, state: cs.state };
          }
          if (cs.state && !cs.city) {
                    return { venue: a, state: cs.state };
          }
          // Otherwise treat as "City, Country" (e.g. "Tokyo, Japan").
        return { city: a, country: b };
  }

  // 3+ segments: venue(s), city, last.
  const last = segs[segs.length - 1];
      const cs = splitCityState(last);
      if (cs.state) {
              // Last is state-only or City+state-at-end.
        // If state-only, the segment before is city.
        if (!cs.city) {
                  const city = segs[segs.length - 2];
                  const venue = segs.slice(0, -2).join(', ');
                  return { venue, city, state: cs.state };
        }
              // "City ST" already collapsed in last segment.
        const venue = segs.slice(0, -1).join(', ');
              return { venue, city: cs.city, state: cs.state };
      }
      // Last is a country ("Japan", "UK", "Germany")
  const city = segs[segs.length - 2];
      const venue = segs.slice(0, -2).join(', ');
      return { venue, city, country: last };
}

export function reparseEntry(entry: ConcertEntry, knownVenues: Set<string>): ConcertEntry {
      const parsed = parseTaskName(entry.name, knownVenues);
      return {
              ...entry,
              bands: parsed.bands.length ? parsed.bands : entry.bands,
              venue: parsed.venue ?? entry.venue,
              city: parsed.city ?? entry.city,
              state: parsed.state ?? entry.state,
              country: parsed.country ?? entry.country,
      };
}
