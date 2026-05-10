import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Controller, Get, Header, HttpException, HttpStatus, Req } from "@nestjs/common";
import type { Request } from "express";

/**
 * Phase 13 follow-up: SPA fallback for the web console.
 *
 * The console uses hash routing (`#/tools`, `#/runs/<id>`), so the
 * canonical URL of every page is `/`. But operators sometimes paste
 * the path-only form (`/tools`, `/runs`) — typed manually, copied
 * from a stripped link, or autocompleted from history. Without a
 * fallback, Express hits Nest's catch-all 404 and returns the JSON
 * error `{"error":"Cannot GET /tools"}` on refresh.
 *
 * This controller serves `public/index.html` for any GET request
 * whose path:
 *   1. is NOT under `/api/...` (those reach the real REST handlers),
 *   2. does NOT contain a `.` in the last segment (so static asset
 *      paths like `/assets/index-…js` keep falling through to
 *      ServeStaticModule and never get the HTML by mistake), and
 *   3. has an `accept` header that wants HTML (browsers; not curl
 *      hitting `/api/health` with a typo).
 *
 * The companion path→hash redirect at the top of `public/app.js`
 * ensures the loaded SPA actually navigates to the right page.
 */
@Controller()
export class SpaFallbackController {
  // Catch-all wildcard. The handler itself filters out api/ paths,
  // static assets (anything with a `.` in the last segment), and
  // non-HTML accept headers, so the route is conceptually:
  //   GET ANY/non-API/non-static  →  public/index.html
  @Get("*splat")
  @Header("content-type", "text/html; charset=utf-8")
  @Header("cache-control", "no-store")
  async serveIndex(@Req() req: Request): Promise<string> {
    const path = (req.path ?? req.url ?? "/").split("?")[0]!;
    if (path.startsWith("/api/") || path === "/api") {
      throw new HttpException(`Cannot GET ${path}`, HttpStatus.NOT_FOUND);
    }
    const lastSegment = path.split("/").filter(Boolean).pop() ?? "";
    if (lastSegment.includes(".")) {
      // Static asset that ServeStaticModule didn't have — keep the 404
      // so the browser shows a real broken-asset error instead of the
      // SPA shell.
      throw new HttpException(`Cannot GET ${path}`, HttpStatus.NOT_FOUND);
    }
    const accept = (req.headers["accept"] ?? "").toString();
    if (accept && !accept.includes("text/html") && !accept.includes("*/*")) {
      throw new HttpException(`Cannot GET ${path}`, HttpStatus.NOT_FOUND);
    }
    const root = resolve(process.env.PUBLIC_DIR ?? "public");
    const indexPath = resolve(root, "index.html");
    try {
      return await readFile(indexPath, "utf8");
    } catch (error) {
      throw new HttpException(
        `SPA fallback could not read ${indexPath}: ${error instanceof Error ? error.message : "unknown error"}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
