import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  isRecord,
  parseLimit,
  parseOptionalNonNegativeInteger,
  parseOptionalNumberInRange,
  parseOptionalMinimumNumber,
  parseOptionalText,
  parseOptionalTextArray,
  parseRequiredText,
  sanitizeObject,
} from "../../common/parsers.js";
import type { ToolServiceSupervisor } from "../../../tools/toolServiceSupervisor.js";
import type {
  ToolServiceEventDirection,
  ToolServiceEventInput,
  ToolServiceEventRecord,
  ToolServiceEventStatus,
  ToolServiceEventStore,
} from "../../../tools/toolServiceEventStore.js";
import type { ChannelIdentityRecord, UserRecord, UserStore } from "../../../instance/userStore.js";
import { AuditService } from "../../common/services/audit.service.js";
import {
  TOOL_SERVICE_EVENT_STORE,
  TOOL_SERVICE_SUPERVISOR,
  USER_STORE,
} from "../../persistence/tokens.js";
import { RunsService } from "../runs/runs.service.js";
import { redactRuntimeText } from "../../../tools/toolPackageRunnerShared.js";
import {
  outboundProviderMessageIds,
  parseAllowIdentityRequest,
  sourceAliasesFromPayload,
  uniqueStrings,
} from "./tool-service-identity.js";

type ParsedInbound = ReturnType<ToolServicesService["parseInbound"]>;

