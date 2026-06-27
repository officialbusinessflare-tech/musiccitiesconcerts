#!/usr/bin/env node
/**
 * scripts/fetch-clickup.js
 *
 * Pulls the Concerts and Events ClickUp list, normalizes each task into a
 * ConcertEntry, runs bucket categorization, and writes concerts.json.
 *
 * Usage (local):
 *   CLICKUP_TOKEN=pk_xxx node scripts/fetch-clickup.js
 *   (or)  npm run fetch-data
 *
 * Env:
 *   CLICKUP_TOKEN     required — personal token, starts with "pk_"
 *   CLICKUP_LIST_ID   optional — defaults to the Concerts and Events list
 *
 * This file is plain Node ESM (no TS) so it runs without a build step both
 * locally and inside the Netlify scheduled function via the shared core in
 * netlify/functions/_clickup-core.mjs.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  buildConcertEntries,
  fetchClickUpTasks,
  summarize,
} from '../netlify/functions/_clickup-core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const DEFAULT_LIST_ID = '901413842804';

async function main() {
  const token = process.env.CLICKUP_TOKEN;
  const listId = process.env.CLICKUP_LIST_ID || DEFAULT_LIST_ID;

  if (!token) {
    console.error('ERROR: CLICKUP_TOKEN env var is required.');
    console.error('  Get one from https://app.clickup.com/settings/apps');
    process.exit(1);
  }

  console.log(`Fetching ClickUp list ${listId}...`);
  const tasks = await fetchClickUpTasks({ token, listId });
  console.log(`  Pulled ${tasks.length} raw tasks.`);

  const bucketsPath = resolve(ROOT, 'buckets.config.json');
  const bucketsRaw = await readFile(bucketsPath, 'utf8');
  const bucketsConfig = JSON.parse(bucketsRaw);
  const buckets = bucketsConfig.buckets ?? [];

  const entries = buildConcertEntries(tasks, buckets);
  console.log(`  Kept ${entries.length} entries after filtering.`);

  const output = {
    generatedAt: new Date().toISOString(),
    entries,
  };

  const outPath = resolve(ROOT, 'concerts.json');
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`  Wrote ${outPath}`);

  const summary = summarize(entries, buckets);
  console.log('\nBucket counts:');
  for (const [id, count] of Object.entries(summary)) {
    console.log(`  ${id.padEnd(28)} ${count}`);
  }
}

main().catch((err) => {
  console.error('\nFatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
