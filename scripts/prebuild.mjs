// npm "prebuild" hook. Local builds use the committed summaries/*.json unchanged.
// Docker / Cloud Build sets SYNC_FROM_BIGQUERY=1 to regenerate them from BigQuery first.
import { execSync } from 'node:child_process';

if (process.env.SYNC_FROM_BIGQUERY === '1') {
  console.log('[prebuild] SYNC_FROM_BIGQUERY=1 → syncing summaries from BigQuery');
  execSync('npx tsx scripts/sync-summaries.ts', { stdio: 'inherit' });
} else {
  console.log('[prebuild] using committed summaries/*.json (set SYNC_FROM_BIGQUERY=1 to sync)');
}
