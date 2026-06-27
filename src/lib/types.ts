———/**
 * Core types for the Music Cities Concerts dashboard.
 *
 * ConcertEntry is the canonical shape produced by scripts/fetch-clickup.js
 * and consumed by the Astro pages + components. BucketConfig is loaded
 * straight from buckets.config.json — keep them in sync if you edit either.
 */

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export type ConcertEntry = {
    id: string;
    name: string;
    date: string;
    endDate?: string;
    venue?: string;
    city?: string;
    state?: string;
    country?: string;
    bands: string[];
    description?: string;
    ticketUrl?: string;
    priority: Priority;
    isRelease: boolean;
    isPast: boolean;
    clickupUrl: string;
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
    /**
     * True for the "Interesting Elsewhere" catch-all. Fallback buckets only
     * receive entries that didn't match any non-fallback, non-release bucket.
     */
    isFallback?: boolean;
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


/* ----------------------------------------------------------------------------
 * Artist Birthdays
 * -------------------------------------------------------------------------- */

export type BirthdayEntry = {
      id: string;
      /** Raw ClickUp task name, e.g. "Asami Birthday Lovebites". */
      name: string;
      /** Parsed artist/person name. */
      person: string;
      /** Parsed band/affiliation. */
      affiliation?: string;
      /** Original ISO YYYY-MM-DD of the ClickUp due_date (some year). */
      rawDate?: string;
      /** Month (1-12) and day (1-31) extracted from rawDate — the annually-recurring part. */
      month?: number;
      day?: number;
      /** Free-form notes the user added. */
      description?: string;
      /** Free-form flags like "DECEASED" or "UNVERIFIED". */
      status?: string;
      /** ClickUp source URL — internal only, never rendered publicly. */
      clickupUrl: string;
};

export type BirthdaysDataFile = {
      generatedAt: string;
      entries: BirthdayEntry[];
};
