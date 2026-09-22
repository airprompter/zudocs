#!/usr/bin/env bash
# Writes the Agent key from the environment into the SSM SecureString a host reads at start — by --cli-input-json
# from a 0600 temporary file, so the key never appears on a command line, in shell history or in CloudTrail's
# request parameters. In us-east-1 it is encrypted with the desk stack's key (alias/zudocs-desk), which is why
# that stack deploys first; in eu-west-1 the host reads the same parameter name in its own region, encrypted with
# the AWS-managed SSM key (ZUDOCS_SSM_KEY_ID=alias/aws/ssm — no key of ours exists there). Prints the parameter's
# name and version, never the value.
#
# The same path writes a provider key for the desk's provider switch (phase 9): ZUDOCS_SECRET=openai reads
# OPENAI_API_KEY into /zudocs/<environment>/openai-key, ZUDOCS_SECRET=anthropic reads ANTHROPIC_API_KEY into
# …/anthropic-key — us-east-1 only, under the desk's key; the desk Lambda reads them by name on the first run that
# names that provider.
#
#   $ set -a; . ~/.config/zudocs/dev.env; set +a          # AIRPROMPTER_AGENT_KEY into the environment
#   $ AWS_PROFILE=zudocs bash scripts/ssm-put-agent-key.sh                                            # us-east-1: /zudocs/dev/agent-key
#   $ AWS_PROFILE=zudocs AWS_REGION=eu-west-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm bash scripts/ssm-put-agent-key.sh   # the eu-west host's copy
#   $ AWS_PROFILE=zudocs ZUDOCS_ENVIRONMENT=prod bash scripts/ssm-put-agent-key.sh
#   $ AWS_PROFILE=zudocs ZUDOCS_SECRET=anthropic bash scripts/ssm-put-agent-key.sh                     # ANTHROPIC_API_KEY → /zudocs/dev/anthropic-key
set -euo pipefail
secret="${ZUDOCS_SECRET:-agent}"
case "$secret" in
  agent) var="AIRPROMPTER_AGENT_KEY"; suffix="agent-key"; description="AirPrompter Agent key for the Zudocs hosts (read at start by the host in this region; written by the owner)" ;;
  openai) var="OPENAI_API_KEY"; suffix="openai-key"; description="The customer's own OpenAI API key for the Zudocs desk's provider switch (read by the desk Lambda on the first run that names it; written by the owner)" ;;
  anthropic) var="ANTHROPIC_API_KEY"; suffix="anthropic-key"; description="The customer's own Anthropic API key for the Zudocs desk's provider switch (read by the desk Lambda on the first run that names it; written by the owner)" ;;
  *) echo "ZUDOCS_SECRET must be agent, openai or anthropic (got ${secret})" >&2; exit 2 ;;
esac
value="${!var:-}"
: "${value:?${var} is not set — source the 0600 env file first (never pass a key on argv)}"
environment="${ZUDOCS_ENVIRONMENT:-dev}"
region="${AWS_REGION:-us-east-1}"
key_id="${ZUDOCS_SSM_KEY_ID:-alias/zudocs-desk}"
name="/zudocs/${environment}/${suffix}"
case "$value" in
  *" "*|*$'\n'*) echo "the key carries whitespace; refusing" >&2; exit 2 ;;
esac
case "$key_id" in
  alias/*|arn:aws:kms:*|[0-9a-f]*-*) ;;
  *) echo "ZUDOCS_SSM_KEY_ID must be a KMS alias, key id or ARN (got ${key_id})" >&2; exit 2 ;;
esac
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
umask 077
ZUDOCS_PUT_VALUE="$value" node -e '
  const [name, keyId, description] = [process.argv[1], process.argv[2], process.argv[3]];
  process.stdout.write(JSON.stringify({ Name: name, Type: "SecureString", KeyId: keyId, Overwrite: true, Tier: "Standard", Description: description, Value: process.env.ZUDOCS_PUT_VALUE }));
' "$name" "$key_id" "$description" > "$dir/put.json"
version="$(aws ssm put-parameter --region "$region" --cli-input-json "file://$dir/put.json" --query Version --output text)"
echo "wrote ${name} in ${region} (version ${version}, SecureString under ${key_id})"
