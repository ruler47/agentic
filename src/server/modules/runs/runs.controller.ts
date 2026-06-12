import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  Sse,
} from "@nestjs/common";
import type { Response } from "express";
import { Observable } from "rxjs";
import { RUN_STORE } from "../../persistence/tokens.js";
import type { RunStore } from "../../../runs/types.js";
import { ActionProposalAutoModeService } from "./action-proposal-auto-mode.service.js";
import { ActionProposalsService } from "./action-proposals.service.js";
import { RunsService } from "./runs.service.js";

@Controller("api")
export class RunsController {
  constructor(
    @Inject(RunsService)
    private readonly service: RunsService,
    @Inject(ActionProposalsService)
    private readonly actionProposals: ActionProposalsService,
    @Inject(ActionProposalAutoModeService)
    private readonly actionProposalAutoMode: ActionProposalAutoModeService,
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

  @Get("action-proposals")
  async listActionProposals() {
    return { proposals: await this.actionProposals.listActionProposals() };
  }

  @Post("action-proposals/fixture")
  @HttpCode(201)
  async createFixtureActionProposal(@Body() body: unknown) {
    const proposal = await this.actionProposals.createFixtureActionProposal(body);
    if (
      proposal.proposal.executionMode === "auto" &&
      !proposal.proposal.approvalRequired
    ) {
      const [updated] =
        await this.actionProposalAutoMode.commitReadyAutoProposalsForRun(
          proposal.run.id,
          body,
        );
      return { proposal: updated ?? proposal };
    }
    return {
      proposal,
    };
  }

  @Post("action-proposals/:proposalId/approve")
  @HttpCode(200)
  async approveActionProposal(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
  ) {
    return {
      proposal: await this.actionProposals.decideActionProposal(
        decodeURIComponent(proposalId),
        "approved",
        body,
      ),
    };
  }

  @Post("action-proposals/:proposalId/reject")
  @HttpCode(200)
  async rejectActionProposal(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
  ) {
    return {
      proposal: await this.actionProposals.decideActionProposal(
        decodeURIComponent(proposalId),
        "rejected",
        body,
      ),
    };
  }

  @Post("action-proposals/:proposalId/commit")
  @HttpCode(200)
  async commitActionProposal(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
  ) {
    return {
      proposal: await this.actionProposals.commitActionProposal(
        decodeURIComponent(proposalId),
        body,
      ),
    };
  }

  @Post("action-proposals/:proposalId/prepare")
  @HttpCode(200)
  async prepareActionProposal(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
  ) {
    return {
      proposal: await this.actionProposals.prepareActionProposal(
        decodeURIComponent(proposalId),
        body,
      ),
    };
  }

  @Post("action-proposals/:proposalId/profile-hydration/approve")
  @HttpCode(200)
  async approveActionProposalProfileHydration(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
  ) {
    return {
      proposal: await this.actionProposals.approveActionProposalProfileHydration(
        decodeURIComponent(proposalId),
        body,
      ),
    };
  }

  @Post("action-proposals/:proposalId/build-executor")
  @HttpCode(200)
  async buildActionProposalExecutor(
    @Param("proposalId") proposalId: string,
    @Body() body: unknown,
  ) {
    return {
      proposal: await this.actionProposals.buildActionProposalExecutor(
        decodeURIComponent(proposalId),
        body,
      ),
    };
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
    @Query("download") download: string | undefined,
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
        "content-disposition": `${download === "1" ? "attachment" : "inline"}; filename="${stored.artifact.filename.replace(/"/g, "")}"`,
        "cache-control": "no-store",
      })
      .send(buffer);
  }

  /**
   * Phase 13 follow-up: delete a single artifact (metadata row + the
   * underlying S3/local object). 404 when nothing matched, otherwise
   * a small `{ deleted, id, runId }` payload that the React Artifacts
   * page uses to remove the card and invalidate its cache.
   */
  @Delete("runs/:id/artifacts/:artifactId")
  async deleteArtifact(
    @Param("id") id: string,
    @Param("artifactId") artifactId: string,
  ) {
    return this.service.deleteArtifact(decodeURIComponent(id), decodeURIComponent(artifactId));
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
