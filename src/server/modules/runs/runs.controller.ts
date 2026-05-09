import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  Sse,
} from "@nestjs/common";
import type { Response } from "express";
import { Observable } from "rxjs";
import { RUN_STORE } from "../../persistence/tokens.js";
import type { RunStore } from "../../../runs/types.js";
import { RunsService } from "./runs.service.js";

@Controller("api")
export class RunsController {
  constructor(
    @Inject(RunsService)
    private readonly service: RunsService,
    @Inject(RUN_STORE) private readonly runs: RunStore,
  ) {}

  @Get("runs")
  async list() {
    return { runs: await this.service.list() };
  }

  @Post("runs")
  @HttpCode(202)
  async create(@Body() body: unknown) {
    return this.service.createAndStart(body);
  }

  @Post("conversation-threads/:threadId/runs")
  @HttpCode(202)
  async createInThread(@Param("threadId") threadId: string, @Body() body: unknown) {
    const merged = {
      ...((body && typeof body === "object" && !Array.isArray(body)) ? (body as Record<string, unknown>) : {}),
      threadId: decodeURIComponent(threadId),
    };
    return this.service.createAndStart(merged);
  }

  @Get("runs/:id")
  async get(@Param("id") id: string) {
    return { run: await this.service.get(decodeURIComponent(id)) };
  }

  @Post("runs/:id/cancel")
  async cancel(@Param("id") id: string, @Body() body: unknown) {
    return { run: await this.service.cancel(decodeURIComponent(id), body) };
  }

  @Post("runs/:id/restart")
  @HttpCode(202)
  async restart(@Param("id") id: string) {
    const result = await this.service.restart(decodeURIComponent(id));
    return { source: result.source, restart: result.restart };
  }

  @Post("runs/:id/resume")
  @HttpCode(202)
  async resume(@Param("id") id: string) {
    const result = await this.service.resume(decodeURIComponent(id));
    return {
      source: result.source,
      resume: result.resume,
      fallback: result.fallback,
      progress: result.progress,
    };
  }

  @Get("runs/:id/artifacts/:artifactId")
  async downloadArtifact(
    @Param("id") id: string,
    @Param("artifactId") artifactId: string,
    @Res() response: Response,
  ) {
    const { stored, buffer } = await this.service.getArtifact(
      decodeURIComponent(id),
      decodeURIComponent(artifactId),
    );
    response
      .status(200)
      .set({
        "content-type": stored.artifact.mimeType,
        "content-length": String(stored.artifact.sizeBytes),
        "content-disposition": `inline; filename="${stored.artifact.filename.replace(/"/g, "")}"`,
        "cache-control": "no-store",
      })
      .send(buffer);
  }

  @Sse("runs/:id/events")
  events(@Param("id") id: string): Observable<MessageEvent> {
    const decoded = decodeURIComponent(id);
    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let lastSignature = "";
      let pollTimer: NodeJS.Timeout | undefined;
      let heartbeatTimer: NodeJS.Timeout | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      };

      const writeRun = async () => {
        if (closed) return;
        const run = await this.runs.get(decoded);
        if (!run) {
          subscriber.next({ type: "error", data: { error: "Run not found" } } as MessageEvent);
          subscriber.complete();
          close();
          return;
        }
        const signature = [
          run.status,
          run.updatedAt,
          run.events.length,
          run.result ? "result" : "",
          run.error ?? "",
        ].join(":");
        if (signature === lastSignature) return;
        lastSignature = signature;
        subscriber.next({ type: "run", data: { run } } as MessageEvent);
        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          subscriber.complete();
          close();
        }
      };

      pollTimer = setInterval(() => {
        void writeRun().catch((error) => {
          if (closed) return;
          subscriber.next({
            type: "error",
            data: { error: error instanceof Error ? error.message : "Run stream failed" },
          } as MessageEvent);
          subscriber.complete();
          close();
        });
      }, 650);

      heartbeatTimer = setInterval(() => {
        if (!closed) subscriber.next({ data: ":heartbeat" } as MessageEvent);
      }, 15000);

      void writeRun();

      return () => close();
    });
  }
}
