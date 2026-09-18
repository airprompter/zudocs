#!/bin/bash
# One-time account baseline for the Zudocs AWS account: the settings that are
# account-wide rather than stack resources. Idempotent; run from an
# administrator session (Identity Center), never from CI.
#
#   AWS_PROFILE=zudocs bash scripts/account-baseline.sh
#
# What it sets, and why:
#   - S3 Block Public Access at the account level (no bucket can be public, whatever a stack says)
#   - EBS encryption by default in every region the demo uses
#   - IMDSv2 required by default for new instances in those regions
#   - the alternate contacts (security / billing / operations) if ALT_CONTACT_EMAIL is set
# It prints what it did; it never prints a credential.
set -euo pipefail
REGIONS=(us-east-1 eu-west-1 ap-southeast-1)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "account $ACCOUNT"

echo "== S3 Block Public Access (account level)"
aws s3control put-public-access-block --account-id "$ACCOUNT" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3control get-public-access-block --account-id "$ACCOUNT" --query 'PublicAccessBlockConfiguration' --output json

for region in "${REGIONS[@]}"; do
  echo "== $region: EBS encryption by default, IMDSv2 required by default"
  aws ec2 enable-ebs-encryption-by-default --region "$region" --query 'EbsEncryptionByDefault' --output text
  aws ec2 modify-instance-metadata-defaults --region "$region" --http-tokens required --http-put-response-hop-limit 1 --query 'Return' --output text
done

if [ -n "${ALT_CONTACT_EMAIL:-}" ]; then
  echo "== alternate contacts"
  for type in SECURITY BILLING OPERATIONS; do
    aws account put-alternate-contact --alternate-contact-type "$type" --email-address "$ALT_CONTACT_EMAIL" \
      --name "Zudocs ${type,,}" --title "Owner" --phone-number "${ALT_CONTACT_PHONE:-+10000000000}"
    echo "  $type set"
  done
else
  echo "== alternate contacts skipped (set ALT_CONTACT_EMAIL to write them)"
fi
echo "baseline done"
