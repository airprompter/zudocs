#!/bin/bash
# The air-gapped host's first boot (cloud-init user data on Amazon Linux 2023, arm64), rendered by the airgap stack from
# this template: every double-underscored placeholder is a value the stack knows (the region, the exchange bucket, the
# asset URL, the pinned digests) — never a key. This host has NO route to the internet: nothing here runs dnf, curl to
# the world, or pip. Everything it installs comes through the VPC's S3 gateway endpoint — Node and the released CLI from
# the exchange bucket's tools/ prefix (staged by `npm run airgap:up`, verified here against the pinned digests before
# either is executable), the runtime bundle from the deployment's asset bucket. What this script leaves behind:
#
#   /opt/node, /usr/local/bin/node        Node 22 (the runtime's), from the verified tarball
#   /usr/local/bin/airprompter            the released CLI, verified against the pinned digest before chmod +x
#   /opt/zudocs/                          the runtime bundle, the helpers (from the asset)
#   /etc/airprompter/{root.jwk.json,zudocs.env}   the pinned key, the identifiers and paths (0644; no key, no base URL)
#   /var/lib/airprompter/keys/airgap.key.json     the distribution PRIVATE key, born here (0600, the airprompter user) — never leaves
#   s3://<exchange>/keys/airgap.distribution.pub.json   the public half, the only key object the instance role can write
#   /var/lib/zudocs/probe.json            what the boot measured: an outbound HTTPS connect (times out) and a public name (resolves; a name is not a route)
#   systemd: zudocs-airgap (the runtime), zudocs-airgap-export.timer (export-telemetry to the exchange every five minutes)
#
#   $ bash -n services/airgap/host/user-data.sh      # the template parses; the stack renders and the test pins the placeholders
set -euo pipefail
exec > >(tee -a /var/log/zudocs-boot.log) 2>&1
echo "zudocs airgap boot: $(date -u +%FT%TZ)"
export AWS_DEFAULT_REGION=__REGION__ AWS_REGION=__REGION__
EXCHANGE="s3://__EXCHANGE_BUCKET__"

# --- swap: a t4g.micro has 1 GiB; one Node process and the CLI's single-executable want a little headroom ---------------
if [ ! -f /swapfile ]; then
  fallocate -l 512M /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- the user and the directories -----------------------------------------------------------------------------------
id airprompter >/dev/null 2>&1 || useradd --system --home-dir /var/lib/airprompter --no-create-home --shell /sbin/nologin airprompter
install -d -o airprompter -g airprompter -m 0700 /var/lib/airprompter /var/lib/airprompter/keys
install -d -o airprompter -g airprompter -m 0755 /var/lib/zudocs /var/lib/zudocs/export /var/log/zudocs
install -d -m 0755 /etc/airprompter /opt/zudocs

# --- Node, from the exchange's tools/ prefix through the gateway endpoint, verified before it is extracted ---------------
aws s3 cp "${EXCHANGE}/__TOOLS_PREFIX____NODE_ASSET__" /tmp/node.tar.gz
echo "__NODE_SHA256__  /tmp/node.tar.gz" | sha256sum -c -
rm -rf /opt/node && mkdir -p /opt/node
tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1
rm -f /tmp/node.tar.gz
ln -sf /opt/node/bin/node /usr/local/bin/node
/usr/local/bin/node --version

# --- the released CLI, the same way, verified before it is executable ------------------------------------------------------
aws s3 cp "${EXCHANGE}/__TOOLS_PREFIX____CLI_ASSET__" /tmp/airprompter.bin
echo "__CLI_SHA256__  /tmp/airprompter.bin" | sha256sum -c -
install -m 0755 /tmp/airprompter.bin /usr/local/bin/airprompter
rm -f /tmp/airprompter.bin
/usr/local/bin/airprompter --version

# --- the runtime bundle from the deployment's asset bucket (the instance role reads exactly this object) -------------------
aws s3 cp "__BUNDLE_S3_URL__" /tmp/airgap.zip
rm -rf /opt/zudocs/bundle && mkdir -p /opt/zudocs/bundle
python3 -m zipfile -e /tmp/airgap.zip /opt/zudocs/bundle
rm -f /tmp/airgap.zip
install -m 0644 /opt/zudocs/bundle/root.jwk.json /etc/airprompter/root.jwk.json
# The environment file names the exchange bucket, which is account-qualified and not in git: filled here from the stack.
sed 's#@EXCHANGE_BUCKET@#__EXCHANGE_BUCKET__#' /opt/zudocs/bundle/zudocs.env > /etc/airprompter/zudocs.env
chmod 0644 /etc/airprompter/zudocs.env
grep -q '^EXCHANGE_BUCKET=__EXCHANGE_BUCKET__$' /etc/airprompter/zudocs.env
install -m 0644 /opt/zudocs/bundle/runtime.mjs /opt/zudocs/runtime.mjs
install -m 0644 /opt/zudocs/bundle/runtime.mjs.map /opt/zudocs/runtime.mjs.map
install -m 0755 /opt/zudocs/bundle/bin/zudocs-airgap-export /usr/local/bin/zudocs-airgap-export
install -m 0755 /opt/zudocs/bundle/bin/zudocs-airgap-probe /usr/local/bin/zudocs-airgap-probe
install -m 0755 /opt/zudocs/bundle/bin/zudocs-airgap-keygen /usr/local/sbin/zudocs-airgap-keygen
chown -R airprompter:airprompter /opt/zudocs

# --- the probe: what this host can and cannot reach, measured once and kept for the status document ------------------------
/usr/local/bin/zudocs-airgap-probe /var/lib/zudocs/probe.json || echo "probe: could not be written"
chown airprompter:airprompter /var/lib/zudocs/probe.json 2>/dev/null || true

# --- the distribution keypair, born here: the private half stays at 0600 under the airprompter user; the public half is
#     the one key object the instance role may write to the exchange -------------------------------------------------------
/usr/local/sbin/zudocs-airgap-keygen

# --- the units: the runtime and the export timer ------------------------------------------------------------------------
install -m 0644 /opt/zudocs/bundle/units/zudocs-airgap.service /etc/systemd/system/zudocs-airgap.service
install -m 0644 /opt/zudocs/bundle/units/zudocs-airgap-export.service /etc/systemd/system/zudocs-airgap-export.service
install -m 0644 /opt/zudocs/bundle/units/zudocs-airgap-export.timer /etc/systemd/system/zudocs-airgap-export.timer
systemctl daemon-reload
systemctl enable zudocs-airgap.service zudocs-airgap-export.timer
systemctl start zudocs-airgap.service zudocs-airgap-export.timer

echo "zudocs airgap boot done: $(date -u +%FT%TZ)"
systemctl --no-pager --plain status zudocs-airgap zudocs-airgap-export.timer | grep -E "^(●|○|×)|Active:" || true
