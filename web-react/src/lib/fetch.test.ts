import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/lib/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(body: unknown, init: { status?: number; contentType?: string } = {}): Response {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? "application/json; charset=utf-8";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": contentType },
  });
}

describe("apiFetch", () => {
  it("returns parsed JSON on 2xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({ ok: true, value: 42 }),
    ) as unknown as typeof fetch;
    const result = await apiFetch<{ ok: boolean; value: number }>("/api/health");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it("throws ApiError carrying server-provided error message", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse({ error: "ambiguous", code: "investigation_promotion_ambiguous" }, { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      message: "ambiguous",
    });
    try {
      await apiFetch("/api/x");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).body).toMatchObject({ code: "investigation_promotion_ambiguous" });
    }
  });

  it("falls back to a synthesized message when server omits error.text", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockResponse("opaque", { status: 503, contentType: "text/plain" }),
    ) as unknown as typeof fetch;
    await expect(apiFetch("/api/missing", { method: "GET" })).rejects.toMatchObject({
      message: "GET /api/missing failed with 503",
      status: 503,
    });
  });

  it("serializes JSON bodies and sets content-type when body is provided", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ ok: true })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    await apiFetch("/api/x", { method: "POST", body: { hello: "world" } });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ hello: "world" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});
