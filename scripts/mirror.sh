#!/usr/bin/env bash
# Push this package's own history to its public mirror, github.com/Yumankind/overblast-feedback-web.
#
# The library is developed inside the monorepo, next to the worker that is its other half
# (`worker/src/feedback/`) and the contract both follow (`docs/feedback-reports.md`). The mirror is
# the public face of the same code: `git subtree split` rewrites the package's commits with the
# package directory as the root, deterministically - the same history produces the same commit
# ids - so every push is a fast-forward of the last one. That is also why nothing inside this
# folder may refer to a path outside it: nothing outside it travels.
#
# The `.github/workflows/ci.yml` beside this script is at the PACKAGE root for that reason: after
# the split it is at the repository root, which is the only place GitHub Actions looks. In the
# monorepo it is an inert file that nothing runs.
#
# `MIRROR_REMOTE` and `MIRROR_BRANCH` override the destination.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PREFIX=packages/overblast-feedback-web
REMOTE="${MIRROR_REMOTE:-https://github.com/Yumankind/overblast-feedback-web.git}"
BRANCH="${MIRROR_BRANCH:-main}"
if [ -n "$(git status --porcelain -- "$PREFIX")" ]; then
  echo "mirror: $PREFIX has uncommitted changes; commit them first" >&2
  exit 1
fi
SPLIT="$(git subtree split --prefix="$PREFIX" HEAD 2>/dev/null)"
echo "mirror: $SPLIT -> $REMOTE $BRANCH"
git push "$REMOTE" "$SPLIT:refs/heads/$BRANCH"
