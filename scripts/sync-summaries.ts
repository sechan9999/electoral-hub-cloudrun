// Regenerates summaries/*.json from BigQuery so app/page.tsx needs no changes.
//
//   npm run sync:summaries            (runs automatically in `npm run build`
//                                      when SYNC_FROM_BIGQUERY=1, see prebuild.mjs)
//
// Requires: GCP_PROJECT (and GOOGLE_APPLICATION_CREDENTIALS when run locally).
// Writes: summaries/election_summary.json, summaries/regional_summary.json,
//         summaries/_run.json (run metadata for the header banner)
// Output keeps the committed files' layout: 4-space indent, UTF-8 Korean keys.

import fs from 'fs';
import path from 'path';
import { fetchLatestRun, fetchElectionSummary, fetchRegionalSummary } from '../app/lib/bigquery';

const OUT_DIR = path.join(process.cwd(), 'summaries');
const write = (name: string, data: unknown) =>
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 4) + '\n');

async function main(): Promise<void> {
  const run = await fetchLatestRun();
  console.log(`latest run: ${run.runId} (hash ${run.dataHash})`);

  const election = await fetchElectionSummary(run.runId);
  const regional = await fetchRegionalSummary(run.runId);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  write('election_summary.json', election);
  write('regional_summary.json', regional);
  write('_run.json', run);

  console.log(`synced ${election.length} elections, ${Object.keys(regional).length} regional cycles -> ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('sync-summaries failed:', err);
  process.exit(1);
});
