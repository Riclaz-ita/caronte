#!/usr/bin/env bash
# apply-prep.sh — stage 1 of the apply pipeline, unattended.
#
# Everything here runs without the candidate and without a model, except the
# triage step, which stops and prints a prompt for the agent to answer.
#
# Usage: ./apply-prep.sh
set -euo pipefail
cd "$(dirname "$0")"

URLS=/tmp/apply-urls.txt
SWEEP=/tmp/apply-liveness.txt

echo "==> 1/5  scanning portals"
node scan.mjs

echo "==> 2/5  liveness sweep"
# `|| true` on the grep: with set -e and pipefail, a pipeline.md with no
# `- [ ]` lines made grep exit 1 and killed the script right here, silently.
grep '^- \[ \]' data/pipeline.md | sed 's/^- \[ \] //' | awk -F' \\| ' '{print $1}' > "$URLS" || true
if [ ! -s "$URLS" ]; then
  echo "Nothing pending in data/pipeline.md — no new postings to prepare."
  echo "Run a scan first, or add URLs to the Pending section by hand."
  exit 0
fi
# check-liveness exits 1 when anything is expired or uncertain, which is the
# normal case, so its status is discarded — but its OUTPUT is not: the expired
# URLs are what step 3 uses to keep dead roles out of the packs.
node check-liveness.mjs --file "$URLS" --throttle | tee "$SWEEP" || true

echo "==> 3/5  importing pending postings into the queue"
node apply-queue.mjs --import-pipeline
node apply-queue.mjs --validate

# Dead on arrival. Without this the sweep filtered nothing: every expired URL
# was imported anyway, then fetched, triaged and rendered into a full pack,
# spending the candidate's --limit on closed postings.
#
# Output format, from check-liveness.mjs: "❌ expired    (api) {url}" — the URL
# is always the last field.
grep '^❌' "$SWEEP" | awk '{print $NF}' | sort -u > /tmp/apply-expired.txt || true
dead=0
while read -r url; do
  [ -n "$url" ] || continue
  slug=$(awk -F'\t' -v u="$url" '$2 == u {print $1; exit}' data/apply-queue.tsv)
  if [ -n "$slug" ]; then
    node apply-queue.mjs --set "$slug" apply=dead < /dev/null
    dead=$((dead + 1))
  fi
done < /tmp/apply-expired.txt
echo "     marked $dead expired posting(s) as dead; they will not reach build-packs."

echo "==> 4/5  fetching job descriptions"
node fetch-jds.mjs --queue data/apply-queue.tsv

echo "==> 5/5  triage batch ready"
echo
echo "Run this next, hand the output to the agent, save the JSON it returns, then:"
echo "  node triage.mjs --batch > /tmp/triage-prompt.txt"
echo "  node triage.mjs --ingest /tmp/verdicts.json"
echo "  node build-packs.mjs --limit 18   # or whatever number you want"
echo "  node apply-session.mjs --next"
