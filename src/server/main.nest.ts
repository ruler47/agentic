import "reflect-metadata";

import { BadRequestException, Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./common/filters/api-exception.filter.js";
import { readEnv } from "./config/env.js";

async function bootstrap() {
  const env = readEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
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
