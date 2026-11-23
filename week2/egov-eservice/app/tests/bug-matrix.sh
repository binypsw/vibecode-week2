#!/usr/bin/env bash
# รันชุด Playwright เต็ม (51 TC) กับเว็บที่เปิด BUG_MODE ทีละชุด (BUGS.md §3 ขั้น 3 และ 5)
#
#   tests/bug-matrix.sh                    # B01..B12 + B03,B07 + B01,B05,B09
#   tests/bug-matrix.sh B03 B03,B07        # เลือกชุดเอง
#   PAR=2 tests/bug-matrix.sh              # จำนวนชุดที่รันพร้อมกัน (ค่าเริ่มต้น 4)
#
# แต่ละชุดใช้ container ของตัวเองจาก image เดียวกับ docker compose (gotham-egov-eservice:latest)
# พอร์ต 3201.. · DB และ log อยู่ data/bug/<ชุด>/ (ใช้เป็น DB_PATH / LOG_PATH ของ TC-NFR-04)
# ผล: pw-report/bug-<ชุด>.json + .log · สรุปด้วย `node tests/bug-matrix-summary.js`
# ต้อง build image ก่อน: TEST_MODE=1 docker compose up --build -d
set -u
cd "$(dirname "$0")/.."
IMAGE=${IMAGE:-gotham-egov-eservice:latest}
PAR=${PAR:-4}
modes=("$@")
if [ ${#modes[@]} -eq 0 ]; then
  modes=(B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 B03,B07 B01,B05,B09)
fi
mkdir -p pw-report data/bug

run_one() {
  local mode=$1 port=$2
  local tag=${mode//,/_}
  local dir=data/bug/$tag
  local name=egov-bug-$(echo "$tag" | tr 'A-Z' 'a-z')
  docker rm -f "$name" >/dev/null 2>&1
  rm -rf "$dir" "test-results-bug/$tag"
  mkdir -p "$dir"
  docker run -d --name "$name" -p "$port:3000" \
    -e TEST_MODE=1 -e BUG_MODE="$mode" -e PORT=3000 -e DB_PATH=/data/egov.db \
    -e BASE_URL="http://localhost:$port" -e TZ=Asia/Bangkok \
    -v "$PWD/$dir:/data" "$IMAGE" sh -c 'node server.js 2>&1 | tee /data/server.log' >/dev/null
  local ok=
  for _ in $(seq 1 60); do
    if curl -s -m 2 "http://localhost:$port/api/health" | grep -q '"ok"'; then ok=1; break; fi
    sleep 1
  done
  if [ -z "$ok" ]; then echo "[$mode] server did not start"; docker logs "$name" | tail -20; docker rm -f "$name" >/dev/null; return 1; fi
  echo "[$mode] $(grep -m1 'BUG_MODE=' "$dir/server.log")"
  BASE_URL="http://localhost:$port" DB_PATH="$dir/egov.db" LOG_PATH="$dir/server.log" \
    PW_JSON="pw-report/bug-$tag.json" \
    npx playwright test --output="test-results-bug/$tag" > "pw-report/bug-$tag.log" 2>&1
  echo "[$mode] $(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)' "pw-report/bug-$tag.log" | tr -s ' ' | tr '\n' ' ')"
  docker rm -f "$name" >/dev/null
}

i=0
for mode in "${modes[@]}"; do
  port=$((3201 + i))
  run_one "$mode" "$port" &
  i=$((i + 1))
  while [ "$(jobs -rp | wc -l)" -ge "$PAR" ]; do sleep 2; done
done
wait
