import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExternalActionProposal,
  inferExternalActionPolicy,
  selectExternalActionPreparationUrl,
} from "../src/agents/externalActionPlanning.js";
import { frameTask } from "../src/agents/taskFrame.js";

test("external action planning selects an actionable preparation URL", () => {
  const sourceUrls = [
    "https://search.example.com/results?q=restaurant",
    "https://example.com/blog/best-restaurants",
    "https://booking.example.com/reservations/restaurant-x?party=2",
  ];

  const selected = selectExternalActionPreparationUrl("reservation", sourceUrls);
  assert.equal(selected, "https://booking.example.com/reservations/restaurant-x?party=2");

  const task = "Забронируй столик на двоих завтра в 20:00";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: "Лучший вариант: **Restaurant X**. Для бронирования есть отдельная страница.",
    taskFrame: frameTask(task),
    runContext: { runId: "run_prepare_url", threadId: "thread_prepare_url" },
    artifacts: [],
    sourceUrls,
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Restaurant X");
  assert.equal(proposal?.preparation?.target, "Restaurant X");
  assert.equal(
    proposal?.preparation?.targetUrl,
    "https://booking.example.com/reservations/restaurant-x?party=2",
  );
});

test("external action planning skips source labels when selecting a target", () => {
  const task = "Забронируй ресторан на двоих";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: [
      "На основе данных из источников **Marbella Prestige** и **Wanderlog** я выбрал варианты.",
      "**1. Skina** — лучший вариант для ужина.",
    ].join("\n"),
    taskFrame: frameTask(task),
    runContext: { runId: "run_target_source_skip" },
    artifacts: [],
    sourceUrls: ["https://example.com/reserve"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Skina");
});

test("external action planning reads target values after bold field labels", () => {
  const task = "Подготовь бронирование";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: [
      "**Ресторан:** Skina Marbella",
      "**Дата:** 23 мая 2026",
      "**Время:** 20:00",
    ].join("\n"),
    taskFrame: frameTask(task),
    runContext: { runId: "run_target_label_value" },
    artifacts: [],
    sourceUrls: [
      "https://www.restauranteskina.com/en/",
      "https://guide.michelin.com/en/andalucia/marbella/restaurant/skina",
    ],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Skina Marbella");
  assert.equal(proposal?.preparation?.targetUrl, "https://www.restauranteskina.com/en/");
});

test("external action planning skips section headings before target field labels", () => {
  const task = "Подготовь бронирование в Skina";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: [
      "**Детали бронирования:**",
      "* **Ресторан:** Skina (Marbella)",
      "* **Дата:** 23 мая 2026",
      "* **Время:** 20:00",
    ].join("\n"),
    taskFrame: frameTask(task),
    runContext: { runId: "run_target_heading_skip" },
    artifacts: [],
    sourceUrls: ["https://www.restauranteskina.com/en/"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Skina (Marbella)");
  assert.equal(proposal?.title, "Reservation proposal: Skina (Marbella)");
});

test("external action planning skips search-result headings before service target field labels", () => {
  const task = [
    "Найди в Марбелье барбершоп, где можно записаться онлайн.",
    "Данные для записи: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com.",
    "Режим: approval.",
  ].join("\n");
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: [
      "**Результаты поиска (подтверждено):**",
      "* **Барбершоп:** Memento Barbershop (Marbella)",
      "* **Онлайн-запись:** доступна через Booksy.",
      "* **Данные:** Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com.",
    ].join("\n"),
    taskFrame: frameTask(task),
    runContext: { runId: "run_target_search_heading_skip" },
    artifacts: [],
    sourceUrls: ["https://booksy.example/memento"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Memento Barbershop (Marbella)");
  assert.equal(proposal?.title, "Appointment proposal: Memento Barbershop (Marbella)");
});

test("external action planning reads target after selected service labels", () => {
  const task = [
    "Найди барбершоп в Марбелье, где можно записаться онлайн.",
    "Мои данные: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com.",
    "Режим approval.",
  ].join("\n");
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: [
      "Я нашел подходящий вариант для онлайн-записи в Марбелье.",
      "**Выбранный барбершоп:** Memento Barbershop",
      "Ссылка для записи: https://booksy.example/memento",
    ].join("\n"),
    taskFrame: frameTask(task),
    runContext: { runId: "run_target_selected_label" },
    artifacts: [],
    sourceUrls: ["https://booksy.example/memento"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Memento Barbershop");
  assert.equal(proposal?.title, "Appointment proposal: Memento Barbershop");
});

test("external action planning prefers final-answer action links over research source URLs", () => {
  const task = [
    "выбери лучший барбершоп и забронируй мне",
    "Dimitrii Bilokon 617789419 dimitriy.belokon@gmail.com",
    "стрижка вечером после 17.00 с пн по чт",
  ].join(" ");
  const directBookingUrl =
    "https://booking.example.com/es-es/148702_memento-barbershop_barberia_29260_marbella";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: [
      "Я выбрал **Memento Barbershop**.",
      `**Ссылка для записи:** [Book appointment - Memento Barbershop](${directBookingUrl})`,
      "Источник ресерча: https://guide.example.com/barbers-marbella/",
    ].join("\n"),
    taskFrame: frameTask(task),
    runContext: { runId: "run_final_answer_action_link" },
    artifacts: [],
    sourceUrls: [
      "https://guide.example.com/barbers-marbella/",
      "https://guide.example.com/",
    ],
    createdAt: "2026-05-24T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Memento Barbershop");
  assert.equal(proposal?.sourceUrls[0], directBookingUrl);
  assert.equal(proposal?.preparation?.targetUrl, directBookingUrl);
});

test("external action planning normalizes booking inputs from user task", () => {
  const task =
    "Забронируй столик на 5 гостей завтра в 20:30, контакт +34 600 111 222";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: "Лучший вариант: **Restaurant X**.",
    taskFrame: frameTask(task),
    runContext: { runId: "run_input_normalization" },
    artifacts: [],
    sourceUrls: ["https://restaurant.example/booking"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  const inputs = proposal?.preparation?.collectedInputs ?? [];
  assert.deepEqual(
    inputs.map((input) => [input.label, input.value]),
    [
      ["party_size", "5"],
      ["date_or_time", "2026-05-23 20:30"],
      ["contact", "+34 600 111 222"],
    ],
  );
  assert.deepEqual(proposal?.preparation?.missingInputs, []);
});

test("external action planning preserves concrete appointment service from user task", () => {
  const task =
    "Забронируй мне стрижку вечером после 17:00 с пн по чт, контакт +34 600 111 222";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: "Лучший вариант: **Memento Barbershop**.",
    taskFrame: frameTask(task),
    runContext: { runId: "run_appointment_service" },
    artifacts: [],
    sourceUrls: ["https://booksy.example/barber"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  const service = proposal?.preparation?.collectedInputs.find(
    (input) => input.label === "service",
  );
  assert.equal(service?.value, "стрижка / haircut");
  assert.ok(
    !proposal?.preparation?.collectedInputs.some(
      (input) => input.value === "appointment service requested",
    ),
  );
});

test("external action planning supports explicit automode", () => {
  const task =
    "Автомод: если данных достаточно, сразу забронируй столик на 2 завтра в 20:00, контакт +34 600 111 222";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: "Лучший вариант: **Restaurant X**.",
    taskFrame: frameTask(task),
    runContext: { runId: "run_auto_mode" },
    artifacts: [],
    sourceUrls: ["https://restaurant.example/booking"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.executionMode, "auto");
  assert.equal(proposal?.approvalRequired, false);
  assert.deepEqual(proposal?.prohibitedWithoutApproval, []);
});

test("structured automode does not turn research-only tasks into external actions", () => {
  const task =
    "проведи ресерч по рынкам и найди перспективную идею для вайбкодинга";

  assert.equal(inferExternalActionPolicy(task, { externalActionMode: "auto" }), undefined);
  assert.equal(frameTask(task, { externalActionMode: "auto" }).externalActionPolicy, undefined);
  assert.equal(frameTask(`Автомод: ${task}`).externalActionPolicy, undefined);
});

test("structured automode applies only after external action intent is present", () => {
  const task = "найди барбершоп в Марбелье и запиши меня на стрижку завтра после 17:00";
  const policy = inferExternalActionPolicy(task, { externalActionMode: "auto" });

  assert.equal(policy?.actionType, "appointment");
  assert.equal(policy?.executionMode, "auto");
  assert.equal(policy?.requiresApprovalBeforeExecution, false);
  assert.equal(
    frameTask(task, { externalActionMode: "auto" }).externalActionPolicy?.executionMode,
    "auto",
  );
});

test("external action planning does not pause informational bookable-place lookups", () => {
  for (const task of [
    "найди мне ресторан в марбее, который можно забронировать онлайн столик.",
    "Найди мне шикарный ресторан в марбее с кучей мяса в меню, который я смогу забронировать онлайн когда захочу",
  ]) {
    assert.equal(inferExternalActionPolicy(task), undefined);
    assert.equal(frameTask(task).externalActionPolicy, undefined);
    assert.equal(
      buildExternalActionProposal({
        task,
        finalAnswer: "Подходящий вариант: **Skina**. Онлайн-бронирование доступно на сайте.",
        taskFrame: frameTask(task),
        runContext: { runId: "run_bookable_lookup" },
        artifacts: [],
        sourceUrls: ["https://www.restauranteskina.com/en/booking/"],
        createdAt: "2026-05-22T10:00:00.000Z",
      }),
      undefined,
    );
  }
});

test("external action planning treats bookable lookup with user details as preparation intent", () => {
  const task = [
    "Найди в Марбелье барбершоп, где можно записаться онлайн.",
    "Данные для записи: Dimitrii Bilokon, 617789419, dimitriy.belokon@gmail.com.",
    "Дата: на следующей неделе после 17:00.",
    "Услуга: обычная мужская стрижка.",
    "Режим: approval. Перед отправкой дай скриншот заполненной формы.",
  ].join("\n");

  const policy = inferExternalActionPolicy(task);

  assert.equal(policy?.actionType, "appointment");
  assert.equal(policy?.executionMode, "approval");
  assert.equal(policy?.requiresApprovalBeforeExecution, true);
  assert.ok(policy?.prohibitedWithoutApproval.some((item) => /appointment|booking/i.test(item)));
  assert.equal(frameTask(task).externalActionPolicy?.actionType, "appointment");
});

test("external action planning treats requirements questions as informational", () => {
  for (const task of [
    "Какие тебе от меня данные нужны чтобы забронировать?",
    "Что нужно от меня, чтобы записаться на стрижку?",
    "What details do you need from me to reserve a table?",
  ]) {
    assert.equal(inferExternalActionPolicy(task), undefined);
    assert.equal(frameTask(task).externalActionPolicy, undefined);
  }
});

test("external action planning does not turn read-only API checks into write approvals", () => {
  assert.equal(inferExternalActionPolicy("Проверь данные через API"), undefined);
  assert.equal(frameTask("Проверь данные через API").externalActionPolicy, undefined);
});

test("external action planning still pauses explicit find-and-book requests", () => {
  const task = "найди ресторан в Марбелье и забронируй столик на двоих завтра";
  const policy = inferExternalActionPolicy(task);

  assert.equal(policy?.actionType, "reservation");
  assert.equal(policy?.requiresApprovalBeforeExecution, true);
  assert.equal(frameTask(task).externalActionPolicy?.actionType, "reservation");
});

test("external action planning treats booked service appointments as appointments", () => {
  const policy = inferExternalActionPolicy("забронируй мне стрижку в салоне завтра после 17:00");

  assert.equal(policy?.actionType, "appointment");
  assert.ok(policy?.prohibitedWithoutApproval.some((item) => /appointment/i.test(item)));
});

test("external action proposals refine follow-up booking intent from the final answer", () => {
  const proposal = buildExternalActionProposal({
    task: "забронируй ты",
    finalAnswer: [
      "Подготовлена запись на стрижку в **Umeo Marbella**.",
      "Услуга: мужская стрижка. Время: любой вечер после 17:00.",
      "Даты: с понедельника по четверг на следующей неделе.",
      "Контакт: Dimitrii Bilokon, +34 617789419, dimitriy.belokon@gmail.com.",
    ].join("\n"),
    taskFrame: frameTask("забронируй ты"),
    runContext: { runId: "run_followup_appointment" },
    artifacts: [],
    sourceUrls: ["https://www.fresha.com/a/umeo-marbella-aveda-salon-marbella-avenida-ricardo-soriano-ihoycsrk"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.actionType, "appointment");
  assert.equal(proposal?.title, "Appointment proposal: Umeo Marbella");
  assert.match(proposal?.proposedAction ?? "", /schedule an appointment/i);
  assert.deepEqual(proposal?.preparation?.missingInputs, []);
  assert.equal(proposal?.preparation?.stage, "ready_to_commit");
  assert.ok(proposal?.prohibitedWithoutApproval.some((item) => /appointment/i.test(item)));
});

test("external action planning skips contact field labels when selecting appointment target", () => {
  const proposal = buildExternalActionProposal({
    task: "забронируй ты",
    finalAnswer: [
      "### Предложение по бронированию (Umeo Marbella)",
      "**1. Данные для записи:**",
      "* **Имя:** Dimitrii Bilokon",
      "* **Телефон:** 617789419",
      "* **Email:** dimitriy.belokon@gmail.com",
    ].join("\n"),
    taskFrame: frameTask("забронируй ты"),
    runContext: { runId: "run_contact_label_target_skip" },
    artifacts: [],
    sourceUrls: [],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Umeo Marbella");
  assert.equal(proposal?.title, "Appointment proposal: Umeo Marbella");
});

test("external action planning ignores non-heading safety parentheses as targets", () => {
  const proposal = buildExternalActionProposal({
    task: "забронируй ты",
    finalAnswer: [
      "Я готов приступить к бронированию в салоне **Umeo Marbella**.",
      "Я не могу завершить бронирование без финального одобрения (согласно правилам безопасности).",
    ].join("\n"),
    taskFrame: frameTask("забронируй ты"),
    runContext: { runId: "run_safety_parentheses_target_skip" },
    artifacts: [],
    sourceUrls: [],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "Umeo Marbella");
});

test("external action planning ignores explanatory headings as reservation targets", () => {
  const task = "забронируй шикарный ресторан";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: [
      "### Лучший выбор: LEÑA (by Dani García)",
      "* **Почему это шикарно:** ресторан от Дани Гарсии.",
      "* **Про мясо:** открытый огонь.",
      "* **Бронирование:** онлайн.",
    ].join("\n"),
    taskFrame: frameTask(task),
    runContext: { runId: "run_heading_target" },
    artifacts: [],
    sourceUrls: ["https://lenarestaurants.com/en/marbella/book-a-table/"],
    createdAt: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(proposal?.target, "LEÑA (by Dani García)");
});

test("prepare verb after a connective infers an external action policy", () => {
  // Live regression: "Найди барбершоп ... и подготовь запись" got no policy
  // (no proposal, no waiting_approval pause, 12-step budget).
  const policy = inferExternalActionPolicy(
    "Найди барбершоп в Марбелье с онлайн-записью и подготовь запись на стрижку на ближайшую пятницу после 17:00. Это тест: используй тестовые данные Test User, test@example.com, +34 600 000 000. Ничего финально не отправляй — только подготовь и покажи что заполнено.",
  );
  assert.ok(policy, "policy must be inferred");
  assert.equal(policy.actionType, "appointment");
  assert.equal(policy.executionMode, "approval");
  assert.equal(policy.userExplicitlyForbidsAction, true);
});

test("safe-preparation phrasings count as preparation intent", () => {
  const policy = inferExternalActionPolicy(
    "Найди ресторан в Марбелье и подготовь бронирование столика на завтра, телефон +34 600 000 000. Только подготовь, не отправляй.",
  );
  assert.ok(policy);
  assert.equal(policy.actionType, "reservation");
});

test("target is read from the value cell of a Markdown table, not the header", () => {
  const proposal = buildExternalActionProposal({
    task: "Найди барбершоп в Марбелье и подготовь запись на стрижку, телефон +34 600 000 000. Только подготовь, не отправляй.",
    finalAnswer: [
      "## Proposal: Запись в барбершоп",
      "| Параметр | Значение |",
      "|---|---|",
      "| **Название** | Harrisons Barbershop |",
      "| **Адрес** | Calle Quevedo, Marbella |",
      "🔗 Онлайн-запись: [Booksy](https://booksy.com/es-es/134426_harrisons-barbershop_barberia_29260_marbella)",
    ].join("\n"),
    taskFrame: frameTask(
      "Найди барбершоп в Марбелье и подготовь запись на стрижку, телефон +34 600 000 000. Только подготовь, не отправляй.",
    ),
    runContext: { runId: "run_target_test" },
    artifacts: [],
    sourceUrls: ["https://ai.mobirise.com/sites/barbershop-online-booking-junk.html"],
    createdAt: new Date().toISOString(),
  });
  assert.ok(proposal);
  assert.equal(proposal.target, "Harrisons Barbershop");
  assert.equal(
    proposal.preparation?.targetUrl,
    "https://booksy.com/es-es/134426_harrisons-barbershop_barberia_29260_marbella",
  );
});

test("fixture-style task: explicit URL, weekday+bare time, and clean draft labels", () => {
  const task =
    "Подготовь запись на стрижку через форму записи http://127.0.0.1:3000/api/fixtures/external-actions/appointment на пятницу 17:30. Данные: Test User, test@example.com, +34 600 000 000. Только подготовь и покажи что заполнено — финально не отправляй без моего подтверждения.";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: "**Данные для проверки:**\n* Услуга: Стрижка\n* Дата и время: Пятница, 17:30",
    taskFrame: frameTask(task),
    runContext: { runId: "run_fixture_test" },
    artifacts: [],
    sourceUrls: [],
    createdAt: "2026-06-13T10:00:00.000Z",
  });
  assert.ok(proposal, "policy and proposal expected");
  // The explicitly given URL is the target even though loopback hosts are
  // excluded from public proof sources.
  assert.equal(
    proposal.preparation?.targetUrl,
    "http://127.0.0.1:3000/api/fixtures/external-actions/appointment",
  );
  // "на пятницу 17:30" carries the time — date_or_time must not be missing.
  assert.ok(
    !(proposal.preparation?.missingInputs ?? []).includes("date_or_time"),
    `date_or_time missing: ${JSON.stringify(proposal.preparation?.missingInputs)}`,
  );
  // A bold list label is not the booking target.
  assert.notEqual(proposal.target, "Данные для проверки:");
});
