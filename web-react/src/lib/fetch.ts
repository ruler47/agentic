/**
 * Thin fetch wrapper that mirrors the legacy `fetchJson` semantics from
 * public/app.js: JSON in, JSON out, throws on non-2xx with the server-provided
 * error payload preserved on the thrown Error.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const init: RequestInit = {
    ...rest,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && "error" in (payload as Record<string, unknown>) &&
        typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `${init.method ?? "GET"} ${path} failed with ${response.status}`);
    throw new ApiError(message, response.status, payload);
  }

  return payload as T;
}
