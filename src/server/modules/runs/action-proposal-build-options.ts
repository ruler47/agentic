import { ConflictException } from "@nestjs/common";
import { isRecord, parseOptionalText } from "../../common/parsers.js";

export type ActionProposalExecutorBuildOptions = {
  mode: "create" | "plan";
  authoringMode?: "auto" | "llm" | "scaffold";
  activateOnSuccess: boolean;
};

export function parseActionProposalExecutorBuildOptions(
  rawBody: unknown,
): ActionProposalExecutorBuildOptions {
  const mode = parseOptionalText(isRecord(rawBody) ? rawBody.mode : undefined);
  const authoringMode = parseAuthoringMode(rawBody);
  const activationPolicy = parseOptionalText(
    isRecord(rawBody) ? rawBody.activationPolicy : undefined,
  );
  if (
    activationPolicy !== undefined &&
    activationPolicy !== "available_on_success" &&
    activationPolicy !== "manual"
  ) {
    throw new ConflictException(
      "activationPolicy must be available_on_success or manual",
    );
  }
  return {
    mode: mode === "plan" || mode === "dry-run" || mode === "dry_run" ? "plan" : "create",
    authoringMode,
    activateOnSuccess:
      (isRecord(rawBody) && rawBody.activateOnSuccess === true) ||
      activationPolicy === "available_on_success",
  };
}

function parseAuthoringMode(
  rawBody: unknown,
): "auto" | "llm" | "scaffold" | undefined {
  if (!isRecord(rawBody)) return undefined;
  const raw = parseOptionalText(rawBody.authoringMode);
  if (raw === undefined) return undefined;
  if (raw === "auto" || raw === "llm" || raw === "scaffold") return raw;
  throw new ConflictException("authoringMode must be auto, llm, or scaffold");
}
