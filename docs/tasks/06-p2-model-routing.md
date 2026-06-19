# P2 Model Routing

## BA View

### Problem

The product supports local and remote LLMs, but model choice is not yet a reliable
product feature. The user wants tier-based routing with capability constraints: if a task
needs vision, choose a model in the selected tier with vision; if it needs coding or
reasoning, prefer the configured model for that role.

### Desired Behavior

- Operators configure model providers and tier preferences in UI.
- Runtime chooses S/M/L/XL tier first, then filters by required capabilities.
- Capabilities include chat, vision, reasoning, coding, tool-calling, embedding,
  context window, latency, and operator preference.
- Model availability comes from discovered local models plus durable remote provider
  records.
- The trace shows which model was selected and why.

### User Stories

- As a user, image/screenshot tasks use a vision-capable model.
- As an operator, I can mark Qwen as preferred reasoning or coding model.
- As an operator, I can see why a model was ineligible.

### Non-Goals

- Do not hardcode one local model as universal.
- Do not require all providers to expose formal modality metadata.
- Do not send images/files to a model without explicit runtime policy.

## Architect / Tech Lead View

### Proposed Solution

Build durable model profiles and a routing resolver.

Contracts:

- `ModelProvider`
  - provider id, base URL, auth handle, provider type, status
- `ModelProfile`
  - model id, provider id, capabilities, context window, max output, latency stats,
    verification status, operator notes
- `ModelRouteRequest`
  - desired tier, required capabilities, preferred role, privacy/cost constraints,
    fallback policy
- `ModelRouteDecision`
  - selected provider/model, reason, rejected candidates, fallback chain

Phases:

1. Durable profiles backed by Postgres and UI.
2. Capability probes for chat/reasoning/coding/tool-calling/vision/embedding.
3. Tier-constrained resolver.
4. Multimodal message contract for files/images.
5. Evaluation dashboard.

Runtime:

- Task framing declares required capabilities.
- Tool/proof/image tasks can request `vision`.
- Code tasks can request `coding`.
- Planning/synthesis can request `reasoning`.
- Resolver selects within tier, then escalates only to compatible models.

### Likely Files

- `src/agents/modelTier.ts`
- `src/settings/modelProviderStore.ts`
- `src/settings/postgresModelProviderStore.ts`
- `src/server/modules/models/*`
- `src/llm/client.ts`
- `web-react/src/routes/Models.tsx`
- `docs/model-routing-roadmap.md`
- tests for catalog, routing, probes, and UI DTOs

## QA View

### Acceptance Criteria

- Discovered local models appear in Models UI with editable capability metadata.
- Operator overrides persist.
- Routing filters by capability inside tier.
- If no compatible model exists, decision reports a clear blocker or fallback.
- Vision task does not route to non-vision model.
- Trace records selected model and rejected candidates.
- Existing env-based config still works as fallback.

### Automated Tests

- Capability parser tests.
- Provider/profile store tests.
- Resolver tests for tier + vision/reasoning/coding.
- Negative test for missing capability.
- API tests for catalog/profile endpoints.

### Manual Verification

1. Start LM Studio with two models.
2. Open Models UI and verify catalog.
3. Mark capabilities manually or run probes.
4. Run a vision-required task.
5. Run a simple direct task.
6. Inspect Trace Lab model selection.

## PM / Feature Owner View

### Delivery Plan

1. Align `docs/model-routing-roadmap.md` with active queue.
2. Implement durable profile schema/store if missing.
3. Add profile API and UI editing.
4. Add resolver and unit tests.
5. Wire resolver into LLM client calls.
6. Add trace events.
7. Add first capability probes.
8. Manual local model smoke.
9. Update docs and close this task.

### Done When

- Model selection is explainable and capability-aware.
- User can safely rely on vision/coding/reasoning routing without prompt hacks.
