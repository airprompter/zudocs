#!/bin/bash
# The vendoring pull request, step one: refresh the bundle committed under vendored/ from the zudocs-ci Agent on dev
# (a plaintext dev bundle — the dev environment allows it — of the one placeholder slot, so the public repository
# carries a real, signed, verifiable bundle and no Zudocs prompt text), then `diff --against` the bundle that was
# committed before (the block for the pull request's body) and `verify` the new one against the pinned public root
# the way the weekly workflow and the verify action will. The CI agent's key comes from AIRPROMPTER_AGENT_KEY in the
# environment (the owner's 0600 ~/.config/zudocs/ci.env), never argv. Exit 3 when nothing changed (the CLI's own
# `pull --check` verdict), 1 on a refusal.
#
#   $ set -a; . ~/.config/zudocs/ci.env; set +a
#   $ bash scripts/vendor.sh              # writes vendored/zudocs-ci.dev.apbundle(.meta.json), prints the diff for the PR body
#   $ bash scripts/vendor.sh --check      # only: is the committed bundle behind the current generation? (exit 3 when stale)
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CLI="${AIRPROMPTER_CLI:-$ROOT/.bin/airprompter}"
[ -x "$CLI" ] || { echo "the released CLI is not at $CLI (docs/PROMPTS.md)" >&2; exit 2; }
[ -n "${AIRPROMPTER_AGENT_KEY:-}" ] || { echo "AIRPROMPTER_AGENT_KEY is not set (set -a; . ~/.config/zudocs/ci.env; set +a — the zudocs-ci agent's key)" >&2; exit 2; }
node -e 'const c=JSON.parse(require("fs").readFileSync("airprompter.config.json","utf8")); if(!c.ciAgentId) throw new Error("airprompter.config.json: ciAgentId is missing"); for (const [k,v] of Object.entries({ORG:c.organizationId,CI_AGENT:c.ciAgentId,ENV:c.environment,HOSTED:c.hostedEnvironment,ROOT_URL:c.rootUrl,BASE:c.baseUrl})) console.log(`${k}=${v}`)' > "$ROOT/.vendor.env"
# shellcheck disable=SC1091
. "$ROOT/.vendor.env"; rm -f "$ROOT/.vendor.env"
OUT="$ROOT/vendored/zudocs-ci.dev.apbundle"
KEYS="$ROOT/keys/dev.root.jwk.json"
SCOPE=(--org "$ORG" --agent "$CI_AGENT" --environment "$ENV" --hosted-environment "$HOSTED")
mkdir -p "$ROOT/vendored"

if [ "${1:-}" = "--check" ]; then
  [ -f "$OUT.meta.json" ] || { echo "nothing vendored yet"; exit 3; }
  "$CLI" pull "${SCOPE[@]}" --root "$KEYS" --root-url "$ROOT_URL" --base-url "$BASE" --out "$OUT" --check --max-behind 0
  exit $?
fi

PREV=""
if [ -f "$OUT" ]; then PREV="$(mktemp "${TMPDIR:-/tmp}/zudocs-vendored-XXXXXX.apbundle")"; cp "$OUT" "$PREV"; fi
echo "pull → vendored/zudocs-ci.dev.apbundle"
"$CLI" pull "${SCOPE[@]}" --root "$KEYS" --root-url "$ROOT_URL" --base-url "$BASE" --plaintext --out "$OUT" || exit 1
echo
echo "verify (as CI does, no key):"
"$CLI" verify "$OUT" "${SCOPE[@]}" --root "$KEYS" || exit 1
if [ -n "$PREV" ]; then
  echo
  echo "diff --against the previously committed bundle (paste into the pull request's body):"
  echo '```'
  "$CLI" diff "$OUT" "${SCOPE[@]}" --against "$PREV"
  echo '```'
  rm -f "$PREV"
fi
echo
echo "next: git add vendored/ && open the pull request; the verify action runs on it (.github/workflows/vendored.yml)"
