import { describe, expect, it } from "vitest";

import {
  applyExternalActionRunMode,
  externalActionRunModeFromTask,
} from "@/features/runs/externalActionMode";

describe("applyExternalActionRunMode", () => {
  it("keeps approval mode tasks unchanged", () => {
    expect(applyExternalActionRunMode(" забронируй столик ", "approval")).toBe(
      "забронируй столик",
    );
  });

  it("does not inject automode directives into the user task text", () => {
    expect(applyExternalActionRunMode("забронируй столик", "auto")).toBe(
      "забронируй столик",
    );
    expect(applyExternalActionRunMode("Автомод: забронируй столик", "auto")).toBe(
      "Автомод: забронируй столик",
    );
  });

  it("detects automode tasks for run cards", () => {
    expect(externalActionRunModeFromTask("Автомод: забронируй столик")).toBe("auto");
    expect(externalActionRunModeFromTask("забронируй столик")).toBe("approval");
    expect(externalActionRunModeFromTask("забронируй столик", "auto")).toBe("auto");
  });

  it("does not treat explicit no-submit-without-confirmation text as automode", () => {
    expect(
      externalActionRunModeFromTask(
        "Заполни форму, но не отправляй без моего подтверждения.",
      ),
    ).toBe("approval");
  });
});
