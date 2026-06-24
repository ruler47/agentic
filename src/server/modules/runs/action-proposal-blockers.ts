import type { ExternalActionBlocker } from "../../../types.js";

export type ExternalActionBlockerInfo = {
  blocker: ExternalActionBlocker;
  label: string;
  userMessage: string;
  nextAction: string;
  providerSpecific: boolean;
  recoverableByUser: boolean;
};

export function classifyExternalActionBlocker(
  reason: string | undefined,
  data?: unknown,
): ExternalActionBlockerInfo | undefined {
  const text = blockerHaystack(reason, data);
  if (!text.trim()) return undefined;

  if (/\b(captcha|recaptcha|hcaptcha|robot|bot check|cloudflare|security verification|challenge)\b/i.test(text)) {
    return blockerInfo(
      "captcha",
      "CAPTCHA or anti-bot check",
      "The provider showed a CAPTCHA, bot check, or security verification. The platform must stop before trying to bypass it.",
      "Open the provider manually, pick another provider, or retry later.",
      { providerSpecific: true, recoverableByUser: true },
    );
  }
  if (
    /\b(sms|text message|verification code|confirmation code|one[-\s]?time code|otp|phone verification|verify (?:your )?phone|confirm (?:your )?phone)\b/i.test(text) ||
    /\b(c[oó]digo(?: de)? (?:confirmaci[oó]n|verificaci[oó]n)|verifica(?:r|ci[oó]n).*tel[eé]fono|confirmar.*tel[eé]fono|n[uú]mero de tel[eé]fono|enviaremos un c[oó]digo)\b/i.test(text)
  ) {
    return blockerInfo(
      "verification_required",
      "Phone/SMS verification required",
      "The provider requires a phone number, SMS code, or one-time verification step before the external action can continue.",
      "Provide the phone/SMS verification details or approve a supported verification route, then resume the prepared action from the captured proof.",
      { providerSpecific: true, recoverableByUser: true },
    );
  }
  if (/\b(login|log in|sign in|signin|account required|authenticate|auth required|oauth)\b/i.test(text)) {
    return blockerInfo(
      "login_required",
      "Login required",
      "The provider requires a login or authenticated session before this action can continue.",
      "Log in manually, connect credentials through a proper tool setting, or choose another provider.",
      { providerSpecific: true, recoverableByUser: true },
    );
  }
  if (/\b(payment|paywall|card|checkout|deposit|billing|purchase required|prepay)\b/i.test(text)) {
    return blockerInfo(
      "payment_required",
      "Payment required",
      "The provider requires payment, a card, or a checkout/deposit step. The platform cannot cross that boundary automatically.",
      "Approve and complete payment manually, provide a payment-capable workflow later, or choose another provider.",
      { providerSpecific: true, recoverableByUser: true },
    );
  }
  if (/\b(no slots?|unavailable|sold out|fully booked|not available|нет мест|недоступн|занят[оы])\b/i.test(text)) {
    return blockerInfo(
      "slot_unavailable",
      "Slot unavailable",
      "The requested slot or option is unavailable at the provider.",
      "Choose another time/provider or ask the agent to search alternatives.",
      { providerSpecific: true, recoverableByUser: true },
    );
  }
  if (/\b(ambiguous|multiple targets|choose a target|which provider|which option|несколько вариантов|уточните)\b/i.test(text)) {
    return blockerInfo(
      "ambiguous_target",
      "Ambiguous target",
      "The platform cannot safely determine which provider, option, or target should be used.",
      "Pick the intended target or provide a clearer constraint.",
      { providerSpecific: false, recoverableByUser: true },
    );
  }
  if (/\b(missing|required|needs? .*input|not enough information|insufficient|profile fields?|field gaps?|unresolved gaps?|missing_requirements)\b/i.test(text)) {
    return blockerInfo(
      "missing_data",
      "Missing data",
      "The action is missing required data or approved profile values before it can continue.",
      "Provide or approve the missing data, then prepare again.",
      { providerSpecific: false, recoverableByUser: true },
    );
  }
  if (/\b(proof artifact|proof failed|quality failed|screenshot failed|visual qa|blocked_or_loader|loader)\b/i.test(text)) {
    return blockerInfo(
      "proof_failed",
      "Proof failed",
      "The platform could not capture usable proof for the prepared action.",
      "Retry preparation, choose another source/provider, or proceed manually if the proof is not required.",
      { providerSpecific: true, recoverableByUser: true },
    );
  }
  if (/\b(unsupported|widget|iframe|shadow dom|cannot click|no concrete external submit control|no concrete.*submit|form-specific|provider-specific commit)\b/i.test(text)) {
    return blockerInfo(
      "unsupported_widget",
      "Unsupported provider widget",
      "The provider uses a widget or submit flow that the current tools cannot safely automate.",
      "Choose another provider or improve the browser/commit tool capability before retrying.",
      { providerSpecific: true, recoverableByUser: false },
    );
  }
  if (/\b(policy|not allowed|forbidden|approval required|cannot mutate|do not submit|external submit boundary)\b/i.test(text)) {
    return blockerInfo(
      "policy_blocked",
      "Policy boundary",
      "The platform policy blocked the external action before final submit.",
      "Review the approval boundary and explicitly authorize only if the action is safe.",
      { providerSpecific: false, recoverableByUser: true },
    );
  }
  if (/\b(provider|timeout|timed out|network|5\d\d|4\d\d|server error|failed|error|threw)\b/i.test(text)) {
    return blockerInfo(
      "provider_error",
      "Provider error",
      "The provider or execution tool returned an error.",
      "Retry later, pick another provider, or inspect the trace for the exact failing step.",
      { providerSpecific: true, recoverableByUser: true },
    );
  }

  return blockerInfo(
    "provider_error",
    "External action blocked",
    "The external action did not reach a safe final-submit state.",
    "Inspect the trace or retry with clearer target/data constraints.",
    { providerSpecific: true, recoverableByUser: true },
  );
}

function blockerHaystack(reason: string | undefined, data: unknown): string {
  const dataText = data === undefined ? "" : safeJson(data);
  return `${reason ?? ""}\n${dataText}`.slice(0, 12_000);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function blockerInfo(
  blocker: ExternalActionBlocker,
  label: string,
  userMessage: string,
  nextAction: string,
  flags: Pick<ExternalActionBlockerInfo, "providerSpecific" | "recoverableByUser">,
): ExternalActionBlockerInfo {
  return { blocker, label, userMessage, nextAction, ...flags };
}
