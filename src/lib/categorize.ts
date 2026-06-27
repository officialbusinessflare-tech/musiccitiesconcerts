/**
 * Pure bucket-matching logic. Used by both the build-time data fetcher
 * (scripts/fetch-clickup.js, via a JS shim) and any runtime consumers.
 *
 * Design note: an entry can match multiple buckets. That's the whole point —
 * Nemophila at Conduit Orlando lands in both Florida Metal Scene and
 * Japanese Metal. Don't add early-return logic here.
 */

import type { BucketConfig, ConcertEntry } from './types.js';

const FESTIVAL_HINTS = ['fest', 'festival', 'open air'];

/**
 * Case-insensitive substring helper. Returns true if `needle` appears anywhere
 * in `haystack`. Both args coerced to lowercase before comparing.
 */
function includesCi(haystack: string | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Does any band keyword appear in entry.bands (case-insensitive)?
 *
 * We do an equality-ish check (substring either way) so e.g. "Nemophila"
 * matches "NEMOPHILA" and also matches a bands entry of "Nemophila (JP)".
 */
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
 * Return the array of bucket IDs an entry belongs to. Order matches the order
 * of buckets in the input array (which itself reflects buckets.config.json).
 */
export function categorize(entry: ConcertEntry, buckets: BucketConfig[]): string[] {
  const matched: string[] = [];

  for (const bucket of buckets) {
    const rules = bucket.matchRules ?? {};
    let isMatch = false;

    // Release bucket: only releases land here.
    if (rules.isRelease && entry.isRelease) {
      isMatch = true;
    }

    // Festival bucket: name-based heuristic OR explicit venue keyword.
    if (!isMatch && rules.isFestival) {
      if (looksLikeFestival(entry.name)) isMatch = true;
      if (!isMatch && matchesAnyVenue(entry.venue, rules.venues ?? [])) isMatch = true;
    }

    // Generic rules — venue, city, band keywords.
    if (!isMatch && matchesAnyVenue(entry.venue, rules.venues ?? [])) isMatch = true;
    if (!isMatch && matchesAnyCity(entry.city, entry.name, rules.cities ?? [])) {
      isMatch = true;
    }
    if (!isMatch && matchesAnyBand(entry.bands, rules.bands ?? [])) isMatch = true;

    if (isMatch) matched.push(bucket.id);
  }

  return matched;
}

/**
 * Convenience: group already-categorized entries by bucket ID. Each entry can
 * appear in multiple groups. Entries are returned sorted by date ascending.
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
