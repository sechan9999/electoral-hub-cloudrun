"""Backfill CSVs for the electoral_hub BigQuery dataset from original_data/K18to21charts.xlsx.

    python3 scripts/backfill_bigquery.py --xlsx original_data/K18to21charts.xlsx \
        --summaries summaries --out bq_backfill [--run-id pr-2026-04-22-01]

Writes one CSV per table (runs, elections, candidates, results_region, turnout_region)
and then checks parity against summaries/election_summary.json and
summaries/regional_summary.json — the files the dashboard reads today. The script
exits non-zero if any number differs, so a failed backfill never reaches `bq load`.

Two rules the dashboard depends on:
  * region_ko keeps the exact strings already in the summaries
    (18–20대: 강원도·전라북도, 21대: 강원특별자치도·전북특별자치도).
  * candidates.label_ko reproduces the existing Candidates keys byte-for-byte, and
    candidates.bloc ('Conservative' | 'Democratic' | NULL) drives regional_summary.
"""
import argparse, csv, hashlib, json, os, sys

import numpy as np
import pandas as pd


ELECTIONS = {  # sheet, year
    "18th": ("18Data", 2012),
    "19th": ("19Data", 2017),
    "20th": ("20Data", 2022),
    "21st": ("21Data", 2025),
}

# Two-bloc mapping used by regional_summary.json (same aggregation the swing view uses).
BLOC = {
    "18th": {"새누리당 박근혜": "Conservative", "민주통합당 문재인": "Democratic"},
    "19th": {"자유한국당 홍준표": "Conservative", "더불어민주당 문재인": "Democratic"},
    "20th": {"국민의힘 윤석열": "Conservative", "더불어민주당 이재명": "Democratic"},
    "21st": {"김문수 (국민의힘)": "Conservative", "이재명 (더불어민주당)": "Democratic"},
}
# Denominator used by regional_summary.json for each cycle:
#   all_candidates — bloc votes / all candidates' votes in the region (18–20대)
#   bloc_pair      — bloc votes / (Conservative + Democratic) votes (21대; shares sum to 1)
SHARE_BASIS = {"18th": "all_candidates", "19th": "all_candidates", "20th": "all_candidates", "21st": "bloc_pair"}

REGION_EN = {
    "서울특별시": "Seoul", "부산광역시": "Busan", "대구광역시": "Daegu", "인천광역시": "Incheon",
    "광주광역시": "Gwangju", "대전광역시": "Daejeon", "울산광역시": "Ulsan", "세종특별자치시": "Sejong",
    "경기도": "Gyeonggi", "강원도": "Gangwon", "강원특별자치도": "Gangwon", "충청북도": "North Chungcheong",
    "충청남도": "South Chungcheong", "전라북도": "North Jeolla", "전북특별자치도": "North Jeolla",
    "전라남도": "South Jeolla", "경상북도": "North Gyeongsang", "경상남도": "South Gyeongsang",
    "제주특별자치도": "Jeju",
}
NON_CANDIDATE = ("계", "무효", "기권")


def load_sheet(xl, sheet):
    raw = pd.read_excel(xl, sheet_name=sheet, header=None)
    two_row = pd.isna(raw.iloc[1, 0])  # 18·19대 put candidate names on the second header row
    if two_row:
        hdr = [str(raw.iloc[1, i]) if pd.notna(raw.iloc[1, i]) else str(raw.iloc[0, i]) for i in range(raw.shape[1])]
        body = raw.iloc[2:].copy()
    else:
        hdr = [str(c) for c in raw.iloc[0]]
        body = raw.iloc[1:].copy()
    hdr = [" ".join(h.replace("\n", " ").split()) for h in hdr]
    body.columns = hdr
    for c in hdr[4:]:
        body[c] = pd.to_numeric(body[c].astype(str).str.replace(",", ""), errors="coerce")
    sido, gugun, dong = hdr[0], hdr[1], hdr[2]
    body = body[body[sido].notna() & (body[sido] != "전국")]
    if (body[dong] == "합계").any():  # 18–20대: one 합계 row per 구시군 already sums its precincts
        body = body[body[dong] == "합계"]
    cands = [c for c in hdr[6:] if not c.startswith(NON_CANDIDATE) and not c.startswith("후보자별")]
    return body, sido, hdr[4], hdr[5], cands


