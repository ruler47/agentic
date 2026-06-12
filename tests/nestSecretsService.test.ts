import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditEventStore } from "../src/audit/inMemoryAuditEventStore.js";
import { InMemorySecretHandleStore } from "../src/secrets/secretHandleStore.js";
import { AuditService } from "../src/server/common/services/audit.service.js";
import { SecretsService } from "../src/server/modules/secrets/secrets.service.js";

test("Nest SecretsService redacts inline secret refs from public API responses and audit metadata", async () => {
  const auditStore = new InMemoryAuditEventStore();
  const service = new SecretsService(new InMemorySecretHandleStore(), new AuditService(auditStore));

  const created = await service.create(
    {
      handle: "secret.inline.smoke",
      label: "Inline smoke",
      provider: "inline",
      secretRef: "INLINE-SECRET-SHOULD-NOT-LEAK",
    },
    {
      handle: "secret.inline.smoke",
      label: "Inline smoke",
      provider: "inline",
      secretRef: "INLINE-SECRET-SHOULD-NOT-LEAK",
    },
  );
  const listed = await service.list();
  const detail = await service.get("secret.inline.smoke");
  const deleted = await service.delete("secret.inline.smoke");
  const audit = await auditStore.list(20);

  assert.equal(created.secretRef, "[redacted inline secret]");
  assert.equal(listed[0]?.secretRef, "[redacted inline secret]");
  assert.equal(detail.secretRef, "[redacted inline secret]");
  assert.equal(deleted.secretHandle.secretRef, "[redacted inline secret]");
  assert.doesNotMatch(JSON.stringify({ created, listed, detail, deleted, audit }), /INLINE-SECRET-SHOULD-NOT-LEAK/);
});

test("Nest SecretsService keeps env secret refs visible because they are handles, not raw credentials", async () => {
  const service = new SecretsService(new InMemorySecretHandleStore(), new AuditService(new InMemoryAuditEventStore()));

  const created = await service.create(
    {
      handle: "secret.telegram.bot",
      label: "Telegram bot",
      provider: "env",
      secretRef: "TELEGRAM_BOT_TOKEN",
    },
    {
      handle: "secret.telegram.bot",
      label: "Telegram bot",
      provider: "env",
      secretRef: "TELEGRAM_BOT_TOKEN",
    },
  );

  assert.equal(created.secretRef, "TELEGRAM_BOT_TOKEN");
});

test("Nest SecretsService reports registered and resolvable handle status without leaking values", async () => {
  const service = new SecretsService(new InMemorySecretHandleStore(), new AuditService(new InMemoryAuditEventStore()));
  await service.create(
    {
      handle: "secret.inline.status",
      label: "Inline status",
      provider: "inline",
      secretRef: "INLINE-STATUS-SECRET",
    },
    {
      handle: "secret.inline.status",
      label: "Inline status",
      provider: "inline",
      secretRef: "INLINE-STATUS-SECRET",
    },
  );
  await service.create(
    {
      handle: "secret.env.status",
      label: "Env status",
      provider: "env",
      secretRef: "MISSING_STATUS_ENV",
    },
    {
      handle: "secret.env.status",
      label: "Env status",
      provider: "env",
      secretRef: "MISSING_STATUS_ENV",
    },
  );

  const status = await service.status([
    "secret.inline.status",
    "secret.env.status",
    "secret.missing.status",
  ]);

  assert.deepEqual(status.handles.map((handle) => ({
    handle: handle.handle,
    registered: handle.registered,
    resolvable: handle.resolvable,
    reason: handle.reason,
    secretRef: handle.secretRef,
  })), [
    {
      handle: "secret.inline.status",
      registered: true,
      resolvable: true,
      reason: "resolved",
      secretRef: "[redacted inline secret]",
    },
    {
      handle: "secret.env.status",
      registered: true,
      resolvable: false,
      reason: "unresolved",
      secretRef: "MISSING_STATUS_ENV",
    },
    {
      handle: "secret.missing.status",
      registered: false,
      resolvable: false,
      reason: "not_registered",
      secretRef: undefined,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(status), /INLINE-STATUS-SECRET/);
});
