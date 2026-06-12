import { createHash, timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { APP_ENV } from "../../config/config.module.js";
import type { AppEnv } from "../../config/env.js";

/**
 * Opt-in shared-token gate for the whole /api surface.
 *
 * The platform runs one instance per household/team, so a single shared
 * operator token is the right first auth boundary: without it the API on
 * 0.0.0.0 lets anyone run tools, read secret handles, and delete
 * artifacts. When AGENTIC_API_TOKEN is unset nothing changes (local dev).
 *
 * Exempt paths:
 * - /api/health           — monitoring probes;
 * - /api/tools/callbacks/* — tool services authenticate with their own
 *                           HMAC callback tokens;
 * - /api/fixtures/*       — local safe fixture pages fetched by browser
 *                           tools during external-action exams.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.env.apiAuthToken;
    if (!token) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path ?? request.url ?? "";
    if (!path.startsWith("/api/")) return true;
    if (
      path === "/api/health" ||
      path.startsWith("/api/tools/callbacks/") ||
      path.startsWith("/api/fixtures/")
    ) {
      return true;
    }
    const presented = presentedToken(request);
    if (presented && tokensMatch(presented, token)) return true;
    throw new UnauthorizedException(
      "API token required: send Authorization: Bearer <token>, x-agentic-token, or ?token=.",
    );
  }
}

function presentedToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, "").trim() || undefined;
  }
  const custom = request.headers["x-agentic-token"];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  const query = request.query?.token;
  if (typeof query === "string" && query.trim()) return query.trim();
  return undefined;
}

function tokensMatch(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
