#!/bin/bash
# The eu-west host's first boot (cloud-init user data on Amazon Linux 2023, arm64), rendered by the stack from this
# template: every double-underscored placeholder is a value the stack knows (bucket, digest) — never a key. The Agent key
# reaches the host only through the instance role: `zudocs-agent-key` reads the SSM SecureString into the daemon's
# 0600 env file at every daemon start. What this script leaves behind:
#
#   /usr/local/bin/airprompter           the released CLI, verified against the pinned digest before chmod +x
#   /opt/zudocs/                          the worker bundle, the Python worker and its venv, the units (from the asset)
#   /etc/airprompter/{root.jwk.json,root.json,zudocs.env}   the pinned key, the root document it verified, the identifiers (0644)
#   /etc/airprompter/airprompterd.env     the Agent key, root:root 0600, written by zudocs-agent-key
#   /var/lib/airprompter                  the daemon's state (0700, the airprompter user)
#   systemd: airprompterd, zudocs-worker, zudocs-pyworker; the CloudWatch agent shipping /var/log/zudocs/*
#
#   $ bash -n services/eu-host/host/user-data.sh      # the template parses; the stack renders and the test pins the placeholders
set -euo pipefail
exec > >(tee -a /var/log/zudocs-boot.log) 2>&1
echo "zudocs eu-host boot: $(date -u +%FT%TZ)"

# --- swap: a t4g.micro has 1 GiB; the daemon, two workers and pip's resolver want headroom -------------------------
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- packages: Node 22 for the worker and the CLI's peers, Python 3.12 for the LiteLLM worker, git for pip's pins ---
dnf install -y --allowerasing nodejs22 python3.12 python3.12-pip git unzip amazon-cloudwatch-agent
# AL2023 installs the versioned binary (node-22) and leaves `node` to alternatives; the units name one fixed path.
NODE_BIN="$(command -v node-22 || command -v node)"
ln -sf "$NODE_BIN" /usr/local/bin/node
/usr/local/bin/node --version && python3.12 --version

# --- the user and the directories -----------------------------------------------------------------------------------
id airprompter >/dev/null 2>&1 || useradd --system --home-dir /var/lib/airprompter --no-create-home --shell /sbin/nologin airprompter
install -d -o airprompter -g airprompter -m 0700 /var/lib/airprompter
install -d -m 0755 /etc/airprompter /opt/zudocs
install -d -o airprompter -g airprompter -m 0755 /var/log/zudocs

# --- the released CLI, verified before it is executable --------------------------------------------------------------
curl -fsSL --retry 20 --retry-all-errors --retry-delay 5 -o /tmp/airprompter.bin "__CLI_URL__"
echo "__CLI_SHA256__  /tmp/airprompter.bin" | sha256sum -c -
install -m 0755 /tmp/airprompter.bin /usr/local/bin/airprompter
rm -f /tmp/airprompter.bin
/usr/local/bin/airprompter --version

# --- the host bundle from the deployment's asset bucket (the instance role reads exactly this object) ----------------
aws s3 cp "__BUNDLE_S3_URL__" /tmp/eu-host.zip
rm -rf /opt/zudocs/bundle && mkdir -p /opt/zudocs/bundle
unzip -q -o /tmp/eu-host.zip -d /opt/zudocs/bundle
rm -f /tmp/eu-host.zip
install -m 0644 /opt/zudocs/bundle/root.jwk.json /etc/airprompter/root.jwk.json
install -m 0644 /opt/zudocs/bundle/zudocs.env /etc/airprompter/zudocs.env
install -m 0755 /opt/zudocs/bundle/bin/zudocs-agent-key /usr/local/sbin/zudocs-agent-key
install -m 0755 /opt/zudocs/bundle/bin/zudocs-cli /usr/local/bin/zudocs-cli
install -m 0644 /opt/zudocs/bundle/worker.mjs /opt/zudocs/worker.mjs
install -m 0644 /opt/zudocs/bundle/pyworker.py /opt/zudocs/pyworker.py
install -m 0644 /opt/zudocs/bundle/requirements.txt /opt/zudocs/requirements.txt

# --- the root document the daemon trusts: fetched from the environment's root URL and verified against the pinned key
#     for the hosted environment before it is installed (the released daemon drops --hosted-environment for a pinned
#     JWK, so it is handed the verified document instead; docs/EU-WEST.md) ------------------------------------------
. /etc/airprompter/zudocs.env
curl -fsSL --retry 20 --retry-all-errors --retry-delay 5 -o /tmp/root.json "$AIRPROMPTER_ROOT_URL"
/usr/local/bin/node /opt/zudocs/worker.mjs verify-root /tmp/root.json /etc/airprompter/root.jwk.json "$AIRPROMPTER_HOSTED_ENVIRONMENT"
install -m 0644 /tmp/root.json /etc/airprompter/root.json
rm -f /tmp/root.json

# --- the Python worker's venv: the SDK's five distributions by commit pin, LiteLLM, boto3 ---------------------------
python3.12 -m venv /opt/zudocs/venv
/opt/zudocs/venv/bin/pip install --no-cache-dir --upgrade pip >/dev/null
/opt/zudocs/venv/bin/pip install --no-cache-dir -r /opt/zudocs/requirements.txt
/opt/zudocs/venv/bin/python -c 'import importlib.metadata as m, airprompter_agent, litellm; print("python sdk", m.version("airprompter-agent"), "litellm", m.version("litellm"))'
chown -R airprompter:airprompter /opt/zudocs

# --- the CloudWatch agent first, so whatever happens next is in the log group -----------------------------------
install -m 0644 /opt/zudocs/bundle/cloudwatch-agent.json /opt/aws/amazon-cloudwatch-agent/etc/zudocs.json
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/zudocs.json

# --- the units, installed and enabled before the key is fetched: a missing parameter is a daemon that keeps trying
#     (its ExecStartPre reads the parameter at every start), never a host with no units ----------------------------
install -m 0644 /opt/zudocs/bundle/units/airprompterd.service /etc/systemd/system/airprompterd.service
install -m 0644 /opt/zudocs/bundle/units/zudocs-worker.service /etc/systemd/system/zudocs-worker.service
install -m 0644 /opt/zudocs/bundle/units/zudocs-pyworker.service /etc/systemd/system/zudocs-pyworker.service
systemctl daemon-reload
systemctl enable airprompterd.service zudocs-worker.service zudocs-pyworker.service

# --- the Agent key: from SSM into the daemon's env file, root:root 0600 (repeated at every daemon start) -----------
/usr/local/sbin/zudocs-agent-key || echo "zudocs-agent-key: the parameter is not readable yet; the daemon retries it at every start"
systemctl start airprompterd.service zudocs-worker.service zudocs-pyworker.service || true

echo "zudocs eu-host boot done: $(date -u +%FT%TZ)"
systemctl --no-pager --plain status airprompterd zudocs-worker zudocs-pyworker | grep -E "^(●|○|×)|Active:" || true
