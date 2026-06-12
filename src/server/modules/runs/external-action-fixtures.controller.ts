import { Body, Controller, Get, Header, Param, Post } from "@nestjs/common";

const ACTION_LABELS: Record<string, string> = {
  reservation: "Restaurant reservation",
  appointment: "Appointment booking",
  purchase: "Checkout draft",
  outbound_message: "Outbound message",
  api_write: "API write draft",
  generic_external_action: "External action draft",
};

@Controller("api/fixtures/external-actions")
export class ExternalActionFixturesController {
  @Get(":actionType")
  @Header("content-type", "text/html; charset=utf-8")
  renderFixture(@Param("actionType") actionType: string): string {
    const label = ACTION_LABELS[actionType] ?? ACTION_LABELS.generic_external_action;
    return renderFixturePage(label);
  }

  @Post(":actionType/commit")
  commitFixture(@Param("actionType") actionType: string, @Body() body: unknown) {
    const normalizedActionType = ACTION_LABELS[actionType]
      ? actionType
      : "generic_external_action";
    const now = new Date().toISOString();
    return {
      ok: true,
      provider: "agentic-local-fixture",
      actionType: normalizedActionType,
      confirmationId: `fixture_${normalizedActionType}_${Date.now().toString(36)}`,
      submittedAt: now,
      submittedPayloadSummary: summarizePayload(body),
    };
  }
}

function renderFixturePage(label: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(label)} fixture</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #10141d; color: #eef3fb; }
      main { max-width: 760px; margin: 40px auto; padding: 24px; }
      form { display: grid; gap: 14px; border: 1px solid #314052; border-radius: 8px; padding: 20px; background: #171d28; }
      label { display: grid; gap: 6px; font-size: 14px; color: #b8c2d1; }
      input, textarea { border: 1px solid #3b4658; border-radius: 6px; padding: 10px; background: #0e131b; color: #eef3fb; }
      button { justify-self: start; border: 0; border-radius: 6px; padding: 10px 14px; background: #35dec7; color: #06110f; font-weight: 700; }
      .boundary { margin-top: 18px; color: #f5c542; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(label)}</h1>
      <p>This local fixture is safe. Preparation may fill the draft, but final confirmation is the commit boundary.</p>
      <form data-testid="external-action-fixture-form">
        <label>Name<input name="name" autocomplete="name" /></label>
        <label>Party size<input name="partySize" type="number" min="1" max="20" /></label>
        <label>Date<input name="date" type="date" /></label>
        <label>Time<input name="time" type="time" /></label>
        <label>Email<input name="email" type="email" autocomplete="email" required /></label>
        <label>Notes<textarea name="notes" rows="4"></textarea></label>
        <button type="button" data-testid="final-confirm">Confirm reservation</button>
      </form>
      <p class="boundary">Commit boundary: do not click “Confirm reservation” during preparation.</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function summarizePayload(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return "";
    return json.length > 800 ? `${json.slice(0, 797)}...` : json;
  } catch {
    return String(value);
  }
}
