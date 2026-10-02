# electoral-hub-cloudrun

Electoral Insights Hub(`sechan9999/K18to21Election2`)를 Vercel + 엑셀에서 **Cloud Run + BigQuery**로 옮기는 마이그레이션 키트입니다.

앱은 런타임에 xlsx를 읽지 않습니다. `app/page.tsx`가 `summaries/*.json`을 빌드 시점에 import하므로, 전면 재작성 대신 **동기화 레이어**만 추가합니다. BigQuery에서 JSON을 다시 만들고, `page.tsx`는 그대로 둡니다.

```
K18to21charts.xlsx ──backfill_bigquery.py──▶ CSV ──bq load──▶ BigQuery (electoral_hub)
                                                                   │
                         npm run build (SYNC_FROM_BIGQUERY=1) ◀────┘  sync-summaries.ts
                                   │
                    summaries/*.json ──import──▶ page.tsx (변경 없음) ──▶ Cloud Run
```

## 검증 결과

`npm run backfill && npm run check:parity` (2026-10-02):

| 검사 | 결과 |
|---|---|
| 선거별 후보 득표·총투표·선거인수·투표수 (18–21대) | 기존 JSON과 일치 (21대 34,980,616) |
| `regional_summary.json` | 값 일치, **바이트까지 일치** |
| `election_summary.json` | 값 일치. 바이트 차이는 기존 파일의 `15773128.0`(Python float) 표기뿐이며 JS는 `15773128`로 씁니다. import한 숫자는 같습니다. |
| K18to21Election2 사본에 키트 적용 후 `npm run build` | 성공(prebuild 훅 동작). standalone `server.js` 실행 화면에 run ID `pr-2026-04-22-01`(`_run.json`)과 21대 총계 34,980,616 표시 |

## 초안 `bigquery.ts`에서 고친 두 가지

지역별 득표율이 기존 파일과 맞지 않던 원인입니다.

1. **19대 블록은 후보 한 명씩입니다.** 기존 파일의 Conservative는 홍준표, Democratic은 문재인 단독 득표율입니다(유승민·심상정을 합치면 안 맞음). `candidates.bloc`은 선거마다 두 후보에게만 채웁니다.
2. **21대는 분모가 다릅니다.** 18–20대는 "블록 득표 ÷ 그 지역 전체 후보 득표"인데, 21대는 "블록 득표 ÷ (이재명 + 김문수)"라서 두 값의 합이 1입니다. 초안은 모든 선거에 전체 후보를 분모로 써서 21대가 어긋납니다(예: 강원 Conservative 0.550 vs 기존 0.518). `elections.share_basis`(`all_candidates` | `bloc_pair`) 열로 선거별 규칙을 데이터에 넣었습니다.

그 밖에 `results_region.region_order`로 JSON의 지역 키 순서(21대는 가나다순, 18–20대는 시트 순)를 보존하고, 후보는 투표용지 순(`candidate_no`)으로 내보냅니다.

## 백필할 때 지킬 두 가지

- **지역명은 기존 문자열 그대로.** 18–20대는 `강원도`·`전라북도`, 21대는 `강원특별자치도`·`전북특별자치도`. 백필 스크립트가 원본 시트의 문자열을 그대로 쓰고, 기존 JSON에 없는 지역이 나오면 실패합니다.
- **`candidates.bloc` / `label_ko` 채우기.** `label_ko`는 기존 `Candidates` 키와 바이트 단위로 같아야 합니다(20대 `국가혁명당  허경영`의 공백 두 칸 포함). 스크립트가 시트 헤더를 기존 키에 맞춰 찾고, 못 찾으면 실패합니다.

## 적용 순서 (K18to21Election2에서)

0. **standalone 출력** — `next.config.ts`:
   ```ts
   const nextConfig: NextConfig = { output: 'standalone' };
   ```
