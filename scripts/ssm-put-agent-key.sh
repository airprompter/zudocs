#!/usr/bin/env bash
# Writes the Agent key from the environment into the SSM SecureString the desk API reads at cold start — by
# --cli-input-json from a 0600 temporary file, so the key never appears on a command line, in shell history or
# in CloudTrail's request parameters. Encrypted with the desk stack's key (alias/zudocs-desk), which is why the
# stack deploys first. Prints the parameter's name and version, never the value.
#
#   $ set -a; . ~/.config/zudocs/dev.env; set +a          # AIRPROMPTER_AGENT_KEY into the environment
#   $ AWS_PROFILE=zudocs bash scripts/ssm-put-agent-key.sh              # /zudocs/dev/agent-key
#   $ AWS_PROFILE=zudocs ZUDOCS_ENVIRONMENT=prod bash scripts/ssm-put-agent-key.sh
set -euo pipefail
: "${AIRPROMPTER_AGENT_KEY:?AIRPROMPTER_AGENT_KEY is not set — source the 0600 env file first (never pass a key on argv)}"
environment="${ZUDOCS_ENVIRONMENT:-dev}"
region="${AWS_REGION:-us-east-1}"
name="/zudocs/${environment}/agent-key"
case "$AIRPROMPTER_AGENT_KEY" in
  *" "*|*$'\n'*) echo "the key carries whitespace; refusing" >&2; exit 2 ;;
esac
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
umask 077
node -e '
  const [name, value] = [process.argv[1], process.env.AIRPROMPTER_AGENT_KEY];
  process.stdout.write(JSON.stringify({ Name: name, Type: "SecureString", KeyId: "alias/zudocs-desk", Overwrite: true, Tier: "Standard", Description: "AirPrompter Agent key for the Zudocs desk (read by the desk API at cold start; written by the owner)", Value: value }));
' "$name" > "$dir/put.json"
version="$(aws ssm put-parameter --region "$region" --cli-input-json "file://$dir/put.json" --query Version --output text)"
echo "wrote ${name} (version ${version}, SecureString under alias/zudocs-desk)"
