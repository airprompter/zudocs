"""The Zudocs Python worker on the eu-west host: the public Python SDK (``airprompter-agent``) attached to the same
``airprompterd`` as the Node worker — one daemon, one store, one key that no worker holds — running one ticket every
two hours idle (every five minutes while the demo-mode parameter it reads every minute says on; the same fail-closed
rules as the Node worker's ``demoMode.ts``) through LiteLLM to Bedrock (Converse, the instance role's credentials): ``support.reply`` rendered
with ``customer_tier`` from the desk's own table, the model called with the release's inference settings, the
observation filed by the SDK's LiteLLM callback, the declared checks run, feedback from their verdicts, the record
written to the desk's runs table with ``host: eu-west-1/ec2`` and the Python SDK's name, and this process's part of
the host's status row (``python``) every thirty seconds. Waits for the daemon's socket, and for the daemon to serve a
generation (on a fresh host the first release lands staged for the desk to approve; an SDK cannot attach before
that — the Node worker minds the approval), before it starts the SDK; exits 3 without a daemon (systemd retries).
Logs JSON lines with ids and counts — never a render, a ticket or an answer.

    $ /opt/zudocs/venv/bin/python /opt/zudocs/pyworker.py      # as the airprompter user, zudocs.env in the environment
"""

from __future__ import annotations

import json
import os
import random
import signal
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

import boto3
import litellm
from airprompter_agent import AirPrompterAgent, SDK_NAME
from airprompter_agent.integrations.litellm import AirPrompterLiteLLMCallback, litellm_inference, litellm_metadata
from airprompter_agent_core import SDK_VERSION
from airprompter_agent_sync.sync.daemon import DaemonClient, daemon_socket_path
from airprompter_agent_telemetry.spool.writer import Observation

# The models this worker can call and how LiteLLM names them on Bedrock's Converse API. The release's name is the
# only one the code writes on a record; a release pinned to a model outside this map is refused visibly (Luna goes
# through Bedrock's OpenAI-shaped endpoint, which LiteLLM does not speak — the Node worker's path).
BEDROCK_CONVERSE = {
    "amazon.nova-2-lite": "us.amazon.nova-2-lite-v1:0",
    "amazon.nova-micro": "us.amazon.nova-micro-v1:0",
    "anthropic.claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
}
MODELS = ["amazon.nova-2-lite", "amazon.nova-micro", "openai.gpt-5-6-luna", "anthropic.claude-haiku-4-5"]
USD_PER_MILLION = {"amazon.nova-2-lite": (0.3, 2.5), "amazon.nova-micro": (0.035, 0.14), "anthropic.claude-haiku-4-5": (1.0, 5.0)}
REPLY_TAG = "support.reply"
WORKER_VERSION = "0.1.0"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(**event: Any) -> None:
    sys.stdout.write(json.dumps({"at": now_iso(), "source": "zudocs-pyworker", **event}, default=str) + "\n")
    sys.stdout.flush()


def need(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"host env: {name} is missing")
    return value


DEMO_MODE_MAX_HOURS = 4


