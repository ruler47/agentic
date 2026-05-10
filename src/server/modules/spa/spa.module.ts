import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Injectable,
  Logger,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * Phase 13 follow-up (Bug D): SPA fallback middleware. When the user
 * refreshes a hash-routed URL the client typed without `#`
 * (`/tools`, `/runs/:id`, …), Nest would otherwise hand back the
 * generic 404 JSON `{"error":"Cannot GET /tools"}`. This middleware
 * intercepts the request and returns `${PUBLIC_DIR}/index.html`
 * instead so the SPA shell loads, and react-router (which uses
 * createBrowserRouter) takes it from there.
 *
 * Wired through NestModule + MiddlewareConsumer so it runs AFTER
 * ServeStaticModule's static-asset layer but BEFORE Nest controller
 * routing. An earlier attempt registered an `@Get('*')` controller —
 * that intercepted /assets/index-*.js requests before serve-static
 * had a chance to find the file, breaking the React bundle entirely.
 */
@Injectable()
export class SpaFallbackMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SpaFallbackMiddleware.name);
  private readonly publicDir = resolve(process.env.PUBLIC_DIR ?? "public");
  private readonly indexPath = resolve(this.publicDir, "index.html");
  private cachedHtml: string | undefined;

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // Use originalUrl — `req.path` inside a Nest-mounted middleware can be
    // stripped of the prefix the middleware was attached to. originalUrl
    // is always the raw incoming URL.
    const raw = (req.originalUrl ?? req.url ?? "/").split("?")[0]!;
    if (raw.startsWith("/api/") || raw === "/api" || raw.startsWith("/swagger")) {
      return next();
    }
    // Static asset paths (anything with a `.` in the last segment) —
    // let serve-static answer (or its real 404 surface).
    const lastSegment = raw.split("/").filter(Boolean).pop() ?? "";
    if (lastSegment.includes(".")) return next();
    const accept = (req.headers["accept"] ?? "").toString();
    if (accept && !accept.includes("text/html") && !accept.includes("*/*")) return next();

    try {
      if (!this.cachedHtml) this.cachedHtml = await readFile(this.indexPath, "utf8");
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.send(this.cachedHtml);
    } catch (error) {
      this.logger.warn(
        `SPA fallback could not read ${this.indexPath}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      next();
    }
  }
}

@Module({
  providers: [SpaFallbackMiddleware],
})
export class SpaModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SpaFallbackMiddleware).forRoutes("*");
  }
}
