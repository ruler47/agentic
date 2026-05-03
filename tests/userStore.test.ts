import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryUserStore } from "../src/instance/userStore.js";

test("in-memory user store resolves the default local admin", async () => {
  const store = new InMemoryUserStore();

  const user = await store.resolve({});

  assert.equal(user?.id, "user-admin");
  assert.equal(user?.roles.includes("admin"), true);
  assert.equal(user?.identities[0].provider, "web");
});

test("in-memory user store resolves explicit requester ids", async () => {
  const store = new InMemoryUserStore({
    users: [{ id: "user-dima", displayName: "Dima", role: "member" }],
    identities: [],
    defaultUserId: "user-dima",
  });

  assert.equal((await store.resolve({ requesterUserId: "user-dima" }))?.displayName, "Dima");
  assert.equal(await store.resolve({ requesterUserId: "missing" }), undefined);
});

test("in-memory user store resolves allowed channel identities only", async () => {
  const store = new InMemoryUserStore({
    users: [
      { id: "user-dima", displayName: "Dima", role: "member" },
      { id: "user-blocked", displayName: "Blocked", role: "member" },
    ],
    identities: [
      {
        provider: "Telegram",
        providerUserId: "tg-allowed",
        userId: "user-dima",
        allowStatus: "allowed",
      },
      {
        provider: "telegram",
        providerUserId: "tg-blocked",
        userId: "user-blocked",
        allowStatus: "blocked",
      },
    ],
  });

  assert.equal(
    (await store.resolve({ channel: "telegram", sourceUserId: "tg-allowed" }))?.id,
    "user-dima",
  );
  assert.equal(await store.resolve({ channel: "telegram", sourceUserId: "tg-blocked" }), undefined);
  assert.equal(await store.resolve({ channel: "telegram", sourceUserId: "tg-missing" }), undefined);
});

test("in-memory user store manages users and channel identities", async () => {
  const store = new InMemoryUserStore();

  const user = await store.create({
    id: "user-family",
    displayName: "Family Member",
    roles: ["member", "viewer"],
  });
  const identity = await store.createIdentity({
    provider: "Telegram",
    providerUserId: "tg-family",
    userId: user.id,
  });

  assert.equal(user.role, "member");
  assert.equal(identity.provider, "telegram");
  assert.equal((await store.resolve({ channel: "telegram", sourceUserId: "tg-family" }))?.id, user.id);

  await store.updateIdentity(identity.id, { allowStatus: "blocked" });
  assert.equal(await store.resolve({ channel: "telegram", sourceUserId: "tg-family" }), undefined);

  const updated = await store.update(user.id, {
    displayName: "Family Lead",
    roles: ["admin", "member"],
  });
  assert.equal(updated.displayName, "Family Lead");
  assert.deepEqual(updated.roles, ["admin", "member"]);

  assert.equal(await store.deleteIdentity(identity.id), true);
  assert.equal((await store.get(user.id))?.identities.length, 0);
  assert.equal(await store.delete(user.id), true);
  assert.equal(await store.get(user.id), undefined);
});
