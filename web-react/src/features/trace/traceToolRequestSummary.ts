export type ToolRequestSummary = {
  operation?: string;
  target?: string;
  targetRequested?: string;
  url?: string;
  status?: string;
  providerError?: string;
  providerErrorCategory?: string;
};

export function toolRequestSummary(output: unknown): ToolRequestSummary {
  if (!output || typeof output !== "object") return {};
  const data = (output as { data?: unknown }).data;
  if (!data || typeof data !== "object") return {};
  const request = (data as { request?: unknown }).request;
  const response = (data as { response?: unknown }).response;
  const providerError = (data as { providerError?: unknown }).providerError;
  const req = request && typeof request === "object" ? request as Record<string, unknown> : {};
  const res = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const err = providerError && typeof providerError === "object" ? providerError as Record<string, unknown> : {};
  const operationId = stringField(req.operationId);
  const method = stringField(req.method);
  const status = typeof res.status === "number"
    ? `${res.status}${stringField(res.statusText) ? ` ${stringField(res.statusText)}` : ""}`
    : undefined;
  return {
    operation: operationId ? `${method || "GET"} ${operationId}` : undefined,
    target: stringField(req.target),
    targetRequested: stringField(req.targetRequested),
    url: stringField(req.url) || stringField(res.url),
    status,
    providerError: stringField(err.summary),
    providerErrorCategory: stringField(err.category),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}
