#!/usr/bin/env bash
set -euo pipefail

PROXY="${PROXY:-https://roamwise-proxy-971999716773.us-central1.run.app}"

echo "=== Proxy Planner Test ==="
echo "Testing: POST $PROXY/planner/plan-day"

out="$(curl -s -X POST "$PROXY/planner/plan-day" \
  -H 'content-type: application/json' \
  -d '{
    "origin": {"lat": 32.0853, "lon": 34.7818},
    "interests": ["food", "nature"],
    "duration": 8
  }')"

echo "Response:"
echo "$out" | jq '.'

# Validate response
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "❌ FAIL: ok != true"; exit 1; }
echo "$out" | jq -e '.pois | length > 0' >/dev/null || { echo "❌ FAIL: pois missing or empty"; exit 1; }

echo "✅ PASS: Proxy planner endpoint works"
exit 0
