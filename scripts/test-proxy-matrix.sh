#!/usr/bin/env bash
set -euo pipefail

PROXY="${PROXY:-https://roamwise-proxy-971999716773.us-central1.run.app}"

echo "=== Proxy Matrix Test ==="
echo "Testing: POST $PROXY/api/route/matrix"

out="$(curl -s -X POST "$PROXY/api/route/matrix" \
  -H 'content-type: application/json' \
  -d '{
    "mode": "drive",
    "points": [
      {"lat": 32.0853, "lon": 34.7818},
      {"lat": 32.1093, "lon": 34.8555}
    ]
  }')"

echo "Response:"
echo "$out" | jq '.'

# Validate response
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "❌ FAIL: ok != true"; exit 1; }
echo "$out" | jq -e '.n == 2' >/dev/null || { echo "❌ FAIL: n != 2"; exit 1; }

echo "✅ PASS: Proxy matrix endpoint works"
exit 0
