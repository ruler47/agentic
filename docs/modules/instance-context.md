# Instance Context And Personalized Assistant Model

## Purpose

The long-term product is a deployable assistant system for exactly one family,
household, company, team, or other bounded group per running instance.

This is not a SaaS model with multiple independent shared contexts inside one instance.
One installed instance has one group profile, one shared context boundary, and many
users/members inside that boundary.
If another family or company needs the system, it gets a separate instance.

The system should adapt to that group's needs over time while keeping shared group
context, individual user context, tools, credentials, channels, and permissions separated.

## Core Concepts

### Instance

An instance is the isolated deployment boundary for one family, company, or team.

Instance-level data includes:

- group profile and name;
- default language, time zone, and locale;
- governance policy;
- enabled channels;
- shared tools and credentials;
- shared group memory;
- audit log;
- artifact and workspace boundaries.

### Group Profile

The group profile describes the one group served by this instance.

Group profile data includes:

- description, goals, and preferences;
- members and roles;
- shared reminders and broadcasts;
- shared memories;
- enabled tools;
- artifacts and workspace settings.

### User

A user is a person known to the instance.

User-level data includes:

- display name;
- contact/channel identities such as Telegram user ID;
- role and permissions;
- personal preferences;
- personal memories;
- private artifacts;
- notification preferences;
- allowed tools and budget policy.

### Channel Identity

Requests may arrive from the web console, Telegram, future email/chat integrations, or
API clients. The same human user can have multiple channel identities.

Channel identity records should map:

- provider: `web`, `telegram`, future `slack`, `email`, `api`;
- provider user ID;
- internal user ID;
- whitelist/allow status;
- last seen timestamp;
- optional display metadata.

Current implementation note: `UserStore` resolves run requesters before run creation.
Explicit `requesterUserId` values must exist. Channel-originated requests can provide
`channel` and `sourceUserId`; the pair must map to an allowed `channel_identities` row or
the HTTP API rejects the run before any thread, audit event, or LLM execution is started.

### Conversation Thread

A conversation thread groups one initial task and later follow-up messages from the same
channel/user context.

Thread data should include:

- `threadId`;
- originating channel;
- requester user;
- source chat/thread/message IDs when available;
- active or archived status;
- last run ID;
- compact thread summary;
- open questions, accepted facts, rejected/failed attempts, and correction notes;
- artifact and outbound-action references relevant to the thread.

Runs stay concrete: every run still executes one specific task. A follow-up message creates
a new run linked to the existing thread with `parentRunId` and a compact thread context.
The runtime should not replay the full transcript unless a tool or reviewer explicitly
needs it.

### Memory Scopes

Memory must be scoped so agents can personalize without leaking context.

Recommended memory scopes:

- `global`: product-level reusable technical lessons, not instance-private data.
- `group`: shared context for this instance's family/company/team.
- `user`: individual preferences, facts, habits, constraints, and history.
- `run`: temporary context for the current task only.

Retrieval should include scope filters:

```text
current task context
  -> global reusable skills
  -> group memory for this instance
  -> requesting user's memory
  -> explicitly authorized referenced users' memory
```

Agents must not read another user's private memory unless the task, permissions, and
policy allow it.

## Task Sources

### Web Console

The web console is the administrative and operator interface. It should support:

- submitting tasks as the selected/requesting user inside the current instance;
- observing runs;
- managing users and Telegram whitelist entries;
- viewing group and user memory;
- managing tools and credentials;
- reviewing outbound messages and broadcast history.

### Telegram Bot

Telegram is a first target channel for real user requests.

Target behavior:

- accept messages only from whitelisted Telegram users;
- map Telegram users to instance users;
- classify each inbound message as a new task, continuation, clarification question, or
  correction to the previous result;
- attach continuations to the correct conversation thread instead of always creating an
  unrelated top-level task;
- create runs with source metadata (`channel=telegram`, chat ID, message ID);
- show Telegram-originated runs in the admin console;
- send final answers back to the requester;
- support group broadcasts or direct messages when an authorized user asks the agent to
  notify someone.

Outbound Telegram actions must be explicit and auditable. The runtime should distinguish
between answering the requester and sending a message to another person or to the group.

Telegram thread resolution should use deterministic metadata first and LLM classification
second:

```text
reply-to message / forum topic / explicit command
  -> existing thread
recent same-user chat context with unresolved follow-up signals
  -> likely continuation, confirm through classifier
explicit new-task command or unrelated intent
  -> new thread
ambiguous message
  -> ask a short clarification or attach to the last active thread with low confidence
```

The classifier should receive only compact context: previous user requests, final answers,
artifacts, what passed review, what failed, and unresolved questions.

## Outbound Actions

Agents will eventually act on behalf of users and the group.

Examples:

- remind the family/company/team about an event;
- send a message to one user;
- notify the whole group about a generated report;
- create a scheduled alert.

Outbound action rules:

