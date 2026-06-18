# Model Routing Roadmap

## Current State

The local OpenAI-compatible endpoint is `http://127.0.0.1:1234/v1`.

The platform can now:

- discover models from `/v1/models`;
- split discovered ids into chat and embedding catalogs;
- infer model capabilities from names;
- accept operator capability overrides through `LLM_MODEL_CAPABILITIES`;
- show capability badges in the Models UI;
- bound each LLM attempt with `LLM_REQUEST_TIMEOUT_MS`.

Current verified local vision models:

- `qwen/qwen3.6-35b-a3b`
  - verified: chat, reasoning, tool-calling candidate, vision
  - manual smoke: correctly read a PNG containing a red circle and the word `CAT`
- `google/gemma-4-26b-a4b`
  - verified: chat, vision
  - manual smoke: correctly read the same PNG

Important limitation: the standard `/v1/models` response does not expose formal modality
metadata. Vision support must therefore come from either provider-specific metadata,
operator verification, or active probes.

## Roadmap

### Phase 1: Durable Model Profiles

Goal: move from environment overrides to durable model records.

Add a model profile store with per-model metadata:

- model id;
- provider id;
- capabilities: `chat`, `embedding`, `vision`, `reasoning`, `coding`, `tool-calling`;
- context window and max output tokens;
- reasoning behavior: normal, reasoning-first, configurable;
- latency class and measured p50/p95;
- operator notes;
- verification status and timestamp.

UI requirements:

- edit capabilities manually;
- mark a capability as verified, inferred, or failed;
- show why a model is or is not eligible for a tier.

### Phase 2: Capability Probes

Goal: verify capabilities by running small tests, not by trusting names.

Add probes:

- chat smoke: short deterministic answer;
- reasoning smoke: simple multi-step puzzle with concise answer;
- coding smoke: small TypeScript function repair;
- tool-calling smoke: native `tools` call request and argument validation;
- vision smoke: read a generated PNG and answer about shape/text;
- embedding smoke: call `/embeddings` and validate vector dimensions.

Probe results should be stored and visible in Models UI.

### Phase 3: Tier-Constrained Capability Selection

Goal: keep S/M/L/XL tiers as the primary routing mechanism, but filter or prefer models
inside the selected tier by required capability.

Selection input should include:

- task complexity;
- selected tier;
- required modalities, especially vision for images/screenshots/files;
- required capabilities, such as coding, reasoning, or tool-calling;
- operator preferences, such as "preferred coding model" or "preferred vision model";
- latency tolerance;
- privacy/provider constraints;
- retry and fallback policy.

Selection behavior:

- the runtime first chooses the tier using existing S/M/L/XL policy;
- if the task needs `vision`, candidates are limited to models in that tier with `vision`;
- if the task needs `reasoning`, candidates are limited/preferred by `reasoning`;
- if the task needs coding, candidates are limited/preferred by `coding` and operator
  coding preference;
- if the selected tier has no matching model, the runtime can escalate according to the
  existing tier fallback policy, but only to compatible models;
- simple classification/direct-answer tasks can still use the tier's default model.

### Phase 4: Multimodal Runtime Contract

Goal: pass files and images to models intentionally.

Needed changes:

- extend `Message.content` beyond plain string to support multimodal content parts;
- let run inputs and artifacts become model-visible attachments when policy allows;
- add image preprocessing: mime validation, size limits, resizing, redaction hooks;
- record in trace which attachments were sent to which model.

### Phase 5: Evaluation And Regression Dashboard

Goal: know which model should be used for which job.

Create recurring eval fixtures:

- direct answer;
- current-data research;
- visual screenshot interpretation;
- browser/form task planning;
- tool selection;
- code repair;
- summarization;
- long-context synthesis.

Persist:

- score;
- latency;
- failure reason;
- token usage when available;
- selected route and fallback route.

### Phase 6: Provider-Aware Policy

Goal: support local and remote providers without hardcoding.

Add provider policy:

- allowed data classes;
- cost budget;
- network availability;
- local-only constraints;
- per-provider API quirks, such as image URL format and reasoning-token behavior.

## Testing Plan

Every model-selection change should include:

- unit tests for capability parsing and routing decisions;
- API tests for `/api/models/catalog`;
- UI smoke on `/models`;
- one real local LLM run;
- one negative test where a missing capability prevents selection.

Current manual test commands:

```bash
curl -sS http://127.0.0.1:1234/v1/models | jq .
curl -sS http://127.0.0.1:3000/api/models/catalog | jq .
```

Current local server launch:

```bash
DATABASE_URL=postgres://agentic:agentic@127.0.0.1:5432/agentic \
LLM_REQUEST_TIMEOUT_MS=45000 \
LLM_MODEL_CAPABILITIES='qwen/qwen3.6-35b-a3b=vision,reasoning,tool-calling;google/gemma-4-26b-a4b=vision' \
npm run web
```
