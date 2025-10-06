#!/usr/bin/env bash
set -euo pipefail

PROXY="${PROXY:-https://roamwise-proxy-971999716773.us-central1.run.app}"

echo "=== Proxy Route Test ==="
echo "Testing: POST $PROXY/api/route"

out="$(curl -s -X POST "$PROXY/api/route" \
  -H 'content-type: application/json' \
  -d '{
    "origin": {"lat": 32.0853, "lon": 34.7818},
    "destination": {"lat": 32.1093, "lon": 34.8555},
    "mode": "drive"
  }')"

echo "Response:"
echo "$out" | jq '.'

# Validate response (proxy should pass through)
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "❌ FAIL: ok != true"; exit 1; }
echo "$out" | jq -e '.route | length > 0' >/dev/null || { echo "❌ FAIL: route missing or empty"; exit 1; }

echo "✅ PASS: Proxy route endpoint works"
exit 0