- require a tool contract and audit event;
- include actor, requester, instance, target recipient, message body, and reason;
- respect user/group permissions;
- support preview/approval for sensitive messages;
- persist delivery status and provider response.

## Inter-Instance Agent Communication

Agents from separate instances may later communicate. For example, one company instance
may ask another company instance for approved information, or one family instance may
share a narrow request with another family instance.

The target model is capability- and permission-based:

- each instance agent has an identity;
- cross-instance requests carry source instance and requester provenance;
- the receiving instance decides whether to answer based on policy;
- only the minimal requested context is shared;
- every exchange is logged and reviewable.

This should be treated like an external integration, not like shared internal memory.

## Tool Build Capability Onboarding

The tool registry should support user-assisted integration creation through Tool Builds,
not through a separate API onboarding product area. API integrations, Telegram/WhatsApp/
Slack adapters, browser capabilities, and other missing skills all enter the same
Builder -> QA -> Registrar lifecycle.

Target workflow:

```text
admin provides a tool name, docs/instructions, optional credentials, and desired use cases
  -> agent reads docs and proposes a TypeScript tool contract
  -> Tool Builder creates module and tests
  -> Tool QA verifies behavior against docs and smoke calls
  -> Tool Registrar registers it for this instance
  -> credentials are stored in a secret store
  -> agents can invoke the new tool when policy allows
```

Tool metadata should include:

- purpose and natural-language description;
- capabilities;
- input/output schema;
- credential requirements;
- allowed user roles or policy scopes;
- safety classification;
- examples;
- health status;
- owner/admin;
- audit settings.

Credentials must never be stored in skill memory or run text. They should be referenced
through secret handles.

## Model Providers And Tiers

Model tier settings must support both local and remote OpenAI-compatible providers.

Examples:

- local LM Studio/Ollama/vLLM endpoint with `baseUrl=http://127.0.0.1:1234/v1`;
- remote OpenAI API with `baseUrl=https://api.openai.com/v1`;
- other OpenAI-compatible hosted providers.

Each tier should be able to store:

- provider name;
- base URL;
- model candidates;
- secret handle for API key when needed;
- max attempts;
- escalation policy.

API keys must be stored through secret handles, not in prompts, memory, trace details, or
browser-visible configuration.

## Admin UI Information Architecture

The future UI should separate daily usage from administration.

Recommended top-level navigation:

```text
Dashboard
Runs
Conversations
Group Profile
Users
Channels
Memory
Artifacts
Tools
Tool Builds
Models
Policies
Settings
```

Recommended run workspace:

```text
Run Header: group profile, requester, channel, thread, status, duration
Answer: final response and outbound actions
Artifacts: generated and attached files
Execution: compact live summary
Trace Lab: full graph/timeline/log inspector
Context: memory hits and permission scope used
Continue: follow-up composer with inherited thread context
```

Recommended group profile page:

```text
Group profile
Members and roles
Shared memory
Enabled tools
Channels and whitelisted identities
Recent runs
Scheduled/outbound messages
Artifacts
Audit log
```

Recommended user page:

```text
User profile
Channel identities
Role and permissions
Personal memory
Notification preferences
Allowed tools
Recent requests
Private artifacts
Audit log
```

Recommended thread workspace:

```text
Thread summary
Runs in this thread
Current answer and artifacts
Follow-up composer
Corrections and accepted changes
Open questions
Compact context used for the next run
Telegram/source message links
```

## Security And Privacy Principles

- Instance data is isolated by default.
- User memory is private unless policy allows sharing.
- Tool credentials and model API keys are secret handles, not prompt text.
- Every outbound message is auditable.
- Inter-instance communication uses explicit permissions.
- Admin console views should make scope visible: group profile, requester, channel.
- UI and Telegram should make thread scope visible: new task versus continuation.
- Agents receive the minimum context needed for the current task.

## Near-Term Implementation Slice

The current single-user app can evolve safely by adding these layers in order:

1. Add database tables for instance settings, users, memberships/roles, and channel
   identities. DONE
2. Add a default local instance profile and admin user migration. DONE
3. Attach `instanceId`, `requesterUserId`, and `channel` metadata to runs. DONE
4. Add conversation threads with `threadId`, `parentRunId`, compact summaries, and
   continuation classification. DONE
5. Resolve users and allowed channel identities before creating runs. DONE for the HTTP
   runtime; Telegram adapter and whitelist UI still need to feed the same contract.
6. Scope memory records by global/group/user/run.
7. Add admin UI pages for Group Profile, Users, Channels, Conversations, and Memory scopes.
8. Add Telegram webhook/bot adapter with whitelist and thread-resolution enforcement.
9. Add outbound message tool contracts with audit-only dry runs first.
10. Add instance-scoped tool credentials and API onboarding flow.
11. Add model provider settings for local OpenAI-compatible endpoints and remote OpenAI
   API usage through secret handles.
