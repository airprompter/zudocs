/**
 * The code the drawer shows. Each string is a brace-matched or single-line slice of a source file.
 * apps/desk/test/snippets.test.ts fails when a slice no longer matches that file.
 *
 * @example
 * ```ts
 * LAMBDA_START.text.includes("on_invoke");
 * ```
 */

import type { Mark } from "./excerpt";

export interface Snippet {
  id: string;
  file: string;
  caption: string;
  text: string;
  marks: readonly Mark[];
}

export const LAMBDA_START: Snippet = {
  "id": "lambda-start",
  "file": "services/desk-api/src/runtime.ts",
  "caption": "What this host adds",
  "text": "const ap = await AirPrompterAgent.start({\n    organizationId: env.airprompter.organizationId,\n    agentId: env.airprompter.agentId,\n    target: env.airprompter.environment as \"dev\" | \"staging\" | \"prod\",\n    apiKey,\n    baseUrl: env.airprompter.baseUrl,\n    stateDir: env.stateDir,\n    keyProvider: customKeyProvider({\n      storageProtection: \"kms\",\n      wrap: async (dek) => {\n        const out = await kms.send(new EncryptCommand({ KeyId: env.kmsKeyId, Plaintext: dek, EncryptionContext: encryptionContext }));\n        if (!out.CiphertextBlob) throw new Error(\"KMS Encrypt returned no ciphertext\");\n        return out.CiphertextBlob;\n      },\n      unwrap: async (wrapped) => {\n        const out = await kms.send(new DecryptCommand({ KeyId: env.kmsKeyId, CiphertextBlob: wrapped, EncryptionContext: encryptionContext }));\n        if (!out.Plaintext) throw new Error(\"KMS Decrypt returned no plaintext\");\n        return out.Plaintext;\n      },\n    }),\n    root: { pinned: JSON.parse(env.airprompter.rootJwk), hostedEnvironment: env.airprompter.hostedEnvironment as \"dev\" | \"staging\" | \"prod\" },\n    sync: { mode: \"on_invoke\", rootUrl: env.airprompter.rootUrl },\n    apply: { policy: \"auto\" },\n    heartbeatSeconds: env.heartbeatSeconds,\n    models: [...MODELS],\n    variables: {\n      customer_tier: { resolve: async ({ subject }) => (subject ? (await store.getCustomer(subject))?.tier : undefined), trust: \"operator\", timeoutMs: 1500 },\n    },\n    telemetry: { flush: \"await\" },\n    golden: { invoke: golden, concurrency: 2 },\n    fetch: teeFetch(globalThis.fetch as any, { namespace: env.emfNamespace, emit: (line) => process.stdout.write(line + \"\\n\"), properties: { host: env.hostId } }),\n    logger: log,\n  });",
  "marks": [
    {
      "needle": "apiKey,",
      "kind": "host"
    },
    {
      "needle": "storageProtection: \"kms\"",
      "kind": "host"
    },
    {
      "needle": "mode: \"on_invoke\"",
      "kind": "host"
    },
    {
      "needle": "teeFetch",
      "kind": "host"
    }
  ]
};

export const RUN_STEP: Snippet = {
  "id": "run-step",
  "file": "services/desk-api/src/run.ts",
  "caption": "What you write",
  "text": "const runStep = async (step: StepName, tag: string, values: Record<string, string>, judge: boolean, viaDirect = false): Promise<StepRecord> => {\n    const record = emptyStep(step, tag);\n    try {\n      const handle = ap.prompt(tag, { subject });\n      const declared = handle.variables();\n      const rendered = await handle.renderAsync(values);\n      record.versionId = rendered.versionId;\n      record.arm = rendered.arm;\n      record.model = rendered.model;\n      record.generation = rendered.generation;\n      record.runRef = rendered.runRef;\n      record.rendered = { text: rendered.text, variables: variableOrigins(declared, values, ap.status().variables.sources, { customer_tier: customer?.tier }), inference: rendered.inference ?? null };\n      const outcome = await host.observed((): Promise<Completion | DirectCompletion> => (viaDirect && direct ? direct.complete(rendered) : callers.complete(rendered)));\n      record.observation = outcome.observations.find((o) => o.tag === tag) ?? outcome.observations[0] ?? null;\n      if (outcome.result === undefined) throw outcome.error;\n      const result = outcome.result;\n      record.output = result.text;\n      if (\"provider\" in result) {\n        // The observation is filed under the model the call named; the checks are the render's; the price is the provider's list.\n        record.provider = { name: result.provider, model: result.model, applied: result.applied, ignored: result.ignored };\n        record.model = result.model;\n      }\n      const outputTokens = record.observation?.tokens?.output ?? null;\n      // The wrapper already counted the checks on the window; this is the per-check view, not recorded again.\n      record.checks = ap.checks(rendered, result.text, { outputTokens, record: false }).results;\n      record.costUsd = record.provider ? costUsdDirect(record.provider.name, record.provider.model, record.observation?.tokens, record.observation?.usageSource) : costUsd(rendered.model, record.observation?.tokens, record.observation?.usageSource);\n      if (judge && result.text) {\n        try {\n          const verdict = await ap.judge(rendered.runRef, result.text, \"prompt\", (prompt) => callers.judge(prompt));\n          record.judge = { score: verdict.score, taskPass: verdict.taskPass, taskFail: verdict.taskFail, taskUnclear: verdict.taskUnclear, flagged: verdict.flagged, model: callers.judgeModel };\n        } catch (error) {\n          record.error = { name: \"JudgeFailed\", message: errorOf(error).message };\n        }\n      }\n    } catch (error) {\n      record.error = errorOf(error);\n    }\n    steps.push(record);\n    return record;\n  };",
  "marks": [
    {
      "needle": "ap.prompt(",
      "kind": "write"
    },
    {
      "needle": "handle.renderAsync",
      "kind": "write"
    },
    {
      "needle": "ap.checks(",
      "kind": "write"
    },
    {
      "needle": "ap.judge(",
      "kind": "write"
    }
  ]
};

