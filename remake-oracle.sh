#!/bin/bash
# remake-oracle: route clear-memory-and-remake through the oracle market + bidding.
set -euo pipefail
ORACLE=/home/toxic/estate/ranch/squawk/oracle
export REMAKE_ORACLE_ARGS="$*"
INTENT_JSON=$(python3 -c "
import json, sys, os, re
args = os.environ.get(\"REMAKE_ORACLE_ARGS\", \"\").split()
def get_arg(n):
    i = args.index(n) if n in args else -1
    return args[i+1] if i >= 0 and i+1 < len(args) else None
intent = get_arg(\"--prompt\") or \"\"
cleared, pattern = 0, None
if not intent:
    f = get_arg(\"--file\")
    raw = open(f).read() if f else sys.stdin.read()
    SORRY = [(re.compile(\"sorry, i ran into a problem\", re.I), \"RUNTIME_ERROR\"),
             (re.compile(\"sorry, i can.t help\", re.I), \"CLASSIFIER_REFUSAL\"),
             (re.compile(r\"^\s*sorry[,.]\", re.I), \"GENERIC_SORRY\")]
    parsed = json.loads(raw)
    turns = parsed if isinstance(parsed, list) else parsed.get(\"turns\", [])
    items = []
    for t in turns:
        if isinstance(t.get(\"items\"), list): items.extend(t[\"items\"])
        elif t.get(\"role\"): items.append({\"role\": t[\"role\"], \"content\": t.get(\"content\")})
    cleared = len(items)
    for it in reversed(items):
        if str(it.get(\"role\")) != \"assistant\": continue
        txt = str(it.get(\"content\") or \"\")
        for rx, pid in SORRY:
            if rx.search(txt): pattern = pid; break
        if pattern: break
    for it in reversed(items):
        if str(it.get(\"role\")) == \"user\" and str(it.get(\"content\") or \"\").strip():
            intent = str(it[\"content\"]).strip(); break
print(json.dumps({\"intent\": intent[:800], \"cleared\": cleared, \"pattern\": pattern}))
")
INTENT=$(echo "$INTENT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[\"intent\"])")
CLEARED=$(echo "$INTENT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[\"cleared\"])")
PATTERN=$(echo "$INTENT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[\"pattern\"] or \"\")")
if [ -z "$INTENT" ]; then echo "remake-oracle: no intent found" >&2; exit 2; fi
TEXT="TASK: Clear-memory-and-remake recovery. ${PATTERN:+Failure was $PATTERN. }Cleared $CLEARED message(s). Remake intent: $INTENT Verify no sorry-apology."
cd "$ORACLE" && ORACLE_INTAKE=1 /usr/bin/python3 bin/post_intake.py --from remake --text "$TEXT"
