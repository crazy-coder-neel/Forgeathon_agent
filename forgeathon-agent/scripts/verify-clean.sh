#!/usr/bin/env bash
# Prints git status of the workspace (default: current dir). Used in the Task C and cancellation demos.
# Usage: bash /path/to/forgeathon-agent/scripts/verify-clean.sh [flask-dir]
cd "${1:-.}" || exit 1
if [ -z "$(git status --porcelain)" ]; then echo "CLEAN: git status shows no changes"; else echo "CHANGED:"; git status --short; fi
