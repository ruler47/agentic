# P2 External Action UX

## BA View

### Problem

External actions such as booking a haircut or submitting a form are safer than before,
but the user flow is still too hard to understand. The user sees multiple buttons,
unclear approval states, and cannot easily tell what will be sent, where, and what
happens after approval.

### Desired Behavior

The user should be able to ask:

"Find a barbershop, fill the booking form with my details, show me what you will submit,
then submit after my approval."

The system should:

- choose a provider/action target;
- prepare the form without final submit;
- show a proof screenshot and data summary;
- ask for one clear approval in approval mode;
- commit after approval;
- return a final report with confirmation, submitted data summary, location/link, and
  cancellation/next-step info when available.

Automode should skip approval only when policy, data sufficiency, executor readiness, and
proof are all satisfied.

### User Stories

- As a user, I can understand exactly what I approve.
- As a user, after approving I do not need to press several confusing buttons.
- As an operator, I can audit pre-submit and post-submit proof.
- As a channel user, I can complete the same flow from Telegram when policy allows.

### Non-Goals

- Do not bypass login/CAPTCHA/payment/legal boundaries.
- Do not submit sensitive data without explicit user authorization or policy.
- Do not build provider-specific Agentic code for one barbershop/restaurant.

## Architect / Tech Lead View

### Proposed Solution

Implement a single external-action state machine and one primary UI card.

Recommended states:

- `drafting`
- `proposal_ready`
- `preparing`
- `needs_data`
- `ready_for_approval`
- `waiting_approval`
- `approved`
- `committing`
- `committed`
- `blocked`
- `rejected`

Runtime flow:

1. Agent researches/selects target.
2. Agent calls `external.action.prepare` with target/action/data/boundary.
3. Browser tool prepares form with `fillFormSemantically` and stops before commit.
4. Runtime captures pre-submit proof artifact.
5. Proposal card shows:
   - destination;
   - action;
   - data to send;
   - missing required fields;
   - proof artifact;
   - submit boundary;
   - what happens after approval.
6. Approval mode pauses run at `waiting_approval`.
7. Approval triggers preparation refresh if stale, then commit.
8. Commit runs through guarded `external.action.commit`.
9. Final report records status, confirmation, proof, location/link, and how to cancel.

UI policy:

- One primary action at a time.
- Advanced controls collapsed.
- Button labels must describe the external effect.
- "Approve" means approve data/proposal.
- "Submit externally" means send data to the provider.
- Normal approval mode should combine approve + continue safely when no extra user action
  is required, while still preserving the final submit boundary.

### Likely Files

- `src/server/modules/runs/action-proposals.service.ts`
- `src/server/modules/runs/action-proposal-*.ts`
- `src/agents/externalActionPlanning.ts`
- `src/tools/browserOperateTool.ts`
- `src/tools/externalActionPrepareTool.ts`
- `src/tools/externalActionCommitTool.ts`
- `web-react/src/components` or route components for approval cards
- `web-react/src/routes/Approvals.tsx`
- `web-react/src/routes/RunWorkspace.tsx`
- external action tests and fixture tests

## QA View

### Acceptance Criteria

- A booking fixture reaches `waiting_approval` with one understandable card.
- The card shows target, URL, action, data, missing fields, proof, and exact submit
  boundary.
- Approval resumes the same run and either commits or produces a clear blocker.
- Commit records post-submit proof or a clear reason why proof is unavailable.
- Reject completes/resumes the same run with a clear final answer.
- No final submit occurs before approval in approval mode.
- Automode does not enter approval queue when policy and data are sufficient, and records
  why it committed or why it blocked.

### Automated Tests

- State-machine transitions.
- Approval mode pauses at correct state.
- Approval resumes same run.
- Commit endpoint requires readiness, proof, and explicit approval.
- Login/CAPTCHA/payment boundaries block.
- UI component tests for button visibility and wording.

### Manual Verification

1. Use local external-action fixture.
2. Run booking task in approval mode.
3. Inspect proposal card.
4. Approve once.
5. Confirm same run resumes and commits or blocks clearly.
6. Run automode fixture.
7. Inspect Run Workspace, Approvals, Trace Lab, Ledger, artifacts, final report.

## PM / Feature Owner View

### Delivery Plan

1. Document current approval states and button actions.
2. Define the canonical state machine and DTO.
3. Update backend derived readiness logic.
4. Simplify UI card around one primary next action.
5. Wire approval resume behavior.
6. Improve final report contract.
7. Add fixture tests.
8. Run manual approval and automode exams.
9. Update docs and close this task.

### Done When

- The user can test a booking fixture without asking "what do I press now?"
- Approval and commit are distinct but understandable.
- The same design can apply to booking, form submit, outbound message, and API write.
