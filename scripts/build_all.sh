#!/bin/sh
# Rebuilds all the game data in order, then spell-checks everything the player can read.
# Usage: sh scripts/build_all.sh [--fresh]
set -e
cd "$(dirname "$0")/.."
python3 scripts/build_players.py "$@"
python3 scripts/pick_images.py "$@"
python3 scripts/build_vault.py "$@"
python3 scripts/spellcheck.py
