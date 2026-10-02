-- ============================================================
-- Electoral Insights Hub — BigQuery schema
-- Dataset: electoral_hub   (bq mk --dataset --location=us-central1 PROJECT:electoral_hub)
-- Every table that feeds the dashboard carries run_id, so the UI keeps showing
-- "run ID / data hash" exactly as today.
-- Changes vs. the draft schema are marked  -- [kit]
-- ============================================================

CREATE TABLE IF NOT EXISTS electoral_hub.runs (
  run_id        STRING NOT NULL,   -- 'pr-2026-04-22-01'
  data_hash     STRING NOT NULL,   -- first 8 hex of sha256(results_region.csv)
  created_at    TIMESTAMP NOT NULL,
  source_desc   STRING,
  dedup_removed INT64,
  notes         STRING
);

CREATE TABLE IF NOT EXISTS electoral_hub.elections (
  election_id   STRING NOT NULL,   -- '18th' | '19th' | '20th' | '21st'
  election_year INT64 NOT NULL,
  total_votes   INT64,
  electorate    INT64,
  turnout_pct   FLOAT64,
  share_basis   STRING             -- [kit] regional_summary denominator:
                                   --   'all_candidates' (18–20대) | 'bloc_pair' (21대: 이재명+김문수)
);

CREATE TABLE IF NOT EXISTS electoral_hub.candidates (
  election_id  STRING NOT NULL,
  candidate_no INT64  NOT NULL,    -- column order in the source sheet
  name_ko      STRING NOT NULL,
  name_en      STRING,
  party_ko     STRING,
  party_en     STRING,
  color_hex    STRING,
  bloc         STRING,             -- [kit] 'Conservative' | 'Democratic' | NULL (one candidate per bloc)
  label_ko     STRING NOT NULL     -- [kit] exact Candidates key in election_summary.json
                                   --   18–20대 '새누리당 박근혜', 21대 '이재명 (더불어민주당)'
);

CREATE TABLE IF NOT EXISTS electoral_hub.results_region (
  run_id        STRING NOT NULL,
  election_id   STRING NOT NULL,
  region_ko     STRING NOT NULL,   -- exact strings: 18–20대 강원도·전라북도, 21대 강원특별자치도·전북특별자치도
  region_en     STRING,
  region_order  INT64,             -- [kit] key order of regional_summary.json
  candidate_no  INT64  NOT NULL,
  sorted_votes  INT64,             -- 분류표수 (NULL until the tally-sheet pipeline loads it)
  recheck_votes INT64,             -- 재확인표수 (same)
  total_votes   INT64
)
CLUSTER BY election_id, run_id;

CREATE TABLE IF NOT EXISTS electoral_hub.turnout_region (
  run_id      STRING NOT NULL,
  election_id STRING NOT NULL,
  region_ko   STRING NOT NULL,
  region_en   STRING,
  electorate  INT64,
  votes_cast  INT64,
  turnout_pct FLOAT64
)
CLUSTER BY election_id, run_id;

-- ---------- derived views ----------
CREATE OR REPLACE VIEW electoral_hub.v_region_share AS
SELECT
  r.run_id, r.election_id, r.region_ko, r.region_en, r.candidate_no, r.total_votes,
  SAFE_DIVIDE(r.total_votes, SUM(r.total_votes) OVER (
    PARTITION BY r.run_id, r.election_id, r.region_ko)) AS vote_share
FROM electoral_hub.results_region r;

-- ---------- sanity checks (run after bq load) ----------
-- SELECT election_id, SUM(total_votes) AS votes FROM electoral_hub.results_region
-- WHERE run_id = 'pr-2026-04-22-01' GROUP BY election_id ORDER BY election_id;
-- Expected: 18th 30,594,621 · 19th 32,672,175 · 20th 33,760,311 · 21st 34,980,616
