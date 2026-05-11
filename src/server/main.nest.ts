import "reflect-metadata";

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

  // Allow 25 MB JSON bodies — the Tool Builds form lets the operator
  // attach reference docs (OpenAPI specs, PDFs, README dumps) inline
  // as base64. The per-attachment cap (5 MB) is enforced in
  // parseReferenceAttachments; this just leaves room for a handful
  // of them plus the request envelope.
  app.use(json({ limit: "25mb" }));
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

  app.enableShutdownHooks();

  const port = Number(process.env.NEST_PORT ?? env.port);
  await app.listen(port, "0.0.0.0");
  Logger.log(`Agentic Nest API is running at http://127.0.0.1:${port}`, "Bootstrap");
  if (process.env.SWAGGER_DISABLED !== "true") {
    Logger.log(`OpenAPI docs at http://127.0.0.1:${port}/api/docs`, "Bootstrap");
  }
}

void bootstrap();
