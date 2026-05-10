import "reflect-metadata";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BadRequestException, Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json, type NextFunction, type Request, type Response } from "express";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./common/filters/api-exception.filter.js";
import { readEnv } from "./config/env.js";

async function bootstrap() {
  const env = readEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
  });

  app.use(json());
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown };
    if (
      candidate?.type === "entity.parse.failed" ||
      candidate?.status === 400 ||
      candidate?.statusCode === 400
    ) {
      response
        .status(400)
        .type("application/json")
        .send({ error: `Invalid JSON request body: ${String(candidate.message ?? "parse failed")}` });
      return;
    }
    next(error);
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        const messages = errors.flatMap((error) => Object.values(error.constraints ?? {}));
        return new BadRequestException(messages[0] ?? "Validation failed");
      },
    }),
  );

  if (process.env.SWAGGER_DISABLED !== "true") {
    const config = new DocumentBuilder()
      .setTitle("Agentic Universal Agent API")
      .setDescription("Coordinator + tool registry + run lifecycle for the Agentic platform.")
      .setVersion("0.1.0")
      .addServer("/")
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/docs", app, document, {
      jsonDocumentUrl: "api/docs-json",
      yamlDocumentUrl: "api/docs-yaml",
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Phase 13 follow-up (Bug D): SPA fallback for hash-routed deep links
  // (`/tools`, `/runs/:id`). Mounted after ServeStaticModule (which is
  // registered as Express middleware by @nestjs/serve-static — concrete
  // files like `/assets/index-*.js` are served by it) but BEFORE Nest's
  // controller routing — so an unknown non-API path falls through to
  // the SPA shell instead of returning a JSON 404. The "after static,
  // before routing" order is what an earlier @Get('*') controller could
  // not give us: that one was matched by Nest before
  // `serve-static` had a chance to look for the file, breaking
  // `/assets/...` lookups entirely.
  const publicDir = resolve(process.env.PUBLIC_DIR ?? "public");
  const indexPath = resolve(publicDir, "index.html");
  let cachedIndexHtml: string | undefined;
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();
    const path = req.path.split("?")[0] ?? "/";
    if (path.startsWith("/api/") || path === "/api") return next();
    // Static assets (anything with a `.` in the last segment) — let
    // serve-static / 404 handle them.
    const lastSegment = path.split("/").filter(Boolean).pop() ?? "";
    if (lastSegment.includes(".")) return next();
    const accept = (req.headers["accept"] ?? "").toString();
    if (accept && !accept.includes("text/html") && !accept.includes("*/*")) return next();
    try {
      if (!cachedIndexHtml) cachedIndexHtml = await readFile(indexPath, "utf8");
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.send(cachedIndexHtml);
    } catch (error) {
      // Swallow → falls through to Nest 404 with a clear message.
      Logger.warn(
        `SPA fallback could not read ${indexPath}: ${error instanceof Error ? error.message : "unknown"}`,
        "SpaFallback",
      );
      next();
    }
  });

  app.enableShutdownHooks();

  const port = Number(process.env.NEST_PORT ?? env.port);
  await app.listen(port, "0.0.0.0");
  Logger.log(`Agentic Nest API is running at http://127.0.0.1:${port}`, "Bootstrap");
  if (process.env.SWAGGER_DISABLED !== "true") {
    Logger.log(`OpenAPI docs at http://127.0.0.1:${port}/api/docs`, "Bootstrap");
  }
}

void bootstrap();