@Injectable()
export class ToolServicesService {
  constructor(
    @Inject(TOOL_SERVICE_SUPERVISOR) private readonly supervisor: ToolServiceSupervisor | undefined,
    @Inject(TOOL_SERVICE_EVENT_STORE) private readonly events: ToolServiceEventStore | undefined,
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RunsService) private readonly runs: RunsService,
  ) {}

  async listServices() {
    return this.supervisor ? this.supervisor.list() : [];
  }

  async listOutbox(toolName: string, limit: number) {
    if (!this.supervisor || !this.events) {
      throw new ServiceUnavailableException("Tool service runtime is not configured");
    }
    const service = (await this.supervisor.list()).find((candidate) => candidate.toolName === toolName);
    if (!service) throw new NotFoundException(`Tool service was not found: ${toolName}`);
    const events = await this.events.list({ toolName, direction: "outbound", limit: 200 });
    const completedSourceIds = new Set(
      events
        .filter((event) => event.status === "sent" || event.status === "failed")
        .map((event) => parseOptionalText(event.payload?.sourceEventId))
        .filter((id): id is string => Boolean(id)),
    );
    return events
      .filter((event) => event.status === "queued")
      .filter((event) => !completedSourceIds.has(event.id))
      .slice(0, limit);
  }

  async ackOutbox(toolName: string, eventId: string, rawBody: unknown) {
    if (!this.supervisor || !this.events) {
      throw new ServiceUnavailableException("Tool service runtime is not configured");
    }
    const service = (await this.supervisor.list()).find((candidate) => candidate.toolName === toolName);
    if (!service) throw new NotFoundException(`Tool service was not found: ${toolName}`);

    let input: { status: "sent" | "failed"; summary?: string; providerMessageId?: string; detail?: string; payload?: Record<string, unknown> };
    try {
      input = this.parseAck(rawBody);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid outbound ack");
    }

    const allEvents = await this.events.list({ toolName, limit: 200 });
    const queued = allEvents.find((event) => event.id === eventId);
    if (!queued || queued.direction !== "outbound" || queued.status !== "queued") {
      throw new NotFoundException(`Queued outbound event was not found: ${eventId}`);
    }
    const event = await this.events.record({
      toolName,
      direction: "outbound",
      status: input.status,
      summary:
        input.summary ??
        `${input.status === "sent" ? "Outbound delivered" : "Outbound delivery failed"}: ${queued.summary.slice(0, 160)}`,
      sourceUserId: queued.sourceUserId,
      sourceChatId: queued.sourceChatId,
      sourceMessageId: queued.sourceMessageId,
      threadId: queued.threadId,
      runId: queued.runId,
      payload: {
        sourceEventId: queued.id,
        providerMessageId: input.providerMessageId,
        detail: input.detail ? redactRuntimeText(input.detail) : undefined,
        ...(input.payload ?? {}),
      },
    });
    await this.audit.record({
      instanceId: "instance-local",
      actorId: toolName,
      actorType: "tool",
      action: "tool_service.event_recorded",
      targetType: "tool",
      targetId: toolName,
      status: input.status === "sent" ? "success" : "failure",
      runId: queued.runId,
      threadId: queued.threadId,
      channel: toolName,
      summary: `Outbound ${input.status}: ${queued.summary.slice(0, 160)}`,
      metadata: {
        sourceEventId: queued.id,
        deliveryEventId: event.id,
        providerMessageId: input.providerMessageId,
      },
    });
    return event;
  }

  async listEvents(query: { toolName?: string; direction?: string; limit?: string }) {
    if (!this.events) return [];
    const direction = this.parseEventDirectionOptional(query.direction);
    return this.events.list({
      toolName: query.toolName,
      direction,
      limit: Number(query.limit ?? "100"),
    });
  }

  async createEvent(rawBody: unknown): Promise<ToolServiceEventRecord> {
    if (!this.events) {
      throw new ServiceUnavailableException("Tool service event store is not configured");
    }
    let input: ToolServiceEventInput;
    try {
      input = this.parseEventInput(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool service event",
      );
    }
    const event = await this.events.record(input);
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool_service.event_recorded",
      targetType: "tool",
      targetId: event.toolName,
      status: event.status === "failed" ? "failure" : "success",
      runId: event.runId,
      threadId: event.threadId,
      requesterUserId: event.sourceUserId,
      summary: `${event.direction} service event: ${event.summary.slice(0, 160)}`,
      metadata: {
        direction: event.direction,
        status: event.status,
        sourceChatId: event.sourceChatId,
        sourceMessageId: event.sourceMessageId,
      },
    });
    return event;
  }

  async allowIdentity(eventId: string, rawBody?: unknown): Promise<{
    event: ToolServiceEventRecord;
    identities: ChannelIdentityRecord[];
    user: UserRecord;
    run?: unknown;
  }> {
    if (!this.events) {
      throw new ServiceUnavailableException("Tool service event store is not configured");
    }
    const event = (await this.events.list({ limit: 500 })).find((candidate) => candidate.id === eventId);
    if (!event) throw new NotFoundException(`Tool service event was not found: ${eventId}`);
    if (!event.sourceUserId) {
      throw new BadRequestException("tool service event has no sourceUserId to allow");
    }

    const targetUser = await this.resolveIdentityTargetUser(rawBody);
    const provider = event.toolName;
    const now = new Date().toISOString();
    const providerUserIds = uniqueStrings([
      event.sourceUserId,
      ...sourceAliasesFromPayload(event.payload),
    ]);
    const identities: ChannelIdentityRecord[] = [];
    const existingUsers = await this.users.list();

    for (const providerUserId of providerUserIds) {
      const existing = existingUsers
        .flatMap((user) => user.identities)
        .find(
          (identity) =>
            identity.provider === provider &&
            identity.providerUserId === providerUserId,
        );
      const metadata = {
        ...(existing?.displayMetadata ?? {}),
        allowedFromToolServiceEventId: event.id,
        sourceUserId: event.sourceUserId,
        sourceChatId: event.sourceChatId,
        sourceMessageId: event.sourceMessageId,
        alias: providerUserId !== event.sourceUserId,
      };
      if (existing && existing.userId !== targetUser.id) {
        throw new BadRequestException(
          `Channel identity ${provider}/${providerUserId} already belongs to ${existing.userId}`,
        );
      }
      if (existing) {
        identities.push(
          await this.users.updateIdentity(existing.id, {
            allowStatus: "allowed",
            displayMetadata: metadata,
            lastSeenAt: event.createdAt ?? now,
          }),
        );
      } else {
        identities.push(
          await this.users.createIdentity({
            provider,
            providerUserId,
            userId: targetUser.id,
            allowStatus: "allowed",
            displayMetadata: metadata,
            lastSeenAt: event.createdAt ?? now,
          }),
        );
      }
    }

    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "channel_identity.created",
      targetType: "tool_service_event",
      targetId: event.id,
      status: "success",
      threadId: event.threadId,
      runId: event.runId,
      requesterUserId: targetUser.id,
      channel: provider,
      summary: `Allowed ${identities.length} channel identity mapping(s) from ${provider} for ${targetUser.id}`,
      metadata: {
        eventId: event.id,
        provider,
        userId: targetUser.id,
        identityIds: identities.map((identity) => identity.id),
        providerUserIds: identities.map((identity) => identity.providerUserId),
      },
    });

    const run = await this.replayInboundEventAfterAllow(event);
    return { event, identities, user: targetUser, run };
  }

  async listLogs(toolName: string | undefined, limit: number) {
    if (!this.supervisor) return [];
    return this.supervisor.listLogs(toolName, limit);
  }

  async updateRestartPolicy(toolName: string, rawBody: unknown) {
    if (!this.supervisor) {
      throw new ServiceUnavailableException("Tool service supervisor is not configured");
    }
    let policy;
    try {
      policy = this.parseRestartPolicy(rawBody);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid tool service restart policy",
      );
    }
    let service;
    try {
      service = await this.supervisor.updateRestartPolicy(toolName, policy);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool service restart policy";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool_service.restart_policy_updated",
      targetType: "tool",
      targetId: toolName,
      status: "success",
      summary: `Tool service restart policy updated: ${toolName}`,
      metadata: {
        autoRestartEnabled: service.autoRestartEnabled,
        maxAutoRestarts: service.maxAutoRestarts,
        restartBackoffMs: service.restartBackoffMs,
        restartBackoffMultiplier: service.restartBackoffMultiplier,
        restartBackoffMaxMs: service.restartBackoffMaxMs,
        restartBackoffJitterRatio: service.restartBackoffJitterRatio,
        restartRequiresApproval: service.restartRequiresApproval,
      },
    });
    return service;
  }

  async serviceAction(toolName: string, action: "start" | "stop" | "restart" | "heartbeat") {
    if (!this.supervisor) {
      throw new ServiceUnavailableException("Tool service supervisor is not configured");
    }
    const before = (await this.supervisor.list()).find((service) => service.toolName === toolName);
    let service;
    try {
      service =
        action === "start"
          ? await this.supervisor.start(toolName)
          : action === "stop"
            ? await this.supervisor.stop(toolName)
            : action === "restart"
              ? await this.supervisor.restart(toolName)
              : await this.supervisor.heartbeat(toolName);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool service action failed";
      throw message.includes("was not found")
        ? new NotFoundException(message)
        : new BadRequestException(message);
    }
    const auditAction =
      action === "start"
        ? "tool_service.start"
        : action === "stop"
          ? "tool_service.stop"
          : action === "restart"
            ? "tool_service.restart"
            : "tool_service.heartbeat";
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: auditAction,
      targetType: "tool",
      targetId: toolName,
      status: service.status === "failed" ? "failure" : "success",
      summary: `Tool service ${action}: ${toolName}`,
      metadata: {
        status: service.status,
        desiredState: service.desiredState,
        detail: service.detail,
        approvedPendingRestart: action === "restart" && Boolean(before?.pendingRestartApproval),
        pendingRestartApproval: service.pendingRestartApproval,
        nextRestartAt: service.nextRestartAt,
      },
    });
    return service;
  }

  async inbound(toolName: string, rawBody: unknown) {
    if (!this.supervisor || !this.events) {
      throw new ServiceUnavailableException("Tool service runtime is not configured");
    }
    const service = (await this.supervisor.list()).find((candidate) => candidate.toolName === toolName);
    if (!service) throw new NotFoundException(`Tool service was not found: ${toolName}`);

    let inbound: ReturnType<typeof this.parseInbound>;
    try {
      inbound = this.parseInbound(rawBody, toolName);
    } catch (error) {
      const loose = isRecord(rawBody) ? this.parseLooseInbound(rawBody, toolName) : undefined;
      await this.events.record({
        toolName,
        direction: "inbound",
        status: "ignored",
        summary: error instanceof Error ? error.message : "Inbound event could not create a run",
        sourceUserId: loose?.sourceUserId,
        sourceChatId: loose?.sourceChatId,
        sourceMessageId: loose?.sourceMessageId,
        payload: isRecord(rawBody) ? sanitizeObject(rawBody) : undefined,
      });
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid inbound tool service event",
      );
    }

    const receivedEvent = await this.events.record({
      toolName,
      direction: "inbound",
      status: "received",
      summary: inbound.task.slice(0, 240),
      sourceUserId: inbound.sourceUserId,
      sourceChatId: inbound.sourceChatId,
      sourceMessageId: inbound.sourceMessageId,
      payload: isRecord(rawBody) ? sanitizeObject(rawBody) : undefined,
    });
    await this.audit.record({
      instanceId: "instance-local",
      actorId: toolName,
      actorType: "tool",
      action: "tool_service.event_recorded",
      targetType: "tool",
      targetId: toolName,
      status: "success",
      requesterUserId: inbound.sourceUserId,
      channel: inbound.channel,
      summary: `Inbound event received: ${inbound.task.slice(0, 160)}`,
      metadata: {
        sourceEventId: receivedEvent.id,
        sourceChatId: inbound.sourceChatId,
        sourceMessageId: inbound.sourceMessageId,
      },
    });

    const resolvedInbound = await this.resolveInboundReplyContext(toolName, inbound);
    const created = await this.createRunFromInboundOrRecordFailure(
      toolName,
      receivedEvent,
      resolvedInbound,
    );
    const run = created.run;
    const queuedEvent = await this.events.record({
      toolName,
      direction: "system",
      status: "queued",
      summary: `Run created from inbound event: ${resolvedInbound.task.slice(0, 160)}`,
      sourceUserId: resolvedInbound.sourceUserId,
      sourceChatId: resolvedInbound.sourceChatId,
      sourceMessageId: resolvedInbound.sourceMessageId,
      threadId: run?.threadId ?? created.threadResolution?.threadId,
      runId: run?.id,
      payload: {
        sourceEventId: receivedEvent.id,
        threadResolution: created.threadResolution,
        replyResolution: resolvedInbound.replyResolvedFromEventId
          ? {
              eventId: resolvedInbound.replyResolvedFromEventId,
              threadId: resolvedInbound.threadId,
              parentRunId: resolvedInbound.parentRunId,
              replyToMessageId: resolvedInbound.replyToProviderMessageId ?? resolvedInbound.replyToSourceMessageId,
            }
          : undefined,
      },
    });
    await this.audit.record({
      instanceId: run?.instanceId ?? "instance-local",
      actorId: toolName,
      actorType: "tool",
      action: "tool_service.event_recorded",
      targetType: "tool",
      targetId: toolName,
      status: "success",
      runId: run?.id,
      threadId: run?.threadId,
      requesterUserId: run?.requesterUserId,
      channel: run?.channel,
      summary: `Inbound event queued run: ${run?.id ?? "unknown"}`,
      metadata: {
        sourceEventId: receivedEvent.id,
        queuedEventId: queuedEvent.id,
      },
    });
    return { event: receivedEvent, queuedEvent, ...created };
  }

  private async createRunFromInboundOrRecordFailure(
    toolName: string,
    sourceEvent: ToolServiceEventRecord,
    inbound: ParsedInbound,
  ) {
    try {
      return await this.runs.createAndStart({
        ...inbound.originalBody,
        task: inbound.task,
        channel: inbound.channel,
        sourceUserId: inbound.sourceUserId,
        sourceUserAliases: inbound.sourceUserAliases,
        sourceChatId: inbound.sourceChatId,
        threadId: inbound.threadId,
        sourceThreadId: inbound.sourceThreadId,
        sourceMessageId: inbound.sourceMessageId,
        parentRunId: inbound.parentRunId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Inbound event could not create a run";
      await this.events?.record({
        toolName,
        direction: "system",
        status: "failed",
        summary: `Inbound event did not create a run: ${message.slice(0, 180)}`,
        sourceUserId: inbound.sourceUserId,
        sourceChatId: inbound.sourceChatId,
        sourceMessageId: inbound.sourceMessageId,
        payload: {
          sourceEventId: sourceEvent.id,
          reason: message,
        },
      });
      await this.audit.record({
        instanceId: "instance-local",
        actorId: toolName,
        actorType: "tool",
        action: "tool_service.event_recorded",
        targetType: "tool_service_event",
        targetId: sourceEvent.id,
        status: "failure",
        requesterUserId: inbound.sourceUserId,
        channel: inbound.channel,
        summary: `Inbound event did not create a run: ${message.slice(0, 160)}`,
        metadata: {
          sourceEventId: sourceEvent.id,
          sourceChatId: inbound.sourceChatId,
          sourceMessageId: inbound.sourceMessageId,
        },
      });
      throw error;
    }
  }

  private async replayInboundEventAfterAllow(event: ToolServiceEventRecord) {
    if (!this.events || event.direction !== "inbound" || event.runId || !event.payload) {
      return undefined;
    }
    const existingReplay = (await this.events.list({ toolName: event.toolName, limit: 500 }))
      .find((candidate) =>
        candidate.direction === "system" &&
        candidate.status === "queued" &&
        parseOptionalText(candidate.payload?.sourceEventId) === event.id,
      );
    if (existingReplay?.runId) return { id: existingReplay.runId };

    const inbound = await this.resolveInboundReplyContext(
      event.toolName,
      this.parseInbound(event.payload, event.toolName),
    );
    const created = await this.createRunFromInboundOrRecordFailure(event.toolName, event, inbound);
    const run = created.run;
    await this.events.record({
      toolName: event.toolName,
      direction: "system",
      status: "queued",
      summary: `Run created after identity approval: ${inbound.task.slice(0, 160)}`,
      sourceUserId: inbound.sourceUserId,
      sourceChatId: inbound.sourceChatId,
      sourceMessageId: inbound.sourceMessageId,
      threadId: run?.threadId ?? created.threadResolution?.threadId,
      runId: run?.id,
      payload: {
        sourceEventId: event.id,
        threadResolution: created.threadResolution,
        replyResolution: inbound.replyResolvedFromEventId
          ? {
              eventId: inbound.replyResolvedFromEventId,
              threadId: inbound.threadId,
              parentRunId: inbound.parentRunId,
              replyToMessageId: inbound.replyToProviderMessageId ?? inbound.replyToSourceMessageId,
            }
          : undefined,
        replayedAfterIdentityApproval: true,
      },
    });
    return run;
  }

  private async resolveInboundReplyContext(toolName: string, inbound: ParsedInbound): Promise<ParsedInbound> {
    if (inbound.threadId || inbound.sourceThreadId || !this.events) return inbound;
    const replyIds = uniqueStrings([
      inbound.replyToProviderMessageId,
      inbound.replyToSourceMessageId,
    ]);
    if (replyIds.length === 0) return inbound;
    const events = await this.events.list({ toolName, direction: "outbound", limit: 200 });
    const target = events.find((event) => {
      if (!event.threadId) return false;
      if (inbound.sourceChatId && event.sourceChatId && inbound.sourceChatId !== event.sourceChatId) return false;
      return outboundProviderMessageIds(event).some((messageId) => replyIds.includes(messageId));
    });
    if (!target) return inbound;
    return {
      ...inbound,
      threadId: target.threadId,
      parentRunId: target.runId,
      replyResolvedFromEventId: target.id,
    };
  }

  parseLimit = parseLimit;

  subscribeLogs(toolName: string | undefined, push: (log: unknown) => void): () => void {
    if (!this.supervisor) return () => {};
    return this.supervisor.onLog((log) => {
      if (toolName && log.toolName !== toolName) return;
      push(log);
    });
  }

  private parseAck(value: unknown) {
    if (!isRecord(value)) throw new Error("outbox ack input must be an object");
    if (value.status !== "sent" && value.status !== "failed") {
      throw new Error("status must be sent or failed");
    }
    return {
      status: value.status as "sent" | "failed",
      summary: parseOptionalText(value.summary),
      providerMessageId: parseOptionalText(value.providerMessageId),
      detail: parseOptionalText(value.detail),
      payload: isRecord(value.payload) ? sanitizeObject(value.payload) : undefined,
    };
  }

  private async resolveAdminUser() {
    const explicit = await this.users.get("user-admin");
    if (explicit) return explicit;
    const users = await this.users.list();
    const user = users.find((candidate) => candidate.roles.includes("admin")) ?? users[0];
    if (!user) throw new ServiceUnavailableException("No local user exists for channel identity mapping");
    return user;
  }

  private async resolveIdentityTargetUser(rawBody: unknown): Promise<UserRecord> {
    const request = parseAllowIdentityRequest(rawBody);
    if (request.createUser) {
      try {
        const user = await this.users.create({
          id: request.createUser.id,
          displayName: request.createUser.displayName ?? "",
          role: request.createUser.role ?? "member",
          roles: request.createUser.roles,
        });
        await this.audit.record({
          instanceId: "instance-local",
          actorId: "user-admin",
          actorType: "user",
          action: "user.created",
          targetType: "user",
          targetId: user.id,
          status: "success",
          requesterUserId: user.id,
          summary: `User created from pending channel identity: ${user.displayName}`,
          metadata: { role: user.role, roles: user.roles, source: "tool-service-event-allow" },
        });
        return user;
      } catch (error) {
        throw new BadRequestException(
          this.errorMessage(error, "Could not create user for channel identity"),
        );
      }
    }
    if (request.userId) {
      const user = await this.users.get(request.userId);
      if (!user) throw new BadRequestException(`User was not found: ${request.userId}`);
      return user;
    }
    return this.resolveAdminUser();
  }

  private parseEventInput(value: unknown): ToolServiceEventInput {
    if (!isRecord(value)) throw new Error("tool service event must be an object");
    return {
      toolName: parseRequiredText(value.toolName, "toolName"),
      direction: this.parseEventDirection(value.direction),
      status: this.parseEventStatus(value.status),
      summary: parseRequiredText(value.summary, "summary"),
      sourceUserId: parseOptionalText(value.sourceUserId),
      sourceChatId: parseOptionalText(value.sourceChatId),
      sourceMessageId: parseOptionalText(value.sourceMessageId),
      threadId: parseOptionalText(value.threadId),
      runId: parseOptionalText(value.runId),
      payload: isRecord(value.payload) ? sanitizeObject(value.payload) : undefined,
    };
  }

  private parseEventDirection(value: unknown): ToolServiceEventDirection {
    if (value === "inbound" || value === "outbound" || value === "system") return value;
    throw new Error("direction must be inbound, outbound, or system");
  }

  private parseEventDirectionOptional(value: string | undefined): ToolServiceEventDirection | undefined {
    if (value === undefined || value === "") return undefined;
    return this.parseEventDirection(value);
  }

  private parseEventStatus(value: unknown): ToolServiceEventStatus {
    if (
      value === "received" ||
      value === "queued" ||
      value === "sent" ||
      value === "failed" ||
      value === "ignored"
    ) {
      return value;
    }
    throw new Error("status must be received, queued, sent, failed, or ignored");
  }

  private parseRestartPolicy(value: unknown) {
    if (!isRecord(value)) throw new Error("restart policy input must be an object");
    const autoRestartEnabled = value.autoRestartEnabled;
    if (autoRestartEnabled !== undefined && typeof autoRestartEnabled !== "boolean") {
      throw new Error("autoRestartEnabled must be a boolean");
    }
    const restartRequiresApproval = value.restartRequiresApproval;
    if (restartRequiresApproval !== undefined && typeof restartRequiresApproval !== "boolean") {
      throw new Error("restartRequiresApproval must be a boolean");
    }
    return {
      autoRestartEnabled,
      maxAutoRestarts: parseOptionalNonNegativeInteger(value.maxAutoRestarts, "maxAutoRestarts"),
      restartBackoffMs: parseOptionalNonNegativeInteger(value.restartBackoffMs, "restartBackoffMs"),
      restartBackoffMultiplier: parseOptionalMinimumNumber(
        value.restartBackoffMultiplier,
        "restartBackoffMultiplier",
        1,
      ),
      restartBackoffMaxMs: parseOptionalNonNegativeInteger(value.restartBackoffMaxMs, "restartBackoffMaxMs"),
      restartBackoffJitterRatio: parseOptionalNumberInRange(
        value.restartBackoffJitterRatio,
        "restartBackoffJitterRatio",
        0,
        1,
      ),
      restartRequiresApproval,
    };
  }

  private parseInbound(value: unknown, toolName: string) {
    if (!isRecord(value)) throw new Error("inbound service event must be an object");
    const task =
      parseOptionalText(value.task) ?? parseOptionalText(value.text) ?? parseOptionalText(value.message);
    if (!task) throw new Error("task, text, or message is required");
    return {
      originalBody: sanitizeObject(value),
      task,
      channel: parseOptionalText(value.channel) ?? toolName,
      sourceUserId: parseOptionalText(value.sourceUserId),
      sourceUserAliases: parseOptionalTextArray(value.sourceUserAliases),
      sourceChatId: parseOptionalText(value.sourceChatId),
      threadId: parseOptionalText(value.threadId),
      sourceThreadId: parseOptionalText(value.sourceThreadId),
      sourceMessageId: parseOptionalText(value.sourceMessageId),
      parentRunId: parseOptionalText(value.parentRunId),
      replyToSourceMessageId: parseOptionalText(value.replyToSourceMessageId),
      replyToProviderMessageId: parseOptionalText(value.replyToProviderMessageId),
      replyResolvedFromEventId: undefined as string | undefined,
    };
  }

  private parseLooseInbound(value: Record<string, unknown>, toolName: string) {
    return {
      channel: parseOptionalText(value.channel) ?? toolName,
      sourceUserId: parseOptionalText(value.sourceUserId),
      sourceUserAliases: parseOptionalTextArray(value.sourceUserAliases),
      sourceChatId: parseOptionalText(value.sourceChatId),
      threadId: parseOptionalText(value.threadId),
      sourceThreadId: parseOptionalText(value.sourceThreadId),
      sourceMessageId: parseOptionalText(value.sourceMessageId),
    };
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }
}
