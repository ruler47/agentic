import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Sse,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { ToolServicesService } from "./tool-services.service.js";

@Controller("api")
export class ToolServicesController {
  constructor(private readonly service: ToolServicesService) {}

  @Get("tool-services")
  async listServices() {
    return { services: await this.service.listServices() };
  }

  @Get("tool-services/:toolName/outbox")
  async listOutbox(@Param("toolName") toolName: string, @Query("limit") limit?: string) {
    return {
      events: await this.service.listOutbox(
        decodeURIComponent(toolName),
        this.service.parseLimit(limit ?? null, 50),
      ),
    };
  }

  @Post("tool-services/:toolName/outbox/:eventId/ack")
  @HttpCode(201)
  async ackOutbox(
    @Param("toolName") toolName: string,
    @Param("eventId") eventId: string,
    @Body() body: unknown,
  ) {
    return {
      event: await this.service.ackOutbox(
        decodeURIComponent(toolName),
        decodeURIComponent(eventId),
        body,
      ),
    };
  }

  @Post("tool-services/:toolName/inbound")
  @HttpCode(202)
  async inbound(@Param("toolName") toolName: string, @Body() body: unknown) {
    return this.service.inbound(decodeURIComponent(toolName), body);
  }

  @Patch("tool-services/:toolName/restart-policy")
  async updateRestartPolicy(@Param("toolName") toolName: string, @Body() body: unknown) {
    return {
      service: await this.service.updateRestartPolicy(decodeURIComponent(toolName), body),
    };
  }

  @Post("tool-services/:toolName/start")
  async start(@Param("toolName") toolName: string) {
    return { service: await this.service.serviceAction(decodeURIComponent(toolName), "start") };
  }

  @Post("tool-services/:toolName/stop")
  async stop(@Param("toolName") toolName: string) {
    return { service: await this.service.serviceAction(decodeURIComponent(toolName), "stop") };
  }

  @Post("tool-services/:toolName/restart")
  async restart(@Param("toolName") toolName: string) {
    return { service: await this.service.serviceAction(decodeURIComponent(toolName), "restart") };
  }

  @Post("tool-services/:toolName/heartbeat")
  async heartbeat(@Param("toolName") toolName: string) {
    return { service: await this.service.serviceAction(decodeURIComponent(toolName), "heartbeat") };
  }

  @Get("tool-service-events")
  async listEvents(
    @Query("toolName") toolName?: string,
    @Query("direction") direction?: string,
    @Query("limit") limit?: string,
  ) {
    return {
      events: await this.service.listEvents({ toolName, direction, limit }),
    };
  }

  @Post("tool-service-events")
  @HttpCode(201)
  async createEvent(@Body() body: unknown) {
    return { event: await this.service.createEvent(body) };
  }

  @Get("tool-services/logs")
  async listLogs(@Query("toolName") toolName?: string, @Query("limit") limit?: string) {
    return {
      logs: await this.service.listLogs(toolName, Number(limit ?? "100")),
    };
  }

  @Sse("tool-services/logs/events")
  logsStream(@Query("toolName") toolName?: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      const heartbeatTimer = setInterval(() => {
        if (!closed) subscriber.next({ data: ":heartbeat" } as MessageEvent);
      }, 15000);
      const unsubscribe = this.service.subscribeLogs(toolName, (log) => {
        if (closed) return;
        subscriber.next({ type: "service-log", data: { log } } as MessageEvent);
      });
      subscriber.next({ data: ":connected" } as MessageEvent);
      return () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer);
        unsubscribe();
      };
    });
  }
}
