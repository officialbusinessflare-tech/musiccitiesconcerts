/**
 * Core types for the Music Cities Concerts dashboard.
 *
 * ConcertEntry is the canonical shape produced by scripts/fetch-clickup.js
 * and consumed by the Astro pages + components. BucketConfig is loaded
 * straight from buckets.config.json — keep them in sync if you edit either.
 */

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export type ConcertEntry = {
  /** ClickUp task ID. Stable across rebuilds. */
  id: string;
  /** Task name as written in ClickUp (preserves emoji, em-dashes, etc.). */
  name: string;
  /** ISO date YYYY-MM-DD (start date for multi-day entries). */
  date: string;
  /** ISO date YYYY-MM-DD for multi-day festivals. Optional. */
  endDate?: string;
  /** Parsed venue. May be undefined if name parsing failed. */
  venue?: string;
  /** Parsed city. */
  city?: string;
  /** Parsed state (US) or region. */
  state?: string;
  /** Parsed country. */
  country?: string;
  /** Bands extracted from the task name. Index 0 is usually the headliner. */
  bands: string[];
  /** First ~280 chars of markdown_description with markdown stripped. */
  description?: string;
  /** First https:// URL found in the description, if any. */
  ticketUrl?: string;
  /** ClickUp priority bucketed into 4 buckets. */
  priority: Priority;
  /** True if the task name starts with the disc emoji. */
  isRelease: boolean;
  /** Computed at build time from today's date. */
  isPast: boolean;
  /** Direct URL back to the ClickUp task. */
  clickupUrl: string;
  /** Bucket IDs this entry was categorized into. */
  buckets: string[];
};

export type BucketMatchRules = {
  venues?: string[];
  cities?: string[];
  bands?: string[];
  /** True for the festival bucket. Also matches names containing Fest/Festival/Open Air. */
  isFestival?: boolean;
  /** True for the album-releases bucket. Matches entries with isRelease === true. */
  isRelease?: boolean;
};

export type BucketConfig = {
  id: string;
  name: string;
  /** Optional kanji subtitle (currently only Japanese Metal). */
  kanji?: string;
  description: string;
  matchRules: BucketMatchRules;
};

export type BucketsConfigFile = {
  buckets: BucketConfig[];
};

export type ConcertsDataFile = {
  generatedAt: string;
  entries: ConcertEntry[];
};
