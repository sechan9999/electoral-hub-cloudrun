// BigQuery data layer for the Electoral Insights Hub.
//
// The app never reads BigQuery at request time: page.tsx imports summaries/*.json
// at build time, and scripts/sync-summaries.ts regenerates those files from
// BigQuery. The builders below are pure functions so scripts/check-parity.ts can
// prove, without a GCP project, that BigQuery rows rebuild the committed JSON
// exactly.
//
// Auth: Application Default Credentials (Cloud Run / Cloud Build service identity;
// locally GOOGLE_APPLICATION_CREDENTIALS).
// Env: GCP_PROJECT (required), BQ_DATASET (default 'electoral_hub').

import type { BigQuery } from '@google-cloud/bigquery';
import type { ElectionRecord, RegionalRecord } from '../types/election';

const PROJECT = process.env.GCP_PROJECT;
const DATASET = process.env.BQ_DATASET ?? 'electoral_hub';

let client: BigQuery | null = null;

export async function getBigQuery(): Promise<BigQuery> {
  if (!PROJECT) throw new Error('GCP_PROJECT env var is required');
  if (!client) {
    // Loaded lazily so the Next build never bundles the client into pages.
    const { BigQuery: BQ } = await import('@google-cloud/bigquery');
    client = new BQ({ projectId: PROJECT });
  }
  return client;
}

const T = (name: string) => `\`${PROJECT}.${DATASET}.${name}\``;

export interface RunInfo {
  runId: string;
  dataHash: string;
  completedAt: string; // ISO string
  dedupDroppedRows: number;
  sourceDesc: string;
}

// ---------- row shapes (one per BigQuery table / query) ----------

export interface ElectionRow {
  election_id: string;
  election_year: number;
  share_basis: 'all_candidates' | 'bloc_pair' | null;
}
export interface CandidateRow {
  election_id: string;
  candidate_no: number;
  label_ko: string;
  bloc: 'Conservative' | 'Democratic' | null;
}
export interface ResultRow {
  election_id: string;
  region_ko: string;
  candidate_no: number;
  total_votes: number;
}
export interface TurnoutRow {
  election_id: string;
  electorate: number;
  votes_cast: number;
}

// ---------- pure builders ----------

/**
 * election_summary.json:
 * [{ Election, Candidates: { label_ko: votes }, 'Total Votes', Voters, Turnout }]
 * Candidates keep ballot order (candidate_no), as in the committed file; the UI sorts.
 */
export function buildElectionSummary(
  elections: ElectionRow[],
  candidates: CandidateRow[],
  results: ResultRow[],
  turnout: TurnoutRow[],
): ElectionRecord[] {
  return [...elections]
    .sort((a, b) => a.election_year - b.election_year)
    .map((e) => {
      const cands = candidates
        .filter((c) => c.election_id === e.election_id)
        .sort((a, b) => a.candidate_no - b.candidate_no);
      const out: Record<string, number> = {};
      let total = 0;
      for (const c of cands) {
        const v = results
          .filter((r) => r.election_id === e.election_id && r.candidate_no === c.candidate_no)
          .reduce((s, r) => s + Number(r.total_votes), 0);
        out[c.label_ko] = v;
        total += v;
      }
      const t = turnout.filter((r) => r.election_id === e.election_id);
      return {
        Election: e.election_id,
        Candidates: out,
        'Total Votes': total,
        Voters: t.reduce((s, r) => s + Number(r.electorate), 0),
        Turnout: t.reduce((s, r) => s + Number(r.votes_cast), 0),
      };
    });
}

/**
 * regional_summary.json: { election: { region_ko: { Conservative, Democratic } } }
 * Denominator follows elections.share_basis:
 *   all_candidates (18–20대) — bloc votes / all candidates' votes in the region
 *   bloc_pair      (21대)    — bloc votes / (Conservative + Democratic) votes
 * Region order follows the order rows arrive in (ORDER BY region_order in SQL).
 */
export function buildRegionalSummary(
  elections: ElectionRow[],
  candidates: CandidateRow[],
  results: ResultRow[],
): Record<string, RegionalRecord> {
  const blocOf = new Map(candidates.map((c) => [`${c.election_id}|${c.candidate_no}`, c.bloc]));
  const out: Record<string, RegionalRecord> = {};
  for (const e of [...elections].sort((a, b) => a.election_year - b.election_year)) {
    const rows = results.filter((r) => r.election_id === e.election_id);
    const regions = [...new Set(rows.map((r) => r.region_ko))];
    const byRegion: RegionalRecord = {};
    for (const region of regions) {
      let all = 0, con = 0, dem = 0;
      for (const r of rows) {
        if (r.region_ko !== region) continue;
        const v = Number(r.total_votes);
        all += v;
        const b = blocOf.get(`${e.election_id}|${r.candidate_no}`);
        if (b === 'Conservative') con += v;
        if (b === 'Democratic') dem += v;
      }
      const denom = e.share_basis === 'bloc_pair' ? con + dem : all;
      byRegion[region] = {
        Conservative: denom > 0 ? con / denom : 0,
        Democratic: denom > 0 ? dem / denom : 0,
      };
    }
    out[e.election_id] = byRegion;
  }
  return out;
}

// ---------- BigQuery fetchers ----------

/** Latest pipeline run — feeds the header's run ID / data hash display. */
export async function fetchLatestRun(): Promise<RunInfo> {
  const [rows] = await (await getBigQuery()).query(
    `SELECT run_id, data_hash, created_at, source_desc, dedup_removed
     FROM ${T('runs')}
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  const r = rows[0];
  if (!r) throw new Error('electoral_hub.runs is empty — run the backfill first');
  const ts = r.created_at?.value ?? r.created_at;
  return {
    runId: String(r.run_id),
    dataHash: String(r.data_hash),
    completedAt: new Date(ts).toISOString(),
    dedupDroppedRows: Number(r.dedup_removed ?? 0),
    sourceDesc: String(r.source_desc ?? ''),
  };
}

async function fetchTables(runId: string) {
  const bq = await getBigQuery();
  const [elections] = await bq.query(
    `SELECT election_id, election_year, share_basis FROM ${T('elections')} ORDER BY election_year`,
  );
  const [candidates] = await bq.query(
    `SELECT election_id, candidate_no, label_ko, bloc FROM ${T('candidates')}`,
  );
  // region_order = first appearance in the source sheet, so JSON key order matches.
  const [results] = await bq.query({
    query: `SELECT election_id, region_ko, candidate_no, total_votes
            FROM ${T('results_region')}
            WHERE run_id = @runId
            ORDER BY election_id, region_order, candidate_no`,
    params: { runId },
  });
  const [turnout] = await bq.query({
    query: `SELECT election_id, electorate, votes_cast FROM ${T('turnout_region')} WHERE run_id = @runId`,
    params: { runId },
  });
  return {
    elections: elections as ElectionRow[],
    candidates: candidates as CandidateRow[],
    results: (results as ResultRow[]).map((r) => ({ ...r, total_votes: Number(r.total_votes) })),
    turnout: (turnout as TurnoutRow[]).map((r) => ({ ...r, electorate: Number(r.electorate), votes_cast: Number(r.votes_cast) })),
  };
}

export async function fetchElectionSummary(runId: string): Promise<ElectionRecord[]> {
  const t = await fetchTables(runId);
  return buildElectionSummary(t.elections, t.candidates, t.results, t.turnout);
}

export async function fetchRegionalSummary(runId: string): Promise<Record<string, RegionalRecord>> {
  const t = await fetchTables(runId);
  return buildRegionalSummary(t.elections, t.candidates, t.results);
}
