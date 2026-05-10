# channel.telegram.bot (in-process built-in reference adapter)

> **Status:** in-process — runs inside the runtime app process, not as a docker
> service. Implementation lives in
> `src/tools/messagingServiceToolBuildProvider.ts`.

## What it does
The reference messaging-channel adapter the runtime exposes for the agent's
inbound/outbox flow. Maps Telegram bot polling and outbound `sendMessage`
calls to the generic Agentic `tool-services/<name>/inbound` and
`tool-services/<name>/outbox` APIs. Distinct from `telegram.bot` (the
dockerized always-on service in `tools/telegram-bot-service/`); both can run
side-by-side with separate bot tokens, allowed users, and channel identities.

## Registered as
```
name:        channel.telegram.bot
version:     1.0.0
capabilities: channel, messaging, telegram
startup:     always-on (waits for secret context to begin polling)
```

## Implementation
- File: `src/tools/messagingServiceToolBuildProvider.ts`
- Registered in: `src/server/persistence/persistence.module.ts`
- Configuration: `TELEGRAM_BOT_TOKEN` secret handle.

## Future
Either folded into `tools/telegram-bot-service/` (one canonical bot bridge)
or migrated to its own `tools/channel-telegram-bot-service/`. The existence
of both today reflects the Phase-13 dockerization being incomplete for
messaging adapters.
