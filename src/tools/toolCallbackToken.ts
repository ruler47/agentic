import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Phase 13: lightweight HMAC-signed callback tokens for the
 * runtime <-> tool service boundary. A single agentic run that
 * spawns one or more tool containers must give each container a
 * short-lived, narrowly-scoped credential that lets the tool call
 * back into the runtime (saveArtifact, ledger.claim, memory.search,
 * runEvent emission). The token format is intentionally tiny
 * because the tool side does not need to verify it — only the
 * runtime callback API does — and a full JWT library would add
 * dependencies for a feature that is just "HMAC over a JSON blob".
 *
 * Format: `<base64url(payload)>.<base64url(hmac-sha256)>`.
 * Payload is JSON `{ runId, toolName, exp, scope[] }`.
 */

export type ToolCallbackScope =
  | "artifacts.save"
  | "ledger.claim"
  | "memory.search"
  | "events.emit"
  | "*";

export type ToolCallbackTokenClaims = {
  runId: string;
  toolName: string;
  /** Unix-epoch milliseconds when the token expires. */
  exp: number;
  /** Scopes the bearer is allowed to call. `*` grants all. */
  scope: ToolCallbackScope[];
  /** Random nonce so the same claims produce distinct tokens. */
  nonce: string;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type ToolCallbackTokenIssuerOptions = {
  /**
   * Symmetric secret used to sign tokens. In production, supply via
   * `TOOL_CALLBACK_SECRET` env. In tests, the issuer auto-generates
   * a per-process random secret if no value is provided.
   */
  secret?: Buffer | string;
  /** TTL applied when no explicit `exp` is passed at issue time. */
  defaultTtlMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
};

export class ToolCallbackTokenIssuer {
  private readonly secret: Buffer;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(options: ToolCallbackTokenIssuerOptions = {}) {
    const provided = options.secret ?? process.env.TOOL_CALLBACK_SECRET;
    this.secret = provided
      ? typeof provided === "string"
        ? Buffer.from(provided, "utf8")
        : provided
      : randomBytes(32);
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Issue a fresh token. The caller controls scope and TTL; the
   * issuer adds a random nonce to keep tokens distinct even when
   * they describe identical claims.
   */
  issue(input: {
    runId: string;
    toolName: string;
    scope: ToolCallbackScope[];
    ttlMs?: number;
  }): string {
    const claims: ToolCallbackTokenClaims = {
      runId: input.runId,
      toolName: input.toolName,
      scope: [...input.scope],
      exp: this.now() + (input.ttlMs ?? this.defaultTtlMs),
      nonce: randomBytes(8).toString("hex"),
    };
    const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
    const signature = base64UrlEncode(this.signRaw(payload));
    return `${payload}.${signature}`;
  }

  /**
   * Verify a token presented by a callback caller. Throws when:
   *   - the encoding is malformed
   *   - the signature does not match
   *   - the token has expired
   * Otherwise returns the parsed claims.
   */
  verify(token: string): ToolCallbackTokenClaims {
    const parts = (token ?? "").split(".");
    if (parts.length !== 2) {
      throw new ToolCallbackTokenError("Invalid token format");
    }
    const [payload, signature] = parts;
    if (!payload || !signature) {
      throw new ToolCallbackTokenError("Invalid token format");
    }
    const expected = base64UrlEncode(this.signRaw(payload));
    if (!constantTimeStringEqual(expected, signature)) {
      throw new ToolCallbackTokenError("Token signature mismatch");
    }
    let claims: ToolCallbackTokenClaims;
    try {
      claims = JSON.parse(base64UrlDecode(payload).toString("utf8")) as ToolCallbackTokenClaims;
    } catch {
      throw new ToolCallbackTokenError("Token payload is not valid JSON");
    }
    if (
      typeof claims.runId !== "string" ||
      typeof claims.toolName !== "string" ||
      typeof claims.exp !== "number" ||
      !Array.isArray(claims.scope)
    ) {
      throw new ToolCallbackTokenError("Token claims are incomplete");
    }
    if (this.now() >= claims.exp) {
      throw new ToolCallbackTokenError("Token has expired");
    }
    return claims;
  }

  /**
   * Convenience: assert the token grants the requested scope.
   * Throws when the bearer does not have access. The "*" scope
   * grants all.
   */
  assertScope(claims: ToolCallbackTokenClaims, required: ToolCallbackScope): void {
    if (claims.scope.includes("*")) return;
    if (claims.scope.includes(required)) return;
    throw new ToolCallbackTokenError(
      `Token does not include required scope ${required} (granted: ${claims.scope.join(", ") || "none"})`,
    );
  }

  private signRaw(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(payload).digest();
  }
}

export class ToolCallbackTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCallbackTokenError";
  }
}

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64");
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
