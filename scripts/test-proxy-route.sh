#!/usr/bin/env bash
set -euo pipefail

PROXY="${PROXY:-https://roamwise-proxy-971999716773.us-central1.run.app}"

echo "=== Proxy Route Test ==="
echo "Testing: POST $PROXY/api/route"

out="$(curl -s -X POST "$PROXY/api/route" \
  -H 'content-type: application/json' \
  -d '{
    "stops": [
      {"lat": 32.0853, "lon": 34.7818},
      {"lat": 32.1093, "lon": 34.8555}
    ],
    "mode": "drive"
  }')"

echo "Response:"
echo "$out" | jq '.'

# Validate response (proxy should pass through)
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "❌ FAIL: ok != true"; exit 1; }
echo "$out" | jq -e '.distance_m' >/dev/null || { echo "❌ FAIL: distance_m missing"; exit 1; }
echo "$out" | jq -e '.duration_s' >/dev/null || { echo "❌ FAIL: duration_s missing"; exit 1; }

echo "✅ PASS: Proxy route endpoint works"
exit 0
