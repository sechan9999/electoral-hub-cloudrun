// Replace the LAST_PIPELINE_RUN block in app/lib/methodology.ts with this.
// The header keeps every field it reads today; runId / completedAt / dedup now come
// from summaries/_run.json, which scripts/sync-summaries.ts rewrites on every sync.
// Commit summaries/_run.json (from this kit) so local builds work before the first sync.

import lastRun from '../../summaries/_run.json';

export const LAST_PIPELINE_RUN: PipelineRun & { dataHash: string; sourceDesc: string } = {
  runId: lastRun.runId,
  startedAt: lastRun.completedAt, // BigQuery runs table records completion time only
  completedAt: lastRun.completedAt,
  gitSha: 'repo@main',
  builders: ['bigquery:electoral_hub', 'scripts/sync-summaries.ts'],
  rowsIn: 262_441,
  rowsOut: 261_893,
  dedupDroppedRows: lastRun.dedupDroppedRows,
  dataHash: lastRun.dataHash,
  sourceDesc: lastRun.sourceDesc,
};