export const CLIENT_RUN: Snippet = {
  "id": "client-run",
  "file": "apps/desk/src/api.ts",
  "caption": "This page",
  "text": "    runTicket: (ticketId, provider) => runOrRecord<{ run: Run; cap: State[\"cap\"] }>(`/tickets/${encodeURIComponent(ticketId)}/run`, provider ? { provider } : {}),",
  "marks": []
};

export const DAEMON_CONNECT: Snippet = {
  "id": "daemon-connect",
  "file": "services/eu-host/src/worker.ts",
  "caption": "What you write",
  "text": "DaemonClient.connect({ socketPath: this.socketPath, agentId: this.scope.agentId, target: this.scope.target, sdk: `zudocs-worker/${WORKER_VERSION}` })",
  "marks": [
    {
      "needle": "DaemonClient.connect",
      "kind": "write"
    }
  ]
};

export const DAEMON_START: Snippet = {
  "id": "daemon-start",
  "file": "services/eu-host/src/worker.ts",
  "caption": "What you write",
  "text": "const agent = await AirPrompterAgent.start({\n        organizationId: env.airprompter.organizationId,\n        agentId: env.airprompter.agentId,\n        target: env.airprompter.environment,\n        stateDir: env.stateDir,\n        root: { pinned: rootJwk as never, hostedEnvironment: env.airprompter.hostedEnvironment },\n        sync: { mode: \"daemon\", daemonSocketPath: socketPath },\n        models: [...MODELS],\n        variables: {\n          customer_tier: { resolve: async ({ subject }) => (subject ? (await store.getCustomer(subject))?.tier : undefined), trust: \"operator\", timeoutMs: 1500 },\n        },\n        logger: (event) => log({ source: \"airprompter-sdk\", ...event }),\n      });",
  "marks": [
    {
      "needle": "mode: \"daemon\"",
      "kind": "write"
    }
  ]
};

export const DAEMON_GUARD: Snippet = {
  "id": "daemon-guard",
  "file": "services/eu-host/src/worker.ts",
  "caption": "What you write",
  "text": "if (agent.status().source !== \"daemon\") {\n        // The socket vanished between the check and the start: never a second, keyless, in-process sync.\n        log({ event: \"attach_fell_back\", source: agent.status().source });\n        await agent.stop();\n        return;\n      }",
  "marks": [
    {
      "needle": "source !== \"daemon\"",
      "kind": "write"
    }
  ]
};

export const POLICY_LINE: Snippet = {
  "id": "policy-line",
  "file": "services/eu-host/host/units/airprompterd.service",
  "caption": "What this host adds",
  "text": "  --apply-policy unlock_required \\",
  "marks": [
    {
      "needle": "--apply-policy unlock_required",
      "kind": "host"
    }
  ]
};

export const AIRGAP_START: Snippet = {
  "id": "airgap-start",
  "file": "services/airgap/src/runtime.ts",
  "caption": "A host with no route out",
  "text": "const agent = await AirPrompterAgent.start({\n          organizationId: env.airprompter.organizationId,\n          agentId: env.airprompter.agentId,\n          target: env.airprompter.environment,\n          stateDir: env.stateDir,\n          root: { pinned: rootJwk as never, hostedEnvironment: env.airprompter.hostedEnvironment },\n          sync: { mode: \"offline\" },\n          distributionKey,\n          ...(existsSync(env.vendoredBundlePath) ? { vendoredBundle: { bundle: env.vendoredBundlePath } } : {}),\n          apply: { policy: \"auto\" },\n          // No `models`: this host declares no catalogue — it can call none — so no release is refused over a model; it renders only.\n          telemetry: { sink: \"directory\", instanceClass: \"resident\" },\n          logger: sdkLogger,\n        });",
  "marks": [
    {
      "needle": "mode: \"offline\"",
      "kind": "host"
    }
  ]
};

export const ENQUEUE_CALL: Snippet = {
  "id": "enqueue-call",
  "file": "apps/desk/src/components/Presenter.tsx",
  "caption": "This page",
  "text": "onAction(\"enqueue\", { ticketId: selectedTicketId, host: hostId })",
  "marks": []
};
