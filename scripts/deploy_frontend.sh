#!/usr/bin/env sh
# Deploy the static frontend, then put the working copy back to its default.
#
# `netlify deploy` runs the build command LOCALLY, so scripts/gen_env.sh
# rewrites public/js/env.js with whatever BACKEND_URL is configured. Left
# behind, that base makes every API call cross-origin in local dev and fails
# the same-origin assertion in tests/js/api-base.test.mjs -- which is exactly
# how it was caught, after it happened the second time.
#
# The restore runs on EXIT rather than after the deploy, so a failed deploy
# cannot leave the tree dirty either.
set -eu

cd "$(dirname "$(readlink -f "$0")")/.."

trap 'sh scripts/gen_env.sh' EXIT

netlify deploy --prod --message "${1:-deploy frontend}"
