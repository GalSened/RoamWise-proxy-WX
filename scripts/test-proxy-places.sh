#!/usr/bin/env bash
set -euo pipefail

PROXY="${PROXY:-https://roamwise-proxy-971999716773.us-central1.run.app}"

echo "=== Proxy Places Test ==="
echo "Testing: GET $PROXY/api/places/search"

out="$(curl -s "$PROXY/api/places/search?query=restaurants&lat=32.0853&lon=34.7818")"

echo "Response:"
echo "$out" | jq '.'

# Validate response
echo "$out" | jq -e '.ok == true' >/dev/null || { echo "❌ FAIL: ok != true"; exit 1; }
echo "$out" | jq -e '.results | length > 0' >/dev/null || { echo "❌ FAIL: results missing or empty"; exit 1; }

echo "✅ PASS: Proxy places endpoint works"
exit 0
