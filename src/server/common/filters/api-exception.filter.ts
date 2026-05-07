import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const { status, message } = this.toErrorResponse(exception);

    if (status >= 500) {
      this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    }

    if (response.headersSent) return;
    response.status(status).type("application/json").send({ error: message });
  }

  private toErrorResponse(exception: unknown): { status: number; message: string } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = this.extractMessage(body) ?? exception.message;
      return { status, message };
    }
    if (exception instanceof Error) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: exception.message };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: "Unknown server error" };
  }

  private extractMessage(body: unknown): string | undefined {
    if (typeof body === "string") return body;
    if (body && typeof body === "object") {
      const candidate = body as { error?: unknown; message?: unknown };
      if (typeof candidate.message === "string") return candidate.message;
      if (Array.isArray(candidate.message) && candidate.message.length > 0) {
        return candidate.message.map((line) => String(line)).join("; ");
      }
      if (typeof candidate.error === "string") return candidate.error;
    }
    return undefined;
  }
}
