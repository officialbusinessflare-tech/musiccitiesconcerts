/**
 * Hardened re-parser for ClickUp task names. Mirrors the logic in
 * netlify/functions/_clickup-core.mjs so the dashboard can re-parse stale
 * entries from concerts.json at build time — picking up author-side typos
 * ("Nemophila with Conduit") and venue-name-as-band errors without waiting
 * for the nightly rebuild.
 *
 * Keep this in lock-step with the .mjs version. If you change one, change
 * the other and add a test case for the regression.
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

  // 1. em-dash or en-dash
  const emDash = trimmed.match(/^([^—–]+?)\s*[—–]\s*(.+)$/);
    if (emDash) {
          headlineSegment = emDash[1].trim();
          venuePart = emDash[2].trim();
    } else {
          // 2. venue-introducer word (with / at / @)
      const venueWord = trimmed.match(/^(.+?)\s+(?:with|at|@)\s+(.+)$/i);
          if (venueWord) {
                  headlineSegment = venueWord[1].trim();
                  venuePart = venueWord[2].trim();
          } else {
                  // 3. space-hyphen-space
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

function parseVenueLocation(venuePart: string): {
    venue?: string;
    city?: string;
    state?: string;
    country?: string;
} {
    if (!venuePart) return {};
    const segs = venuePart.split(',').map((s) => s.trim()).filter(Boolean);
    if (segs.length === 0) return {};
    if (segs.length === 1) return { venue: segs[0] };
    if (segs.length === 2) {
          const [a, b] = segs;
          if (/^[A-Z]{2}$/.test(b)) return { venue: a, state: b };
          return { city: a, country: b };
    }
    const last = segs[segs.length - 1];
    const city = segs[segs.length - 2];
    const venue = segs.slice(0, -2).join(', ');
    const result: { venue?: string; city?: string; state?: string; country?: string } = { venue, city };
    if (/^[A-Z]{2}$/.test(last)) result.state = last;
    else result.country = last;
    return result;
}

/**
 * Apply parseTaskName to an existing ConcertEntry, returning a new entry
 * with re-parsed bands/venue/city/state/country fields. Other fields are
 * preserved verbatim.
 */
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
