export type ExternalActionRunMode = "approval" | "auto";

const AUTO_MODE_PATTERN =
  /\b(auto(?:mode| mode)?|automode)\b|автомод|без подтверждения|сразу (?:забронируй|отправь|запиши|оформи)/i;
const EXPLICIT_APPROVAL_PATTERN =
  /(?:не\s+(?:бронируй|отправляй|записывай|оформляй|подтверждай|сабмить|submit)|do not|don't).{0,80}(?:без\s+(?:моего\s+)?подтверждения|without\s+(?:my\s+)?(?:approval|confirmation))/i;

export function applyExternalActionRunMode(
  task: string,
  mode: ExternalActionRunMode,
): string {
  const trimmed = task.trim();
  if (!trimmed || mode !== "auto" || AUTO_MODE_PATTERN.test(trimmed)) return trimmed;
  return `Автомод: ${trimmed}`;
}

export function externalActionRunModeFromTask(task: string): ExternalActionRunMode {
  if (EXPLICIT_APPROVAL_PATTERN.test(task)) return "approval";
  return AUTO_MODE_PATTERN.test(task) ? "auto" : "approval";
}