def parse_demo_mode(text: Optional[str], now: float) -> dict[str, Any]:
    """The demo-mode parameter's text as the workers read it (the Node side's ``parseDemoMode``, the same rules):
    on only when the document parses, says on, carries an ``until`` still ahead and no further than the cap."""
    off = {"mode": "off", "until": None, "by": None, "reason": None}
    if text is None or not text.strip():
        return {**off, "reason": "absent"}
    try:
        doc = json.loads(text)
    except ValueError:
        return {**off, "reason": "unparseable"}
    if not isinstance(doc, dict):
        return {**off, "reason": "unparseable"}
    by = doc.get("by").strip()[:120] if isinstance(doc.get("by"), str) and doc.get("by").strip() else None
    if doc.get("mode") == "off":
        return {"mode": "off", "until": None, "by": by, "reason": None}
    if doc.get("mode") != "on":
        return {**off, "by": by, "reason": "unknown_mode"}
    until_text = doc.get("until")
    try:
        until = datetime.fromisoformat(str(until_text).replace("Z", "+00:00")).timestamp() if isinstance(until_text, str) else None
    except ValueError:
        until = None
    if until is None:
        return {**off, "by": by, "reason": "no_expiry"}
    until_iso = datetime.fromtimestamp(until, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if until <= now:
        return {"mode": "off", "until": until_iso, "by": by, "reason": "expired"}
    if until - now > DEMO_MODE_MAX_HOURS * 3600 + 60:
        return {**off, "by": by, "reason": "too_long"}
    return {"mode": "on", "until": until_iso, "by": by, "reason": None}


def plain(value: Any) -> Any:
    """DynamoDB's Decimals back to numbers, recursively (the document client's marshalling in reverse)."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [plain(v) for v in value]
    return value


def marshal(value: Any) -> Any:
    """Floats to Decimals for boto3's resource layer; None and the rest as they are."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: marshal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [marshal(v) for v in value]
    return value


class Tables:
    """The desk's tables in us-east-1 through boto3's resource layer; the same rows the Node side writes."""

    def __init__(self, region: str) -> None:
        self.lock = threading.Lock()
        ddb = boto3.resource("dynamodb", region_name=region)
        self.tickets = ddb.Table(need("TICKETS_TABLE"))
        self.customers = ddb.Table(need("CUSTOMERS_TABLE"))
        self.runs = ddb.Table(need("RUNS_TABLE"))
        self.feedback = ddb.Table(need("FEEDBACK_TABLE"))
        self.status = ddb.Table(need("STATUS_TABLE"))
        self.events = ddb.Table(need("EVENTS_TABLE"))
        self.counters = ddb.Table(need("COUNTERS_TABLE"))

    def list_tickets(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {}
        while True:
            page = self.tickets.scan(**kwargs)
            items.extend(plain(page.get("Items", [])))
            if "LastEvaluatedKey" not in page:
                return sorted(items, key=lambda t: t["ticketId"])
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def get_customer(self, customer_id: str) -> Optional[dict[str, Any]]:
        # The SDK calls a variable source on a worker thread; boto3's resource objects are not thread-safe, so one lookup at a time.
        with self.lock:
            return plain(self.customers.get_item(Key={"customerId": customer_id}).get("Item"))

    def take_run_slot(self, day: str, cap: int) -> tuple[bool, int]:
        try:
            out = self.counters.update_item(Key={"pk": f"day#{day}"}, UpdateExpression="ADD runs :one", ConditionExpression="attribute_not_exists(runs) OR runs < :cap", ExpressionAttributeValues={":one": 1, ":cap": cap}, ReturnValues="ALL_NEW")
            return True, int(out["Attributes"]["runs"])
        except self.counters.meta.client.exceptions.ConditionalCheckFailedException:
            current = self.counters.get_item(Key={"pk": f"day#{day}"}).get("Item") or {}
            return False, int(current.get("runs", cap))

    def append_event(self, event: dict[str, Any]) -> None:
        at = event["at"]
        item = {"day": at[:10], "sk": f"{at}#{random.randbytes(3).hex()}", "expiresAt": int(datetime.fromisoformat(at.replace('Z', '+00:00')).timestamp()) + 14 * 86400, **event}
        self.events.put_item(Item=marshal(item))

    def put_run(self, record: dict[str, Any]) -> None:
        self.runs.put_item(Item=marshal(record))

    def update_last_run(self, ticket_id: str, last_run: dict[str, Any]) -> None:
        self.tickets.update_item(Key={"ticketId": ticket_id}, UpdateExpression="SET lastRun = :r", ConditionExpression="attribute_exists(ticketId)", ExpressionAttributeValues={":r": marshal(last_run)})

    def put_feedback(self, row: dict[str, Any]) -> None:
        self.feedback.put_item(Item=marshal(row))

    def merge_status(self, host_id: str, python: dict[str, Any]) -> None:
        self.status.update_item(Key={"hostId": host_id}, UpdateExpression="SET python = :p", ExpressionAttributeValues={":p": marshal(python)})


class ReleaseNamedCallback(AirPrompterLiteLLMCallback):
    """The SDK's LiteLLM callback, with one change: the observation is filed under the release's model name (the
    metadata's) rather than the wire's ``bedrock/…`` id the callback prefers — so the window lands on the model the
    version pins, as the Node wrappers do. The observation is also handed to the run that made the call."""

    def __init__(self, ap: AirPrompterAgent) -> None:
        super().__init__(ap)
        self.last: Optional[Observation] = None
        original = ap.report

        def capture(observation: Optional[Observation] = None, /, **kwargs: Any) -> None:
            self.last = observation
            original(observation, **kwargs)

        ap.report = capture  # type: ignore[method-assign]

    def _observe(self, kwargs: Any, response_obj: Any, start_time: Any, end_time: Any, error: Any) -> None:
        renamed = dict(kwargs)
        renamed["model"] = None
        super()._observe(renamed, response_obj, start_time, end_time, error)


def observation_record(o: Optional[Observation]) -> Optional[dict[str, Any]]:
    if o is None:
        return None
    return {"status": o.status, "errorClass": o.error_class, "latencyMs": o.latency_ms, "tokens": o.tokens, "usageSource": o.usage_source, "tag": o.tag, "versionId": o.version_id, "arm": o.arm, "model": o.model}


def cost_usd(model: str, tokens: Optional[dict[str, Any]], usage_source: Optional[str]) -> Optional[float]:
    price = USD_PER_MILLION.get(model)
    if not price or not tokens or usage_source != "reported":
        return None
    inp = (tokens.get("input") or 0) + (tokens.get("cachedInput") or 0)
    return (inp * price[0] + (tokens.get("output") or 0) * price[1]) / 1_000_000


def variable_origins(declared: list[dict[str, Any]], values: dict[str, Any], sources: list[str], looked_up: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for v in declared:
        fenced = v.get("trust") == "end_user"
        base = {"name": v["name"], "trust": v.get("trust"), "fenced": fenced, "required": bool(v.get("required"))}
        if values.get(v["name"]) is not None:
            out.append({**base, "origin": "call_site", "value": str(values[v["name"]])})
        elif v["name"] in sources:
            out.append({**base, "origin": "your_source", "value": looked_up.get(v["name"])})
        elif v.get("default") is not None:
            out.append({**base, "origin": "default", "value": v["default"]})
        else:
            out.append({**base, "origin": "unfilled", "value": None})
    return out


def main() -> None:
    if os.environ.get("AIRPROMPTER_AGENT_KEY"):
        raise SystemExit("host env: AIRPROMPTER_AGENT_KEY is set in a worker's environment; only the daemon holds the key")
    host_id = need("ZUDOCS_HOST_ID")
    state_dir = need("AIRPROMPTER_STATE_DIR")
    agent_id = need("AIRPROMPTER_AGENT")
    target = need("AIRPROMPTER_ENVIRONMENT")
    by = os.environ.get("ZUDOCS_WORKER_NAME", "eu-west python worker")
    idle_interval = int(os.environ.get("ZUDOCS_PY_TICKET_INTERVAL_SECONDS", "7200"))
    demo_interval = int(os.environ.get("ZUDOCS_PY_DEMO_TICKET_INTERVAL_SECONDS", "300"))
    demo_parameter = os.environ.get("ZUDOCS_DEMO_MODE_PARAMETER", "").strip() or f"/zudocs/{need('AIRPROMPTER_ENVIRONMENT')}/demo-mode"
    demo_poll = int(os.environ.get("ZUDOCS_DEMO_MODE_POLL_SECONDS", "60"))
    cap = int(os.environ.get("ZUDOCS_DAILY_RUN_CAP", "2000"))
    bedrock_region = need("ZUDOCS_BEDROCK_REGION")
    tables = Tables(need("ZUDOCS_TABLES_REGION"))
    ssm = boto3.client("ssm", region_name=need("ZUDOCS_REGION"))
    with open(need("AIRPROMPTER_ROOT_JWK_PATH"), encoding="utf-8") as f:
        root = json.load(f)
    if "d" in root:
        raise SystemExit("the pinned root carries a private member")
    socket_path = daemon_socket_path(state_dir=state_dir, agent_id=agent_id, target=target)

    # The daemon first: its socket (up to two minutes), then a generation to attach to — a fresh store stages the
    # first release, and the SDK's attach needs an active slot. Starting the SDK before that would fall back to an
    # in-process, keyless sync and create a store of its own; this process never does.
    waited = 0.0
    client: Optional[DaemonClient] = None
    while client is None and waited < 120:
        client = DaemonClient.connect(socket_path=socket_path, agent_id=agent_id, target=target, sdk=f"zudocs-pyworker/{WORKER_VERSION}")
        if client is None:
            time.sleep(3)
            waited += 3
    if client is None:
        log(event="daemon_absent", socketPath=socket_path)
        sys.exit(3)
    announced = False
    while True:
        try:
            doc = client.request("status")
        except Exception as error:  # noqa: BLE001 — the daemon restarted; reconnect and ask again
            log(event="daemon_status_unavailable", reason=str(error)[:200])
            client.close()
            client = None
            while client is None:
                time.sleep(3)
                client = DaemonClient.connect(socket_path=socket_path, agent_id=agent_id, target=target, sdk=f"zudocs-pyworker/{WORKER_VERSION}")
            continue
        if int(doc.get("generation") or 0) > 0:
            break
        if not announced:
            log(event="awaiting_first_approval", stagedGeneration=doc.get("stagedGeneration"), applyPolicy=(doc.get("applyPolicy") or {}).get("effective"))
            announced = True
        time.sleep(5)
    client.close()

    ap = AirPrompterAgent.start(
        organization_id=need("AIRPROMPTER_ORG"),
        agent_id=agent_id,
        target=target,
        root={"pinned": root, "hosted_environment": need("AIRPROMPTER_HOSTED_ENVIRONMENT")},
        state_dir=state_dir,
        sync={"mode": "daemon", "daemon_socket_path": socket_path},
        models=MODELS,
        variables={"customer_tier": {"resolve": lambda ctx: (tables.get_customer(ctx.subject) or {}).get("tier") if getattr(ctx, "subject", None) else None, "trust": "operator", "timeout_seconds": 1.5}},
        logger=lambda event: log(source="airprompter-sdk", **event),
    )
    status = ap.status()
    if status.source != "daemon" or not (status.daemon or {}).get("attached"):
        log(event="daemon_absent", socketPath=socket_path)
        ap.stop()
        sys.exit(3)
    callback = ReleaseNamedCallback(ap)
    litellm.callbacks = [callback]
    litellm.suppress_debug_info = True
    sdk = f"{SDK_NAME}/{SDK_VERSION}"
    started_at = now_iso()
    runs = 0
    last_run_at: Optional[str] = None
    cursor: Optional[str] = None
    stopping = False

    # Demo mode: the SSM switch the desk writes, read every minute; the interval in force follows it (demoMode.ts's rules).
    demo = {"mode": "off", "until": None, "by": None, "reason": "not_read_yet"}
    demo_read_at: Optional[str] = None
    demo_error: Optional[str] = None
    interval = idle_interval
    next_run = time.time() + 90  # the first ticket a minute and a half after start; the Node worker's is later still

    def read_demo_mode() -> None:
        nonlocal demo, demo_read_at, demo_error, interval, next_run
        try:
            try:
                text = ssm.get_parameter(Name=demo_parameter)["Parameter"]["Value"]
            except ssm.exceptions.ParameterNotFound:
                text = None
            now = time.time()
            parsed = parse_demo_mode(text, now)
            demo_read_at = now_iso()
            demo_error = None
            new_interval = demo_interval if parsed["mode"] == "on" else idle_interval
            if new_interval != interval:
                interval = new_interval
                # A mode change pulls the next ticket forward to at most one new interval away, never further out.
                next_run = min(next_run, now + interval)
            if parsed["mode"] != demo["mode"] or parsed["reason"] != demo["reason"]:
                log(event="demo_mode", mode=parsed["mode"], until=parsed["until"], reason=parsed["reason"], by=parsed["by"], ticketIntervalSeconds=interval)
            demo = parsed
        except Exception as error:  # noqa: BLE001 — the last reading stands; the row says the read failed
            demo_error = f"{type(error).__name__}: {str(error)[:160]}"
            log(event="demo_mode_unreadable", parameter=demo_parameter, reason=demo_error)

    def cadence_fields() -> dict[str, Any]:
        return {"demoMode": demo["mode"], "until": demo["until"], "by": demo["by"], "reason": demo["reason"], "ticketIntervalSeconds": interval, "idleIntervalSeconds": idle_interval, "demoIntervalSeconds": demo_interval, "nextTicketAt": datetime.fromtimestamp(next_run, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "parameter": demo_parameter, "readAt": demo_read_at, "error": demo_error}

    def write_status() -> None:
        s = ap.status()
        h = ap.healthz()
        tables.merge_status(host_id, {"instanceId": s.instance_id, "sdk": sdk, "startedAt": started_at, "writtenAt": now_iso(), "generation": s.generation, "stagedGeneration": s.staged_generation, "applyState": s.apply_state, "source": s.source, "attached": bool((s.daemon or {}).get("attached")), "healthz": h.get("status"), "reasons": h.get("reasons", []), "runs": runs, "lastRunAt": last_run_at, "variables": {"sources": list(s.variables.get("sources", [])) if isinstance(s.variables, dict) else []}, "cadence": cadence_fields()})

    tables.append_event({"at": started_at, "kind": "worker_started", "host": host_id, "sdk": sdk, "instanceId": status.instance_id, "generation": status.generation, "source": status.source, "language": "python"})
    ap.on_change(lambda change: tables.append_event({"at": now_iso(), "kind": "release_changed", "host": host_id, "generation": change.generation, "stagedGeneration": change.staged_generation, "applyState": ap.status().apply_state, "seenBy": "python"}))
    read_demo_mode()
    log(event="serving", hostId=host_id, generation=status.generation, stagedGeneration=status.staged_generation, socketPath=socket_path, sdk=sdk, intervalSeconds=interval, demoMode=demo["mode"])
    write_status()

    def run_one() -> None:
        nonlocal runs, last_run_at, cursor
        tickets = tables.list_tickets()
        if not tickets:
            return
        index = next((i for i, t in enumerate(tickets) if t["ticketId"] == cursor), -1)
        ticket = tickets[(index + 1) % len(tickets)]
        cursor = ticket["ticketId"]
        if ap.status().generation == 0:
            log(event="ticket_skipped", reason="no_verified_release", ticketId=ticket["ticketId"])
            return
        day = now_iso()[:10]
        ok_slot, used = tables.take_run_slot(day, cap)
        if not ok_slot:
            tables.append_event({"at": now_iso(), "kind": "cap_refused", "host": host_id, "ticketId": ticket["ticketId"], "capDay": day, "cap": cap, "used": used, "by": by})
            return
        started = time.time()
        at = now_iso()
        run_id = f"run_py{format(int(started * 1000), 'x')}{uuid.uuid4().hex[:6]}"
        customer = tables.get_customer(ticket["customerId"])
        values = {"ticket": ticket["body"], **({"tone": "formal"} if (customer or {}).get("tier") == "enterprise" else {})}
        step: dict[str, Any] = {"step": "reply", "tag": REPLY_TAG, "versionId": None, "arm": None, "model": None, "generation": None, "runRef": None, "rendered": None, "output": None, "observation": None, "checks": [], "costUsd": None, "judge": None, "error": None}
        try:
            handle = ap.prompt(REPLY_TAG, subject=ticket["customerId"])
            declared = [dict(v) for v in handle.variables()]
            rendered = handle.render(values)
            step.update({"versionId": rendered.version_id, "arm": rendered.arm, "model": rendered.model, "generation": rendered.generation, "runRef": rendered.run_ref})
            step["rendered"] = {"text": rendered.text, "variables": variable_origins(declared, values, list(ap.status().variables.get("sources", [])), {"customer_tier": (customer or {}).get("tier")}), "inference": dict(rendered.inference) if rendered.inference else None}
            wire_model = BEDROCK_CONVERSE.get(rendered.model)
            if not wire_model:
                raise RuntimeError(f"this worker cannot call {rendered.model} through LiteLLM's Converse path; it calls {', '.join(BEDROCK_CONVERSE)} (the Node worker carries the OpenAI-shaped path)")
            callback.last = None
            # drop_params: a setting the wire model does not take (a Luna-era reasoning effort on a Converse model) is
            # dropped by LiteLLM rather than refused — the record still shows the version's block as sealed.
            response = litellm.completion(model=f"bedrock/converse/{wire_model}", messages=[{"role": "user", "content": rendered.text}], metadata=litellm_metadata(rendered), aws_region_name=bedrock_region, num_retries=0, timeout=45, drop_params=True, **litellm_inference(rendered))
            text = response.choices[0].message.content or ""
            for _ in range(50):
                if callback.last is not None:
                    break
                time.sleep(0.01)
            step["output"] = text
            step["observation"] = observation_record(callback.last)
            tokens = (callback.last.tokens if callback.last else None) or {}
            verdicts = ap.checks(rendered, text, output_tokens=tokens.get("output"), record=False)
            step["checks"] = [dict(r) for r in verdicts.get("results", [])]
            step["costUsd"] = cost_usd(rendered.model, tokens, callback.last.usage_source if callback.last else None)
        except Exception as error:  # noqa: BLE001 — the record says what refused; nothing is simulated
            step["error"] = {"name": type(error).__name__, "message": str(error)[:400]}
            if step["observation"] is None and callback.last is not None:
                step["observation"] = observation_record(callback.last)
        s = ap.status()
        record = {"runId": run_id, "ticketId": ticket["ticketId"], "customerId": ticket["customerId"], "at": at, "by": by, "host": host_id, "kind": "run", "generation": s.generation, "applyState": s.apply_state, "steps": [step], "triage": None, "reply": step["output"], "handoff": None, "durationMs": int((time.time() - started) * 1000), "capUsed": used, "ok": step["error"] is None and step["output"] is not None, "sdk": sdk}
        tables.put_run(record)
        tables.update_last_run(ticket["ticketId"], {"runId": run_id, "at": at, "category": None, "priority": None, **({"versionId": step["versionId"]} if step["versionId"] else {}), **({"arm": step["arm"]} if step["arm"] else {})})
        o = step["observation"] or {}
        tables.append_event({"at": now_iso(), "kind": "ticket_run", "host": host_id, "ticketId": ticket["ticketId"], "runId": run_id, "generation": s.generation, "versionId": step["versionId"], "arm": step["arm"], "model": step["model"], "ok": record["ok"], "latencyMs": o.get("latencyMs"), "by": by, "sdk": sdk})
        runs += 1
        last_run_at = now_iso()
        if step["runRef"] and step["output"] and step["checks"]:
            signals = {"accepted": all(c.get("verdict") == "pass" for c in step["checks"])}
            filed = ap.feedback(step["runRef"], signals)
            tables.put_feedback({"runId": run_id, "at": now_iso(), "signals": signals, "by": f"{by} (checks)", "filed": filed})
            tables.append_event({"at": now_iso(), "kind": "feedback", "host": host_id, "runId": run_id, "ticketId": ticket["ticketId"], "step": "reply", "signals": list(signals), "filed": filed, "container": "same", "by": f"{by} (checks)"})
        log(event="ticket_run", ticketId=ticket["ticketId"], runId=run_id, ok=record["ok"], generation=s.generation, versionId=step["versionId"], model=step["model"], status=o.get("status"), checks=[c.get("verdict") for c in step["checks"]], error=step["error"])

    def stop(signum: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    next_status = time.time() + 30
    next_demo_read = time.time() + demo_poll
    while not stopping:
        now = time.time()
        if now >= next_run:
            next_run = now + interval
            try:
                run_one()
            except Exception as error:  # noqa: BLE001
                log(event="ticket_run_failed", reason=str(error)[:300])
        if now >= next_demo_read:
            next_demo_read = now + demo_poll
            read_demo_mode()
        if now >= next_status:
            next_status = now + 30
            try:
                write_status()
            except Exception as error:  # noqa: BLE001
                log(event="status_write_failed", reason=str(error)[:300])
        time.sleep(1)
    log(event="stopping", runs=runs)
    tables.append_event({"at": now_iso(), "kind": "worker_stopped", "host": host_id, "language": "python", "runs": runs})
    ap.stop()


if __name__ == "__main__":
    main()