1. **파일 복사**
   | 이 키트 | 대상 레포 |
   |---|---|
   | `app/lib/bigquery.ts` | `app/lib/bigquery.ts` |
   | `scripts/sync-summaries.ts`, `scripts/prebuild.mjs`, `scripts/backfill_bigquery.py`, `scripts/check-parity.ts` | `scripts/` |
   | `summaries/_run.json` | `summaries/_run.json` (첫 동기화 전 로컬 빌드용) |
   | `Dockerfile`, `.dockerignore.target` → `.dockerignore` | 루트 |
2. **package.json**
   ```bash
   npm install @google-cloud/bigquery
   ```
   ```json
   "scripts": {
     "prebuild": "node scripts/prebuild.mjs",
     "sync:summaries": "tsx scripts/sync-summaries.ts"
   }
   ```
   로컬 `npm run build`는 커밋된 JSON을 그대로 쓰고, `SYNC_FROM_BIGQUERY=1`일 때만 BigQuery에서 다시 만듭니다.
3. **헤더 run ID** — `app/lib/methodology.ts`의 `LAST_PIPELINE_RUN` 블록을 `patches/methodology-last-pipeline-run.ts`로 바꿉니다(파일 맨 위에 `_run.json` import 추가). 헤더가 읽는 필드는 그대로이고 runId·completedAt·dedup이 `_run.json`에서 옵니다.
4. **BigQuery**
   ```bash
   export PROJECT=your-gcp-project
   bq mk --dataset --location=us-central1 $PROJECT:electoral_hub
   bq query --use_legacy_sql=false < bigquery/schema.sql
   python3 scripts/backfill_bigquery.py --xlsx original_data/K18to21charts.xlsx --summaries summaries --out bq_backfill
   npx tsx scripts/check-parity.ts bq_backfill summaries      # 값이 다르면 exit 1
   for t in runs elections candidates results_region turnout_region; do
     bq load --source_format=CSV --skip_leading_rows=1 $PROJECT:electoral_hub.$t bq_backfill/$t.csv
   done
   ```
   `schema.sql` 맨 아래 쿼리로 선거별 합계를 확인합니다(21대 34,980,616).
5. **빌드·배포 (staging)**
   ```bash
   export REGION=us-central1
   docker build -t ehub:staging . && docker run -p 8080:8080 ehub:staging   # 로컬 확인
   gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT/ehub/app:staging .
   gcloud run deploy ehub-staging \
     --image $REGION-docker.pkg.dev/$PROJECT/ehub/app:staging \
     --region $REGION --allow-unauthenticated \
     --port 8080 --cpu 1 --memory 512Mi --concurrency 80 --min-instances 0 --max-instances 10
   ```
   BigQuery 동기화를 빌드에 넣으려면 `docker build --build-arg SYNC_FROM_BIGQUERY=1 --build-arg GCP_PROJECT=$PROJECT`를 쓰고, Cloud Build 서비스 계정에 `roles/bigquery.dataViewer`, `roles/bigquery.jobUser`를 줍니다.
6. **대조** — staging과 Vercel을 나란히 열고 `?view=compare&election=21st`에서 모든 숫자와 헤더의 run ID를 비교합니다.
7. **비용 가드레일 (공개 트래픽 전)**
   ```bash
   gcloud billing budgets create --billing-account=BILLING_ID \
     --display-name="ehub-monthly" --budget-amount=200USD \
     --threshold-rule=percent=50 --threshold-rule=percent=80 --threshold-rule=percent=100
   ```

전체 체크리스트: [docs/MIGRATION_CHECKLIST.md](docs/MIGRATION_CHECKLIST.md)

## 알아둘 점

- `results_region.sorted_votes` / `recheck_votes`(분류표·재확인표)는 백필에서 비워 둡니다. 원본 시트에 지역별 분류·재확인 값이 없고 대시보드도 쓰지 않습니다. 개표상황표 판독 파이프라인을 올릴 때 채웁니다.
- `runs.data_hash`는 `results_region.csv`의 sha256 앞 8자리입니다. 기존 화면 하단의 "데이터 해시"(ShareBar가 클라이언트에서 계산)와는 다른 값입니다.
- `fixtures/`는 키트 단독 검증용으로 복사한 현재 `summaries/*.json`입니다.
