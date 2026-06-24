export function inferDateTimeValue(task: string, createdAt: string): string | undefined {
  const date = inferDate(task, createdAt);
  const time = normalizeTime(
    task.match(/(?:^|[\s,.;])(?:в|at)\s*(\d{1,2})(?::|\.)(\d{2})\b/iu) ??
      task.match(/(?:^|[\s,.;])(?:в|at)\s*(\d{1,2})\b/iu) ??
      task.match(/(?:после|after)\s*(\d{1,2})(?::|\.)(\d{2})?\b/iu) ??
      // Bare HH:MM after a weekday/date ("на пятницу 17:30") — range
      // validation in normalizeTime rejects port-like fragments.
      task.match(/(?:^|[\s,.;(])(\d{1,2}):(\d{2})(?=$|[\s,.;)!?])/u),
  );
  const relativeWindow = inferRelativeDateWindow(task);
  const timeWindow = task.match(/(?:после|after)\s*(\d{1,2})(?::|\.)(\d{2})?\b/iu)
    ? `after ${time ?? "specified time"}`
    : undefined;
  return [date ?? relativeWindow, timeWindow ?? time].filter(Boolean).join(" ") || undefined;
}

function inferRelativeDateWindow(task: string): string | undefined {
  const parts: string[] = [];
  if (/(?:следующ(?:ей|ую)\s+недел|next\s+week)/iu.test(task)) {
    parts.push("next week");
  }
  if (/(?:пн\s*(?:-|—|по|до)\s*чт|понедельник[а-я]*\s*(?:-|—|по|до)\s*четверг[а-я]*|mon(?:day)?\s*(?:-|to|through|until)\s*thu(?:rsday)?)/iu.test(task)) {
    parts.push("Mon-Thu");
  }
  return parts.length ? parts.join(", ") : undefined;
}

function inferDate(task: string, createdAt: string): string | undefined {
  const iso = task.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
  if (iso?.[0]) return iso[0];
  const dotted = task.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/u);
  const reference = validReferenceDate(createdAt);
  if (dotted?.[1] && dotted[2]) {
    const year = normalizeYear(dotted[3], reference);
    const formatted = formatDate(year, Number(dotted[2]), Number(dotted[1]));
    if (formatted) return formatted;
  }
  const relative = task.match(/(сегодня|завтра|послезавтра|today|tomorrow)/iu)?.[1]?.toLowerCase();
  if (relative) {
    const offset = relative === "сегодня" || relative === "today" ? 0 : relative === "послезавтра" ? 2 : 1;
    const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() + offset));
    return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const weekday = inferWeekdayIndex(task);
  if (weekday !== undefined) {
    const currentWeekday = reference.getUTCDay();
    const offset = (weekday - currentWeekday + 7) % 7 || 7;
    const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() + offset));
    return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const monthMatch = task.match(/\b(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/iu);
  if (monthMatch?.[1] && monthMatch[2]) {
    const month = monthNumber(monthMatch[2]);
    if (!month) return undefined;
    const year = normalizeYear(monthMatch[3], reference);
    return formatDate(year, month, Number(monthMatch[1]));
  }
  return undefined;
}

function inferWeekdayIndex(task: string): number | undefined {
  const patterns: Array<[RegExp, number]> = [
    [/(?:^|[^\p{L}\p{N}_])(?:mon(?:day)?|понедельник[а-я]*)(?=$|[^\p{L}\p{N}_])/iu, 1],
    [/(?:^|[^\p{L}\p{N}_])(?:tue(?:sday)?|вторник[а-я]*)(?=$|[^\p{L}\p{N}_])/iu, 2],
    [/(?:^|[^\p{L}\p{N}_])(?:wed(?:nesday)?|сред[ауые]?)(?=$|[^\p{L}\p{N}_])/iu, 3],
    [/(?:^|[^\p{L}\p{N}_])(?:thu(?:rsday)?|четверг[а-я]*)(?=$|[^\p{L}\p{N}_])/iu, 4],
    [/(?:^|[^\p{L}\p{N}_])(?:fri(?:day)?|пятниц[ауые]?)(?=$|[^\p{L}\p{N}_])/iu, 5],
    [/(?:^|[^\p{L}\p{N}_])(?:sat(?:urday)?|суббот[ауые]?)(?=$|[^\p{L}\p{N}_])/iu, 6],
    [/(?:^|[^\p{L}\p{N}_])(?:sun(?:day)?|воскресень[еяю]|воскресенье)(?=$|[^\p{L}\p{N}_])/iu, 0],
  ];
  return patterns.find(([pattern]) => pattern.test(task))?.[1];
}

function normalizeTime(match: RegExpMatchArray | null): string | undefined {
  if (!match?.[1]) return undefined;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function validReferenceDate(createdAt: string): Date {
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeYear(value: string | undefined, reference: Date): number {
  if (!value) return reference.getUTCFullYear();
  const year = Number(value);
  return year < 100 ? 2000 + year : year;
}

function formatDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthNumber(value: string): number | undefined {
  const months = new Map<string, number>([
    ["января", 1], ["january", 1],
    ["февраля", 2], ["february", 2],
    ["марта", 3], ["march", 3],
    ["апреля", 4], ["april", 4],
    ["мая", 5], ["may", 5],
    ["июня", 6], ["june", 6],
    ["июля", 7], ["july", 7],
    ["августа", 8], ["august", 8],
    ["сентября", 9], ["september", 9],
    ["октября", 10], ["october", 10],
    ["ноября", 11], ["november", 11],
    ["декабря", 12], ["december", 12],
  ]);
  return months.get(value.toLowerCase());
}
