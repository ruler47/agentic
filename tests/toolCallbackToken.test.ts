import test from "node:test";
import assert from "node:assert/strict";
import { ToolCallbackTokenError, ToolCallbackTokenIssuer } from "../src/tools/toolCallbackToken.js";

test("ToolCallbackTokenIssuer: round-trip issue + verify", () => {
  const issuer = new ToolCallbackTokenIssuer({ secret: "test-secret" });
  const token = issuer.issue({
    runId: "run_1",
    toolName: "browser.operate",
    scope: ["artifacts.save"],
  });
  const claims = issuer.verify(token);
  assert.equal(claims.runId, "run_1");
  assert.equal(claims.toolName, "browser.operate");
  assert.deepEqual(claims.scope, ["artifacts.save"]);
});

test("ToolCallbackTokenIssuer: rejects tampered tokens", () => {
  const issuer = new ToolCallbackTokenIssuer({ secret: "test-secret" });
  const token = issuer.issue({ runId: "r", toolName: "t", scope: ["*"] });
  const [payload] = token.split(".");
  // Replace signature with garbage of same length
  const tampered = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  assert.throws(() => issuer.verify(tampered), /signature mismatch/i);
});

test("ToolCallbackTokenIssuer: rejects tokens signed with a different secret", () => {
  const issuer1 = new ToolCallbackTokenIssuer({ secret: "secret-a" });
  const issuer2 = new ToolCallbackTokenIssuer({ secret: "secret-b" });
  const token = issuer1.issue({ runId: "r", toolName: "t", scope: ["*"] });
  assert.throws(() => issuer2.verify(token), ToolCallbackTokenError);
});

test("ToolCallbackTokenIssuer: rejects expired tokens", () => {
  let now = 1_000_000;
  const issuer = new ToolCallbackTokenIssuer({ secret: "s", now: () => now });
  const token = issuer.issue({ runId: "r", toolName: "t", scope: ["*"], ttlMs: 100 });
  // Advance past expiry
  now = 1_000_500;
  assert.throws(() => issuer.verify(token), /expired/i);
});

test("ToolCallbackTokenIssuer: rejects malformed tokens", () => {
  const issuer = new ToolCallbackTokenIssuer({ secret: "s" });
  assert.throws(() => issuer.verify(""), /Invalid token format/);
  assert.throws(() => issuer.verify("only-one-segment"), /Invalid token format/);
  assert.throws(() => issuer.verify("not-base64.also-not-valid"), /signature/i);
});

test("ToolCallbackTokenIssuer: assertScope grants when scope present", () => {
  const issuer = new ToolCallbackTokenIssuer({ secret: "s" });
  const token = issuer.issue({
    runId: "r",
    toolName: "t",
    scope: ["artifacts.save", "ledger.claim"],
  });
  const claims = issuer.verify(token);
  issuer.assertScope(claims, "artifacts.save");
  issuer.assertScope(claims, "ledger.claim");
  assert.throws(() => issuer.assertScope(claims, "memory.search"), /memory.search/);
});

test("ToolCallbackTokenIssuer: '*' scope grants everything", () => {
  const issuer = new ToolCallbackTokenIssuer({ secret: "s" });
  const token = issuer.issue({ runId: "r", toolName: "t", scope: ["*"] });
  const claims = issuer.verify(token);
  issuer.assertScope(claims, "artifacts.save");
  issuer.assertScope(claims, "memory.search");
  issuer.assertScope(claims, "events.emit");
});

test("ToolCallbackTokenIssuer: distinct nonces produce distinct tokens", () => {
  const issuer = new ToolCallbackTokenIssuer({ secret: "s" });
  const t1 = issuer.issue({ runId: "r", toolName: "t", scope: ["*"] });
  const t2 = issuer.issue({ runId: "r", toolName: "t", scope: ["*"] });
  assert.notEqual(t1, t2);
});