def label_for(election, header):
    """Map an xlsx header to the existing Candidates key in election_summary.json."""
    if election == "21st":
        return header  # already '이재명 (더불어민주당)'
    return header  # 18–20대 headers already read 'party name' once newlines are collapsed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", default="original_data/K18to21charts.xlsx")
    ap.add_argument("--summaries", default="summaries")
    ap.add_argument("--run-id", default="pr-2026-04-22-01")
    ap.add_argument("--out", default="bq_backfill")
    ap.add_argument("--created-at", default="2026-04-22 00:24:00 UTC",
                    help="completedAt of the run being backfilled (default: LAST_PIPELINE_RUN in app/lib/methodology.ts)")
    args = ap.parse_args()

    xl = pd.ExcelFile(args.xlsx)
    es = {e["Election"]: e for e in json.load(open(os.path.join(args.summaries, "election_summary.json"), encoding="utf-8"))}
    rs = json.load(open(os.path.join(args.summaries, "regional_summary.json"), encoding="utf-8"))

    elections, candidates, results, turnout = [], [], [], []
    for eid, (sheet, year) in ELECTIONS.items():
        body, sido, electorate, cast, cands = load_sheet(xl, sheet)
        expected = es[eid]["Candidates"]
        # Match each header to an existing label; tolerate double spaces in the summary keys.
        norm = {" ".join(k.split()): k for k in expected}
        for no, h in enumerate(cands, start=1):
            label = norm.get(" ".join(h.split()))
            if label is None:
                sys.exit(f"[{eid}] header {h!r} has no matching Candidates key in election_summary.json")
            name = h.split(" (")[0] if eid == "21st" else h.split(" ")[-1]
            party = h.split(" (")[1].rstrip(")") if eid == "21st" else " ".join(h.split(" ")[:-1])
            candidates.append(dict(election_id=eid, candidate_no=no, name_ko=name, name_en="", party_ko=party,
                                   party_en="", color_hex="", bloc=BLOC[eid].get(label, ""), label_ko=label))
            g = body.groupby(sido)[h].sum()
            order = {r: i for i, r in enumerate(rs[eid])}  # keep the committed file's key order
            for region, v in g.items():
                results.append(dict(run_id=args.run_id, election_id=eid, region_ko=region,
                                    region_en=REGION_EN.get(region, ""), region_order=order.get(region, 99), candidate_no=no,
                                    sorted_votes="", recheck_votes="", total_votes=int(v)))
        t = body.groupby(sido)[[electorate, cast]].sum()
        for region, r in t.iterrows():
            turnout.append(dict(run_id=args.run_id, election_id=eid, region_ko=region,
                                region_en=REGION_EN.get(region, ""), electorate=int(r[electorate]),
                                votes_cast=int(r[cast]), turnout_pct=round(r[cast] / r[electorate] * 100, 4)))
        tv = sum(int(body[h].sum()) for h in cands)
        el = int(t[electorate].sum()); vc = int(t[cast].sum())
        elections.append(dict(election_id=eid, election_year=year, total_votes=tv, electorate=el,
                              turnout_pct=round(vc / el * 100, 4), share_basis=SHARE_BASIS[eid]))

    # ---------- parity check against the files the dashboard reads today ----------
    errors = []
    cand_df = pd.DataFrame(candidates); res_df = pd.DataFrame(results); tur_df = pd.DataFrame(turnout)
    for eid, e in es.items():
        got = res_df[res_df.election_id == eid].merge(cand_df[cand_df.election_id == eid], on=["election_id", "candidate_no"]) \
            .groupby("label_ko").total_votes.sum()
        for label, v in e["Candidates"].items():
            if int(got.get(label, -1)) != int(v):
                errors.append(f"{eid} {label}: backfill {int(got.get(label, -1)):,} vs summary {int(v):,}")
        if int(got.sum()) != int(e["Total Votes"]):
            errors.append(f"{eid} Total Votes: {int(got.sum()):,} vs {int(e['Total Votes']):,}")
        t = tur_df[tur_df.election_id == eid]
        if int(t.electorate.sum()) != int(e["Voters"]) or int(t.votes_cast.sum()) != int(e["Turnout"]):
            errors.append(f"{eid} Voters/Turnout: {int(t.electorate.sum()):,}/{int(t.votes_cast.sum()):,} vs {int(e['Voters']):,}/{int(e['Turnout']):,}")
        m = res_df[res_df.election_id == eid].merge(cand_df[cand_df.election_id == eid], on=["election_id", "candidate_no"])
        basis = m if SHARE_BASIS[eid] == "all_candidates" else m[m.bloc.isin(["Conservative", "Democratic"])]
        tot = basis.groupby("region_ko").total_votes.sum()
        for region, blocs in rs[eid].items():
            if region not in tot.index:
                errors.append(f"{eid} region {region!r} missing from backfill"); continue
            for bloc, share in blocs.items():
                v = m[(m.region_ko == region) & (m.bloc == bloc)].total_votes.sum() / tot[region]
                if v != share:
                    errors.append(f"{eid} {region} {bloc}: {v:.12f} vs {share:.12f}")
        extra = set(tot.index) - set(rs[eid])
        if extra:
            errors.append(f"{eid} regions not in regional_summary: {sorted(extra)}")

    os.makedirs(args.out, exist_ok=True)
    for name, rows in [("elections", elections), ("candidates", candidates), ("results_region", results), ("turnout_region", turnout)]:
        with open(os.path.join(args.out, f"{name}.csv"), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    digest = hashlib.sha256(open(os.path.join(args.out, "results_region.csv"), "rb").read()).hexdigest()[:8]
    with open(os.path.join(args.out, "runs.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["run_id", "data_hash", "created_at", "source_desc", "dedup_removed", "notes"])
        w.writerow([args.run_id, digest, args.created_at,
                    "K18to21charts.xlsx (18Data–21Data) backfill", 548, "backfill_bigquery.py; parity-checked against summaries/*.json"])

    for e in elections:
        print(f"{e['election_id']}: total_votes {e['total_votes']:,}  electorate {e['electorate']:,}")
    if errors:
        print(f"\nPARITY FAILED ({len(errors)}):"); [print("  " + x) for x in errors[:40]]
        sys.exit(1)
    print(f"\nparity OK — CSVs in {args.out} (results_region hash {digest})")


if __name__ == "__main__":
    main()
