# P2 External Action UX

Status: implemented and manually verified on 2026-06-19.

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

Implement a single external-action state interpretation and one primary UI card.

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

### Implemented Solution

- `web-react/src/features/approvals/externalActionUxState.ts` is the canonical React
  projection from backend proposal/readiness state to user-facing status, summary,
  primary action, and advanced actions.
- `/approvals` and Run Workspace use the same projection. Pending proposals show one
  primary `Approve plan and prepare proof` action; approved proposals show the next
  single safe action such as `Prepare form and capture proof`, `Attach submit executor`,
  or `Submit externally now`.
- Advanced controls such as explicit replay/build are collapsed or secondary.
- Approval mode now lets the backend auto-advance through safe preparation and executor
  attachment when possible, while still stopping before final external submit.
- `browser.operate` preparation compatibility was normalized:
  - commands carry both `action` and `type`;
  - core HTTP browser runtimes get an explicit first `navigate`;
  - commands requiring form schema or semantic fill are filtered unless the selected tool
    declares the matching capability;
  - if semantic fill is unavailable, common form fields fall back to selector-based
    browser fills.
- Docker-host browser preparation rewrites local URLs through
  `BROWSER_OPERATE_LOCALHOST_ALIAS`, defaulting to `host.docker.internal`, while the
  original task URL remains in proposal/audit context.
- The core `external.action.commit` tool declares
  `external-action-commit-generic` and can be attached as the generic guarded commit
  executor instead of trying to generate a duplicate tool with the same name.
- Commit tool input now includes the typed fields required by the core executor:
  `preparedActionId`, `approved`, `provider`, `commitPayload`, and proof artifact ids.

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

Verified locally against the safe reservation fixture:

1. Created fixture proposal `proposal_1781883402158_iaci7qda` with run
   `run_1781883402158_4on9f2qq`.
2. Opened `/approvals` in the React UI.
3. Confirmed one pending primary action: `Approve plan and prepare proof`.
4. Approved once.
5. Confirmed the platform prepared the form, filled Name/Party size/Date/Time/Notes,
   captured a proof artifact, attached the generic `external.action.commit@1.0.0`
   executor, and showed one final primary action: `Submit externally now`.
6. Submitted the safe fixture action.
7. Confirmed `/approvals` moved the item to recent decisions with
   `Fixture external action committed. Confirmation:
   fixture-proposal_1781883402158_iaci7qda`.
8. Confirmed API run status is `completed` and event order is:
   `external-action-proposal-created`, `external-action-proposal-approved`,
   `external-action-approval-auto-advance-started`,
   `external-action-preparation-started`, `artifact-created`,
   `external-action-preparation-completed`,
   `external-action-executor-attached`,
   `external-action-approval-auto-advance-completed`,
   `external-action-commit-started`, `external-action-committed`, `run-completed`.

## PM / Feature Owner View

### Delivery Plan

1. Done: documented current approval states and button actions.
2. Done: defined canonical UI state projection.
3. Done: updated backend readiness/executor compatibility.
4. Done: simplified UI card around one primary next action.
5. Done: wired approval resume through preparation and executor attach.
6. Done: core fixture final report records confirmation and submitted data summary.
7. Done: added backend and React unit coverage for the new flow.
8. Done: ran manual approval fixture exam end to end.
9. Done: updated docs.

### Done When

- The user can test a booking fixture without asking "what do I press now?"
- Approval and commit are distinct but understandable.
- The same design can apply to booking, form submit, outbound message, and API write.

Follow-up: run the same simplified UX through a real-world provider that blocks before
login/CAPTCHA/payment and verify the blocker text remains explicit and non-submitting.
