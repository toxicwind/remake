#!/bin/bash
# smoke.sh — network-free CI checks for remake.
# Compile both TS entrypoints, exercise sorry-explore against a fixture,
# and verify remake.ts's input-validation path (no completions call made).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== compile =="
bun build ./remake.ts ./sorry-explore.ts --outdir /tmp/remake-dist >/dev/null
echo "compile OK"

echo "== sorry-explore fixture =="
OUT=$(bun sorry-explore.ts --file test/fixtures/transcript-sorry.json)
echo "$OUT" | head -3
echo "$OUT" | grep -q "1 failure response" || { echo "FAIL: sorry-explore did not detect the sorry"; exit 1; }
echo "sorry-explore OK"

echo "== remake.ts empty-input validation =="
set +e
echo "" | bun remake.ts >/dev/null 2>&1
code=$?
set -e
[ "$code" -eq 2 ] || { echo "FAIL: remake.ts exit=$code, expected 2"; exit 1; }
echo "remake.ts arg validation OK"

echo "== remake-oracle.sh syntax =="
bash -n remake-oracle.sh
echo "remake-oracle.sh OK"


echo "== sorry-explore classifier fixture =="
OUT2=$(bun sorry-explore.ts --file test/fixtures/transcript-classifier.json)
echo "$OUT2" | head -4
echo "$OUT2" | grep -q "2 failure response" || { echo "FAIL: expected 2 failure responses"; exit 1; }
echo "$OUT2" | grep -q "classifier refusal: 1" || { echo "FAIL: refusal not classified"; exit 1; }
echo "$OUT2" | grep -q "classifier quarantine wrapper: 1" || { echo "FAIL: quarantine wrapper not detected"; exit 1; }
echo "classifier fixture OK"
echo "ALL SMOKE TESTS PASSED"
