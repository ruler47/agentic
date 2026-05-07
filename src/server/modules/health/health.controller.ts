import { Controller, Get, Inject } from "@nestjs/common";
import { APP_ENV } from "../../config/config.module.js";
import type { AppEnv } from "../../config/env.js";

@Controller("api")
export class HealthController {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  @Get("health")
  health() {
    return { ok: true };
  }

  @Get("instance")
  instance() {
    return {
      instance: {
        id: "instance-local",
        name: "Local Agentic Assistant",
        defaultLanguage: "ru",
        timeZone: this.env.agentTimeZone,
        locale: "ru-RU",
      },
    };
  }
}
