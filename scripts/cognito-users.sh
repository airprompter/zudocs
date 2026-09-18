#!/usr/bin/env bash
# The desk's sign-in users, created by hand (the pool has no self-signup): the owner's login, whose temporary
# password Cognito e-mails and which is replaced on first sign-in through the hosted UI; and the proof user,
# whose permanent password comes from the environment (ZUDOCS_PROOF_PASSWORD, never argv — set through
# --cli-input-json from a 0600 temporary file) and is used only by `npm run desk:proof` through the `proof`
# client. Prints usernames and statuses, never a password.
#
#   $ AWS_PROFILE=zudocs bash scripts/cognito-users.sh owner seth@zudocs.com
#   $ ZUDOCS_PROOF_PASSWORD="$(openssl rand -base64 27 | tr -d '/+=' | cut -c1-30)Aa1" AWS_PROFILE=zudocs bash scripts/cognito-users.sh proof proof@zudocs.com
set -euo pipefail
kind="${1:?owner | proof}"
email="${2:?the e-mail address of the user}"
region="${AWS_REGION:-us-east-1}"
pool="${ZUDOCS_USER_POOL_ID:-}"
if [ -z "$pool" ]; then
  pool="$(aws cloudformation describe-stacks --region "$region" --stack-name ZudocsSite --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)"
fi
case "$email" in *@*.*) ;; *) echo "not an e-mail address" >&2; exit 2 ;; esac
case "$kind" in
  owner)
    aws cognito-idp admin-create-user --region "$region" --user-pool-id "$pool" --username "$email" \
      --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
      --desired-delivery-mediums EMAIL --query "User.[Username,UserStatus]" --output text
    echo "Cognito e-mailed a temporary password to ${email}; the first hosted-UI sign-in replaces it."
    ;;
  proof)
    : "${ZUDOCS_PROOF_PASSWORD:?ZUDOCS_PROOF_PASSWORD is not set — generate one into the environment; it is never passed on argv}"
    aws cognito-idp admin-create-user --region "$region" --user-pool-id "$pool" --username "$email" \
      --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
      --message-action SUPPRESS --query "User.[Username,UserStatus]" --output text
    dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT; umask 077
    node -e 'process.stdout.write(JSON.stringify({ UserPoolId: process.argv[1], Username: process.argv[2], Password: process.env.ZUDOCS_PROOF_PASSWORD, Permanent: true }))' "$pool" "$email" > "$dir/pw.json"
    aws cognito-idp admin-set-user-password --region "$region" --cli-input-json "file://$dir/pw.json"
    aws cognito-idp admin-get-user --region "$region" --user-pool-id "$pool" --username "$email" --query "[Username,UserStatus]" --output text
    ;;
  *) echo "kind must be owner or proof" >&2; exit 2 ;;
esac
