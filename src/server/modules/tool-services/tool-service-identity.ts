import { BadRequestException } from "@nestjs/common";
import type { ToolServiceEventRecord } from "../../../tools/toolServiceEventStore.js";
import {
  isRecord,
  parseOptionalText,
  parseOptionalTextArray,
} from "../../common/parsers.js";

export type AllowIdentityRequest = {
  userId?: string;
  createUser?: {
    id?: string;
    displayName?: string;
    role?: string;
    roles?: string[];
  };
};

export function parseAllowIdentityRequest(rawBody: unknown): AllowIdentityRequest {
  if (!isRecord(rawBody)) return {};
  const createUser = isRecord(rawBody.createUser) ? rawBody.createUser : undefined;
  if (createUser) {
    const displayName =
      typeof createUser.displayName === "string" ? createUser.displayName.trim() : "";
    if (!displayName) throw new BadRequestException("createUser.displayName is required");
    return {
      createUser: {
        id: typeof createUser.id === "string" && createUser.id.trim() ? createUser.id.trim() : undefined,
        displayName,
        role:
          typeof createUser.role === "string" && createUser.role.trim()
            ? createUser.role.trim()
            : undefined,
        roles: Array.isArray(createUser.roles)
          ? createUser.roles
              .filter((role): role is string => typeof role === "string" && Boolean(role.trim()))
              .map((role) => role.trim())
          : undefined,
      },
    };
  }
  return {
    userId:
      typeof rawBody.userId === "string" && rawBody.userId.trim()
        ? rawBody.userId.trim()
        : undefined,
  };
}

export function sourceAliasesFromPayload(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const aliases = parseOptionalTextArray(payload.sourceUserAliases) ?? [];
  const username =
    parseOptionalText(payload.username) ??
    parseOptionalText(payload.sourceUsername) ??
    parseOptionalText(payload.sourceUserName);
  return uniqueStrings([
    ...aliases,
    username,
    username && !username.startsWith("@") ? `@${username}` : undefined,
  ]);
}

export function outboundProviderMessageIds(event: ToolServiceEventRecord): string[] {
  return uniqueStrings([
    event.sourceMessageId,
    parseOptionalText(event.payload?.providerMessageId),
    parseOptionalText(event.payload?.sourceMessageId),
  ]);
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}
