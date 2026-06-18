import type { GroupProfileRecord } from "../../../instance/groupProfileStore.js";
import type { UserRecord } from "../../../instance/userStore.js";
import { isRecord, parseOptionalText } from "../../common/parsers.js";
import type { ActionPreparationProfileValue } from "./action-proposal-form-matching.js";

export function buildActionPreparationProfileValues(input: {
  groupProfile?: GroupProfileRecord;
  user?: UserRecord;
}): ActionPreparationProfileValue[] {
  const values = new Map<string, ActionPreparationProfileValue>();
  addValue(values, "contact_name", input.user?.displayName, "user_profile");
  for (const item of flattenPreferenceValues(input.groupProfile?.preferences)) {
    const field = classifyProfileKey(item.key);
    if (!field) continue;
    addValue(values, field, item.value, "group_profile");
  }
  for (const identity of input.user?.identities ?? []) {
    for (const item of flattenPreferenceValues(identity.displayMetadata)) {
      const field = classifyProfileKey(item.key);
      if (!field) continue;
      addValue(values, field, item.value, "user_profile");
    }
  }
  return [...values.values()];
}

function addValue(
  values: Map<string, ActionPreparationProfileValue>,
  field: string,
  value: string | undefined,
  source: ActionPreparationProfileValue["source"],
): void {
  if (!value?.trim() || values.has(field)) return;
  values.set(field, {
    field,
    source,
    value: value.trim(),
    valuePreview: maskProfileValue(field, value),
  });
}

function flattenPreferenceValues(
  value: unknown,
  prefix = "",
): Array<{ key: string; value: string }> {
  if (!isRecord(value)) return [];
  const output: Array<{ key: string; value: string }> = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const text = parseOptionalText(child);
    if (text) {
      output.push({ key: path, value: text });
      continue;
    }
    if (isRecord(child)) output.push(...flattenPreferenceValues(child, path));
  }
  return output.slice(0, 80);
}

function classifyProfileKey(key: string): string | undefined {
  const normalized = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (/\b(email|e-mail|mail|correo)\b/.test(normalized)) return "contact_email";
  if (/\b(phone|tel|telephone|mobile|whatsapp|telefono|teléfono)\b/.test(normalized)) {
    return "contact_phone";
  }
  if (/\b(full name|display name|contact name|name|nombre)\b/.test(normalized)) {
    return "contact_name";
  }
  return undefined;
}

function maskProfileValue(field: string, value: string): string {
  const trimmed = value.trim();
  if (field === "contact_email") {
    const [user, domain] = trimmed.split("@");
    if (!user || !domain) return "***";
    return `${user.slice(0, 2)}***@${domain}`;
  }
  if (field === "contact_phone") {
    const digits = trimmed.replace(/\D/gu, "");
    return digits.length > 4 ? `***${digits.slice(-4)}` : "***";
  }
  return trimmed.length > 40 ? `${trimmed.slice(0, 37)}...` : trimmed;
}
