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
