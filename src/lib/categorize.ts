/**
 * Pure bucket-matching logic. Used by both the build-time data fetcher
 * (scripts/fetch-clickup.js, via a JS shim) and any runtime consumers.
 *
 * Most buckets are inclusive — an entry can match multiple buckets. That's
 * the whole point: Nemophila at Conduit Orlando lands in both Florida Metal
 * Scene and Japanese Metal.
 *
 * A bucket marked `matchRules.isFallback: true` is the exception: it ONLY
 * receives an entry if no other non-release bucket matched it. Use this for
 * the "Interesting Elsewhere" catch-all so we don't duplicate Florida/Japan
 * shows there.
 */

import type { BucketConfig, ConcertEntry } from './types.js';

const FESTIVAL_HINTS = ['fest', 'festival', 'open air'];

/**
 * Case-insensitive substring helper.
 */
function includesCi(haystack: string | undefined, needle: string): boolean {
    if (!haystack) return false;
    return haystack.toLowerCase().includes(needle.toLowerCase());
}

function matchesAnyBand(entryBands: string[], bandKeywords: string[]): boolean {
    if (!bandKeywords.length || !entryBands.length) return false;
    const lowered = entryBands.map((b) => b.toLowerCase());
    return bandKeywords.some((kw) => {
          const k = kw.toLowerCase();
          return lowered.some((b) => b.includes(k) || k.includes(b));
    });
}

function matchesAnyVenue(venue: string | undefined, venueKeywords: string[]): boolean {
    if (!venue || !venueKeywords.length) return false;
    return venueKeywords.some((kw) => includesCi(venue, kw));
}

function matchesAnyCity(
    city: string | undefined,
    name: string,
    cityKeywords: string[],
  ): boolean {
    if (!cityKeywords.length) return false;
    return cityKeywords.some((kw) => includesCi(city, kw) || includesCi(name, kw));
}

function looksLikeFestival(name: string): boolean {
    const lower = name.toLowerCase();
    return FESTIVAL_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Try to match an entry against a single bucket's rules.
 * Returns true if the entry belongs to that bucket.
 */
function matchesBucket(entry: ConcertEntry, bucket: BucketConfig): boolean {
    const rules = bucket.matchRules ?? {};

  // Release bucket: only releases land here.
  if (rules.isRelease) {
        return entry.isRelease === true;
  }

  // Festival bucket: name-based heuristic OR explicit venue keyword.
  if (rules.isFestival) {
        if (looksLikeFestival(entry.name)) return true;
        if (matchesAnyVenue(entry.venue, rules.venues ?? [])) return true;
        // Festivals can also still match via city keywords if present.
      if (matchesAnyCity(entry.city, entry.name, rules.cities ?? [])) return true;
        if (matchesAnyBand(entry.bands, rules.bands ?? [])) return true;
        return false;
  }

  // Generic rules — venue, city, band keywords (any one is enough).
  if (matchesAnyVenue(entry.venue, rules.venues ?? [])) return true;
    if (matchesAnyCity(entry.city, entry.name, rules.cities ?? [])) return true;
    if (matchesAnyBand(entry.bands, rules.bands ?? [])) return true;

  return false;
}

/**
 * Return the array of bucket IDs an entry belongs to.
 *
 * Pass 1: non-release, non-fallback buckets get evaluated normally.
 * Pass 2: fallback buckets ONLY match if no buckets matched in pass 1.
 * Pass 3: release buckets evaluate independently (a release can also live
 *         in Japanese Metal, etc., and we still want to surface it here).
 */
export function categorize(entry: ConcertEntry, buckets: BucketConfig[]): string[] {
    const matched: string[] = [];
    let primaryMatched = false;

  // Pass 1 — primary buckets (not fallback, not release-only).
  for (const bucket of buckets) {
        const rules = bucket.matchRules ?? {};
        if (rules.isFallback) continue;
        if (rules.isRelease) continue;
        if (matchesBucket(entry, bucket)) {
                matched.push(bucket.id);
                primaryMatched = true;
        }
  }

  // Pass 2 — fallback buckets, only if pass 1 had nothing.
  if (!primaryMatched) {
        for (const bucket of buckets) {
                const rules = bucket.matchRules ?? {};
                if (!rules.isFallback) continue;
                if (matchesBucket(entry, bucket)) {
                          matched.push(bucket.id);
                }
        }
  }

  // Pass 3 — release buckets evaluated last, independent of the above.
  for (const bucket of buckets) {
        const rules = bucket.matchRules ?? {};
        if (!rules.isRelease) continue;
        if (matchesBucket(entry, bucket)) {
                matched.push(bucket.id);
        }
  }

  return matched;
}

/**
 * Convenience: group already-categorized entries by bucket ID.
 */
export function groupByBucket(
    entries: ConcertEntry[],
    buckets: BucketConfig[],
  ): Map<string, ConcertEntry[]> {
    const groups = new Map<string, ConcertEntry[]>();
    for (const bucket of buckets) groups.set(bucket.id, []);

  for (const entry of entries) {
        for (const bucketId of entry.buckets) {
                const arr = groups.get(bucketId);
                if (arr) arr.push(entry);
        }
  }

  for (const [id, arr] of groups) {
        arr.sort((a, b) => a.date.localeCompare(b.date));
        groups.set(id, arr);
  }

  return groups;
}
