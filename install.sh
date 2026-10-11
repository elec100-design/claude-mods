#!/bin/sh
# Installs (or updates) the five Claude Code mods in ./mods into ~/.claude/skills.
# New Claude Code sessions load them automatically. Existing settings are not touched.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/mods"
DEST="$HOME/.claude/skills"
mkdir -p "$DEST"
for m in context-band job-watch handoff plan-track change-check; do
  if [ ! -f "$SRC/$m/.claude-plugin/plugin.json" ]; then
    echo "missing $SRC/$m (iCloud may not have downloaded it yet)"; exit 1
  fi
  mkdir -p "$DEST/$m"
  rsync -a --delete --exclude '.claude-plugin/types/' "$SRC/$m/" "$DEST/$m/"
  printf "%-13s " "$m"
  if command -v claude >/dev/null 2>&1; then claude plugin validate "$DEST/$m" | tail -1; else echo "copied"; fi
done
echo "done: open a new Claude Code session to load all five mods"
