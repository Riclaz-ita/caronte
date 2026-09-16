#!/usr/bin/env bash
# backup-personal.sh — version the user-layer files career-ops deliberately gitignores.
#
# career-ops is open source: everything personal (CV, profile, tuned portals,
# tracker, reports) is gitignored, which also means none of it has any history.
# This copies that layer into its own git repo and commits. Run it whenever.
#
# Usage: ./backup-personal.sh
set -euo pipefail
cd "$(dirname "$0")"
DEST="${CAREER_OPS_BACKUP:-$HOME/Desktop/Lavoro/career-ops-personal}"

[ -d "$DEST/.git" ] || { mkdir -p "$DEST" && git -C "$DEST" init -q && echo "Created backup repo at $DEST"; }

# ponytail: a plain copy list beats a manifest file nobody remembers to update.
PATHS=(
  cv.md cv-brand.md candidate-brief.md article-digest.md voice-dna.md portals.yml
  config/profile.yml modes/_profile.md modes/_custom.md
  data/applications.md data/pipeline.md data/scan-history.tsv
  data/apply-queue.tsv data/answer-bank.md
  cover-base.json cv-variants.yml PRODUCT.md
  reports interview-prep writing-samples jds analyses
  data/status-log.tsv data/follow-ups.md data/contacts.tsv data/blacklist.md
)
for p in "${PATHS[@]}"; do
  [ -e "$p" ] || continue
  mkdir -p "$DEST/$(dirname "$p")"
  cp -R "$p" "$DEST/$(dirname "$p")/"
done
# HTML CV sources only — the PDFs are regenerable and would bloat every commit.
mkdir -p "$DEST/output" && cp output/*.html "$DEST/output/" 2>/dev/null || true

cd "$DEST"
git add -A
if git diff --cached --quiet; then
  echo "No changes since the last backup."
else
  # Identity comes from the user's own git config, so this script carries no
  # personal data and can ship in a public repo as-is.
  git commit -q -m "backup: career-ops personal layer $(date +%Y-%m-%d\ %H:%M)"
  echo "Backed up to $DEST ($(git rev-list --count HEAD) snapshots)"
fi
