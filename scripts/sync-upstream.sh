#!/usr/bin/env bash
# sync-upstream.sh — pull latest XxHuberrr/Mineradio into the english branch, safely.
#
# Usage:  bash scripts/sync-upstream.sh
#
# Model: main = pristine mirror of XxHuberrr/Mineradio (never commit to it).
#        english = our fork's work branch. All changes live here; upstream merges
#        land here, so our changes are never lost.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Fetching upstream =="
git fetch upstream --tags

echo "== Fast-forwarding main to upstream/main =="
git checkout main
if git merge-base --is-ancestor main upstream/main; then
  git merge --ff-only upstream/main
else
  echo "!! local main has diverged from upstream/main — fix manually before syncing"
  exit 1
fi

echo "== Merging into english =="
git checkout english
if git merge main --no-edit; then
  echo "✓ merged cleanly"
else
  cat <<'EOF'
!! Merge conflicts detected. Files in conflict:
EOF
  git diff --name-only --diff-filter=U
  cat <<'EOF'

Resolve each file (ours = english fork features, theirs = upstream update),
then:  git add <files> && git commit
EOF
  exit 2
fi

echo "== Pushing =="
git push origin main english
echo "✓ sync complete"
