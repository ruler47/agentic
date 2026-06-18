import { Controller, Get, Inject, Optional } from "@nestjs/common";
import type { PgPool } from "../../../db/pool.js";
import { s3ConfigFromEnv } from "../../../artifacts/s3ObjectStore.js";
import { APP_ENV } from "../../config/config.module.js";
import type { AppEnv } from "../../config/env.js";
import { PG_POOL } from "../../persistence/tokens.js";

type PersistenceMode = "postgres" | "in-memory" | "local-json" | "local-files" | "s3";
type PersistenceStatus = "ok" | "unconfigured" | "error";

@Controller("api")
export class HealthController {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Optional() @Inject(PG_POOL) private readonly pool?: PgPool,
  ) {}

  @Get("health")
  async health() {
    const database = await this.databaseStatus();
    return {
      ok: database.status !== "error",
      persistence: {
        database,
        stores: this.storeStatuses(database.mode === "postgres"),
      },
    };
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

  private async databaseStatus(): Promise<{
    mode: "postgres" | "in-memory";
    status: PersistenceStatus;
    configured: boolean;
  }> {
    if (!this.env.databaseUrl || !this.pool) {
      return { mode: "in-memory", status: "unconfigured", configured: false };
    }
    try {
      await this.pool.query("select 1");
      return { mode: "postgres", status: "ok", configured: true };
    } catch {
      return { mode: "postgres", status: "error", configured: true };
    }
  }

  private storeStatuses(databaseBacked: boolean): Array<{
    name: string;
    mode: PersistenceMode;
    durable: boolean;
  }> {
    const databaseStore = (name: string) => ({
      name,
      mode: databaseBacked ? ("postgres" as const) : ("in-memory" as const),
      durable: databaseBacked,
    });
    const metadataStore = {
      name: "toolMetadata",
      mode: databaseBacked ? ("postgres" as const) : ("local-json" as const),
      durable: true,
    };
    const artifactStore = {
      name: "artifacts",
      mode: databaseBacked && s3ConfigFromEnv() ? ("s3" as const) : ("local-files" as const),
      durable: true,
    };
    return [
      databaseStore("runs"),
      databaseStore("runEvents"),
      databaseStore("secrets"),
      metadataStore,
      databaseStore("toolCreations"),
      databaseStore("audit"),
      databaseStore("conversations"),
      databaseStore("workLedger"),
      databaseStore("evidenceLedger"),
      artifactStore,
    ];
  }
}
