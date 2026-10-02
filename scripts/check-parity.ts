// Proves the BigQuery layer reproduces the dashboard's JSON before anything is deployed.
//
//   npx tsx scripts/check-parity.ts <backfill_csv_dir> <summaries_dir>
//
// Loads the backfill CSVs (exactly what `bq load` puts in BigQuery), runs them through
// the same builders sync-summaries.ts uses, and compares with the committed JSON:
//   1. value + key-order equality (what page.tsx sees after import) — must pass
//   2. raw-byte equality of the files sync would write — reported
// Exits 1 if (1) fails.

import fs from 'fs';
import path from 'path';
import {
  buildElectionSummary,
  buildRegionalSummary,
  type CandidateRow,
  type ElectionRow,
  type ResultRow,
  type TurnoutRow,
} from '../app/lib/bigquery';

const [csvDir = 'bq_backfill', sumDir = 'summaries'] = process.argv.slice(2);

function readCsv(file: string): Record<string, string>[] {
  const [head, ...lines] = fs.readFileSync(path.join(csvDir, file), 'utf-8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map((l) => {
    const v = l.split(','); // backfill CSVs contain no quoted commas
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
}

const elections: ElectionRow[] = readCsv('elections.csv').map((r) => ({
  election_id: r.election_id,
  election_year: Number(r.election_year),
  share_basis: (r.share_basis || null) as ElectionRow['share_basis'],
}));
const candidates: CandidateRow[] = readCsv('candidates.csv').map((r) => ({
  election_id: r.election_id,
  candidate_no: Number(r.candidate_no),
  label_ko: r.label_ko,
  bloc: (r.bloc || null) as CandidateRow['bloc'],
}));
// Same ORDER BY as fetchTables(): election_id, region_order, candidate_no
const results: ResultRow[] = readCsv('results_region.csv')
  .sort(
    (a, b) =>
      a.election_id.localeCompare(b.election_id) ||
      Number(a.region_order) - Number(b.region_order) ||
      Number(a.candidate_no) - Number(b.candidate_no),
  )
  .map((r) => ({ election_id: r.election_id, region_ko: r.region_ko, candidate_no: Number(r.candidate_no), total_votes: Number(r.total_votes) }));
const turnout: TurnoutRow[] = readCsv('turnout_region.csv').map((r) => ({
  election_id: r.election_id,
  electorate: Number(r.electorate),
  votes_cast: Number(r.votes_cast),
}));

let failed = false;
for (const [file, built] of [
  ['election_summary.json', buildElectionSummary(elections, candidates, results, turnout)],
  ['regional_summary.json', buildRegionalSummary(elections, candidates, results)],
] as const) {
  const raw = fs.readFileSync(path.join(sumDir, file), 'utf-8');
  const committed = JSON.parse(raw);
  const sameValue = JSON.stringify(committed) === JSON.stringify(built);
  const sameBytes = raw.trimEnd() === JSON.stringify(built, null, 4);
  console.log(`${file}: values ${sameValue ? 'MATCH' : 'DIFFER'} · bytes ${sameBytes ? 'MATCH' : 'differ'}`);
  if (!sameValue) {
    failed = true;
    const a = JSON.stringify(committed, null, 1).split('\n');
    const b = JSON.stringify(built, null, 1).split('\n');
    const i = a.findIndex((l, k) => l !== b[k]);
    console.log(`  first difference at line ${i}: committed ${a[i]?.trim()} vs built ${b[i]?.trim()}`);
  } else if (!sameBytes) {
    const i = raw.split('\n').findIndex((l, k) => l !== JSON.stringify(built, null, 4).split('\n')[k]);
    console.log(`  byte difference only (line ${i + 1}): ${raw.split('\n')[i]?.trim()}  →  ${JSON.stringify(built, null, 4).split('\n')[i]?.trim()}`);
  }
}
process.exit(failed ? 1 : 0);
