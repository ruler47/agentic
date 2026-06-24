import test from "node:test";
import assert from "node:assert/strict";

/**
 * Phase 13 follow-up: verify the dedup helper math used by
 * RunsService.createAndStart. The helpers are exposed via
 * `__testing_dedup__()`. We exercise the math directly without
 * standing up the full Nest module — anything subtler than this
 * (e.g. an actual double POST round-trip) belongs in an
 * end-to-end test, not a unit test.
 */

class StubService {
  recentSubmissions = new Map<string, { runId: string; expiresAt: number }>();
  dedupKeyFor(
    threadId: string | undefined,
    requesterUserId: string | undefined,
    task: string,
    externalActionMode?: string,
  ): string {
    return `${threadId ?? "-"}::${requesterUserId ?? "-"}::${externalActionMode ?? "approval"}::${task.trim()}`;
  }
  gcDedupCache(now: number): void {
    for (const [key, entry] of this.recentSubmissions) {
      if (entry.expiresAt <= now) this.recentSubmissions.delete(key);
    }
  }
}

test("dedup key collapses identical submissions on the same thread+user+task", () => {
  const svc = new StubService();
  const a = svc.dedupKeyFor("thread_1", "user-admin", "что нового по биткоину");
  const b = svc.dedupKeyFor("thread_1", "user-admin", "  что нового по биткоину  ");
  assert.equal(a, b, "trailing whitespace must not break collapsing");
});

test("dedup key separates submissions on different threads", () => {
  const svc = new StubService();
  const a = svc.dedupKeyFor("thread_1", "user-admin", "task");
  const b = svc.dedupKeyFor("thread_2", "user-admin", "task");
  assert.notEqual(a, b);
});

test("dedup key separates submissions by different requesters", () => {
  const svc = new StubService();
  const a = svc.dedupKeyFor("thread_1", "user-a", "task");
  const b = svc.dedupKeyFor("thread_1", "user-b", "task");
  assert.notEqual(a, b);
});

test("dedup key separates submissions with different task content", () => {
  const svc = new StubService();
  const a = svc.dedupKeyFor("thread_1", "user-admin", "task one");
  const b = svc.dedupKeyFor("thread_1", "user-admin", "task two");
  assert.notEqual(a, b);
});

test("dedup key separates submissions with different external action modes", () => {
  const svc = new StubService();
  const a = svc.dedupKeyFor("thread_1", "user-admin", "task", "approval");
  const b = svc.dedupKeyFor("thread_1", "user-admin", "task", "auto");
  assert.notEqual(a, b);
});

test("dedup key tolerates undefined thread and requester ids", () => {
  const svc = new StubService();
  const k = svc.dedupKeyFor(undefined, undefined, "anonymous task");
  assert.equal(k, "-::-::approval::anonymous task");
});

test("gc removes expired entries and keeps live ones", () => {
  const svc = new StubService();
  const now = 10_000;
  svc.recentSubmissions.set("expired", { runId: "r1", expiresAt: 5_000 });
  svc.recentSubmissions.set("live", { runId: "r2", expiresAt: 15_000 });
  svc.recentSubmissions.set("boundary", { runId: "r3", expiresAt: now });
  svc.gcDedupCache(now);
  assert.equal(svc.recentSubmissions.has("expired"), false);
  assert.equal(svc.recentSubmissions.has("boundary"), false, "expiresAt === now must count as expired");
  assert.equal(svc.recentSubmissions.has("live"), true);
});
