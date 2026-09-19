#!/bin/bash
# The recorded terminal strip (beat 9 and the two laptop drills of beat 5): the released CLI against dev on this
# laptop, every command run for real and its output captured to docs/strips/*.txt, then scanned for anything
# key-shaped before it can be committed. The Agent key comes from AIRPROMPTER_AGENT_KEY in the environment (the
# owner's 0600 file), never argv; the strip shows the commands and what they printed, never a key — the CLI prints
# none at any verbosity, and the scan refuses `apa_`, `apr_`, `eyJ` and an env dump all the same.
#
# What it records:
#   docs/strips/cli.txt          keygen · pull (plaintext, dev) · verify · pull --check --max-behind · diff --against
#                                the previous strip's bundle · apply (two generations) · status · rollback · unlock
#                                (refused: nothing staged) · policy show/set · apply under unlock_required → staged ·
#                                unlock --generation · apply --force (a forced downgrade, stamped) · doctor ·
#                                export-telemetry · telemetry verify · telemetry validate (a spool-writer segment)
#   docs/strips/apply-window.txt the SDK's apply.window on a laptop store: staged under unlock_required, activated
#                                on its own when the window opens (scripts/strips/apply-window.mjs)
#
#   $ set -a; . ~/.config/zudocs/dev.env; set +a
#   $ bash scripts/strip.sh                  # ~3 minutes; writes docs/strips/cli.txt and docs/strips/apply-window.txt
#   $ bash scripts/strip.sh --scan-only      # only the secret scan over docs/strips/*.txt
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CLI="${AIRPROMPTER_CLI:-$ROOT/.bin/airprompter}"
STRIPS="$ROOT/docs/strips"
mkdir -p "$STRIPS"

