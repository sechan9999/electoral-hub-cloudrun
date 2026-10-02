# Vercel → Cloud Run + BigQuery Migration Checklist
**Goal:** move the Electoral Insights Hub off Vercel + Excel workbooks onto Google Cloud.
**Meeting-ready minimum:** a staging Cloud Run URL serving the dashboard from BigQuery (marked ★ below).

## 0. Inventory (half day)
- [ ] List every Vercel route/page and what data each one reads
- [ ] List all env vars in Vercel → plan moves to Secret Manager
- [ ] Inventory Excel workbooks (K21.xlsx etc.): sheets, columns, row counts → BigQuery schema map
- [ ] Note current run-versioning (run ID, data hash) → preserve as `runs` table in BigQuery
- [ ] Record current Vercel build command, Node/Python version, cron jobs

## 1. BigQuery data layer
- [ ] Create project/dataset: `electoral_hub` (region: us-central1 or asia-northeast3)
- [ ] ★ Create core tables: `runs`, `elections`, `results`, `recounts` (partition by election/run)
- [ ] One-time backfill: Excel → CSV → `bq load` into versioned tables
- [ ] Add `run_id` + `data_hash` columns everywhere; dashboard already displays them
- [ ] Rewrite app data reads: file reads → BigQuery client queries
- [ ] Validate: row counts and totals match the Excel sources exactly

## 2. Containerize the app
- [ ] Write multi-stage Dockerfile (slim base, non-root user)
- [ ] ★ `docker build` + run locally; click through every dashboard view
- [ ] Push image to Artifact Registry
- [ ] Move secrets/env to Secret Manager; reference from Cloud Run

## 3. Cloud Run staging ★
- [ ] ★ Deploy service (start: 1 vCPU / 512Mi, concurrency 80, min 0, max 10)
- [ ] ★ Smoke test: compare staging vs Vercel page-by-page (numbers must match)
- [ ] Put the staging URL in the proposal appendix before the meeting

## 4. CI/CD
- [ ] Cloud Build trigger on GitHub push → build → deploy to staging
- [ ] Manual promote step: staging → production service
- [ ] Build logs retained; failed builds notify the team

## 5. Cutover
- [ ] Parity check script: scrape key numbers from Vercel and Cloud Run, diff
- [ ] Point production traffic to Cloud Run (custom domain mapping if needed)
- [ ] Keep Vercel deployment for 2 weeks as instant fallback, then decommission

## 6. Hardening & cost control (reviewers love this)
- [ ] Cloud Logging + Monitoring dashboards; uptime check with alerting
- [ ] ★ Budget alert on the GCP billing account (e.g., 50% / 80% / 100% of expected burn)
- [ ] BigQuery: set slot/query cost guardrails; avoid full-table scans in app queries
- [ ] Cloud Run: set max instances; review cold-start vs min-instance cost tradeoff

## 7. After cutover
- [ ] Update proposal: replace "migrate" language with "migrated" + live Cloud Run URL
- [ ] Document the run-versioned BigQuery pattern for the tally-sheet pipeline (workstream 1)
- [ ] US midterm forecast (workstream 5) reuses the same serving pattern
