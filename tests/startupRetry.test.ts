import test from "node:test";
import assert from "node:assert/strict";
import { withStartupRetry } from "../src/server/persistence/persistence.module.js";

test("withStartupRetry retries transient startup failures and returns success", async () => {
  let calls = 0;

  const result = await withStartupRetry(
    "test operation",
    async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("temporary reset") as Error & { code: string };
        error.code = "ECONNRESET";
        throw error;
      }
      return "ok";
    },
    { attempts: 4, delayMs: 0 },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withStartupRetry does not retry non-transient startup failures", async () => {
  let calls = 0;

  await assert.rejects(
    () =>
      withStartupRetry(
        "test operation",
        async () => {
          calls += 1;
          throw new Error("schema is broken");
        },
        { attempts: 4, delayMs: 0 },
      ),
    /schema is broken/,
  );

  assert.equal(calls, 1);
});