scan() {
  # Anything key-shaped or an environment dump fails the strip; the CLI never prints these, so a hit is a bug here.
  if grep -nE 'apa_[A-Za-z0-9_]{6,}|apr_[A-Za-z0-9_]{6,}|eyJ[A-Za-z0-9_-]{20,}|AIRPROMPTER_AGENT_KEY=|AIRPROMPTER_SESSION_TOKEN=|AWS_SECRET_ACCESS_KEY|BEGIN (RSA|EC|OPENSSH) PRIVATE|"d":"' "$STRIPS"/*.txt; then
    echo "scan: a strip carries something key-shaped (above); not committing it" >&2
    return 1
  fi
  echo "scan: docs/strips/*.txt carry nothing key-shaped"
}
if [ "${1:-}" = "--scan-only" ]; then scan; exit $?; fi

if [ -z "${AIRPROMPTER_AGENT_KEY:-}" ]; then echo "AIRPROMPTER_AGENT_KEY is not set (set -a; . ~/.config/zudocs/dev.env; set +a)" >&2; exit 2; fi
if [ ! -x "$CLI" ]; then echo "the released CLI is not at $CLI (docs/PROMPTS.md)" >&2; exit 2; fi
node -e 'const c=JSON.parse(require("fs").readFileSync("airprompter.config.json","utf8")); for (const [k,v] of Object.entries({ORG:c.organizationId,AGENT:c.agentId,ENV:c.environment,HOSTED:c.hostedEnvironment,ROOT_URL:c.rootUrl,BASE:c.baseUrl,POINTER:c.edgePointerUrl})) console.log(`${k}=${v}`)' > "$ROOT/.strip.env"
# shellcheck disable=SC1091
. "$ROOT/.strip.env"; rm -f "$ROOT/.strip.env"
KEYS="$ROOT/keys/dev.root.jwk.json"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/zudocs/strips"
mkdir -p "$CACHE"
TMP="${TMPDIR:-/tmp}"; WORK="$(mktemp -d "${TMP%/}/zudocs-strip-XXXXXX")"
STATE="$WORK/state"
OUT="$STRIPS/cli.txt"
# Two scopes: the commands that take a root (pull, verify, apply, diff, doctor) also take --hosted-environment; the
# store commands (status, unlock, rollback, policy) take the agent and environment only.
SCOPE=(--org "$ORG" --agent "$AGENT" --environment "$ENV" --hosted-environment "$HOSTED")
STORE=(--agent "$AGENT" --environment "$ENV")

: > "$OUT"
say() { printf '%s\n' "$*" | tee -a "$OUT"; }
run() {
  # Print the command as typed (the key is in the environment, not on the line), then its output, then the exit code.
  say ""
  say "\$ airprompter $(printf "%s " "$@" | sed -e "s#$WORK#<work>#g" -e "s#$ROOT#.#g")"
  "$CLI" "$@" 2>&1 | sed -e "s#$WORK#<work>#g" -e "s#$CACHE#<cache>#g" -e "s#$ROOT#.#g" -e 's#"grant":"[^"]*"#"grant":"<grant id>"#g' | tee -a "$OUT"
  local rc=${PIPESTATUS[0]}
  say "(exit $rc)"
  return 0
}
say "# The Zudocs CLI strip — airprompter $("$CLI" --version 2>/dev/null | head -1) against dev, $(date -u +%FT%TZ), recorded by scripts/strip.sh"
say "# The Agent key is in the environment (AIRPROMPTER_AGENT_KEY); nothing printed below is a key."
say "# Scope: --org $ORG --agent $AGENT --environment $ENV (paths shortened)."

run keygen --purpose distribution --out "$WORK/laptop" --allow-worktree
run pull "${SCOPE[@]}" --root "$KEYS" --root-url "$ROOT_URL" --base-url "$BASE" --plaintext --out "$WORK/current.apbundle"
run verify "$WORK/current.apbundle" "${SCOPE[@]}" --root "$KEYS"
run pull "${SCOPE[@]}" --root "$KEYS" --root-url "$ROOT_URL" --base-url "$BASE" --out "$WORK/current.apbundle" --check --max-behind 1
GEN="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).generation)' "$WORK/current.apbundle.meta.json")"
PREV="$(ls "$CACHE"/gen-*.apbundle 2>/dev/null | sort -t- -k2 -n | tail -1)"
cp "$WORK/current.apbundle" "$CACHE/gen-$GEN.apbundle"; cp "$WORK/current.apbundle.meta.json" "$CACHE/gen-$GEN.apbundle.meta.json"
if [ -n "$PREV" ] && [ "$PREV" != "$CACHE/gen-$GEN.apbundle" ]; then
  cp "$PREV" "$WORK/previous.apbundle"
  run diff "$WORK/current.apbundle" "${SCOPE[@]}" --against "$WORK/previous.apbundle"
  run apply "$WORK/previous.apbundle" "${SCOPE[@]}" --root "$KEYS" --state-dir "$STATE"
else
  say ""
  say "# (no earlier generation in the cache yet: diff --against and the forced downgrade need a second strip run)"
fi
run apply "$WORK/current.apbundle" "${SCOPE[@]}" --root "$KEYS" --state-dir "$STATE"
run status "${STORE[@]}" --state-dir "$STATE"
if [ -f "$WORK/previous.apbundle" ]; then
  run rollback "${STORE[@]}" --state-dir "$STATE"
  run status "${STORE[@]}" --state-dir "$STATE"
fi
run unlock "${STORE[@]}" --state-dir "$STATE"
run policy show "${STORE[@]}" --state-dir "$STATE"
run policy set unlock_required "${STORE[@]}" --state-dir "$STATE" --by "the strip"
if [ -f "$WORK/previous.apbundle" ]; then
  # Under unlock_required the newer bundle stages; the operator's unlock names the generation a change ticket would.
  run apply "$WORK/current.apbundle" "${SCOPE[@]}" --root "$KEYS" --state-dir "$STATE"
  run unlock "${STORE[@]}" --state-dir "$STATE" --generation "$GEN"
  run status "${STORE[@]}" --state-dir "$STATE"
  run apply "$WORK/previous.apbundle" "${SCOPE[@]}" --root "$KEYS" --state-dir "$STATE"
  run apply "$WORK/previous.apbundle" "${SCOPE[@]}" --root "$KEYS" --state-dir "$STATE" --force
  run status "${STORE[@]}" --state-dir "$STATE"
fi
run policy set auto "${STORE[@]}" --state-dir "$STATE" --by "the strip"
run doctor "${SCOPE[@]}" --root "$KEYS" --base-url "$BASE" --edge-pointer-url "$POINTER" --state-dir "$STATE"
run export-telemetry "${SCOPE[@]}" --state-dir "$STATE" --out "$WORK/laptop.aptelemetry"
run telemetry verify --budget 4194304 --sink-absent
say ""
say "\$ node scripts/ci-telemetry-validate.mjs      # a spool-writer segment through airprompter telemetry validate"
AIRPROMPTER_CLI="$CLI" node "$ROOT/scripts/ci-telemetry-validate.mjs" 2>&1 | sed -e "s#${TMPDIR:-/tmp}[^ ]*zudocs-spool-[A-Za-z0-9]*#<scratch>#g" | tee -a "$OUT"

# The apply.window strip: the SDK on a laptop store, staged under unlock_required, activated when the window opens.
say ""
say "# apply.window: see docs/strips/apply-window.txt"
node "$ROOT/scripts/strips/apply-window.mjs" --state-dir "$WORK/window" 2>&1 | sed -e 's#"grant":"[^"]*"#"grant":"<grant id>"#g' > "$STRIPS/apply-window.txt"
echo "apply-window exit ${PIPESTATUS[0]} → docs/strips/apply-window.txt ($(wc -l < "$STRIPS/apply-window.txt" | tr -d ' ') lines)"
rm -rf "$WORK"
scan
