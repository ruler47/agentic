/**
 * Phase 13 follow-up: the in-process BrowserOperateTool class
 * (Playwright + Chromium driver) has been removed in favour of
 * the dockerized browser-operate-service. This file now exports
 * only the result-data shapes and a type guard, which the runtime
 * still uses to recognise browser.operate artifacts in tool
 * results regardless of the underlying runner.
 */
import { type BrowserContextOptions } from "@playwright/test";
import { ArtifactCreateInput } from "../types.js";

export type BrowserOperateCommand =
  | { type: "navigate"; url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number }
  | { type: "click"; selector?: string; selectors?: string[]; text?: string; timeoutMs?: number; optional?: boolean }
  | { type: "dismissDialogs"; selectors?: string[]; texts?: string[]; timeoutMs?: number }
  | { type: "fill" | "type"; selector: string; text: string; timeoutMs?: number }
  | { type: "selectOption"; selector: string; value?: string; label?: string; index?: number; timeoutMs?: number }
  | { type: "check" | "uncheck"; selector: string; timeoutMs?: number }
  | { type: "press"; selector?: string; key: string; timeoutMs?: number }
  | { type: "waitForSelector"; selector: string; timeoutMs?: number }
  | { type: "waitForText"; text: string; timeoutMs?: number }
  | { type: "wait"; ms: number }
  | { type: "scroll"; selector?: string; x?: number; y?: number }
  | { type: "extractText"; selector?: string; label?: string; maxLength?: number }
  | { type: "extractLinks"; selector?: string; label?: string; limit?: number }
  | { type: "assertText"; selector?: string; text: string; timeoutMs?: number }
  | { type: "assertUrl"; includes?: string; regex?: string }
  | {
      type: "screenshot";
      label?: string;
      fullPage?: boolean;
      filename?: string;
      /**
       * Phase 12 follow-up: hard cap on screenshot height in pixels. The
       * universal-agent-generated discovery commands set this to ~3200 px so
       * artifact viewers can render a single screen-height image without
       * scrolling for ages. When `fullPage` is true and the document is
       * taller than `maxHeight`, the screenshot is clipped to the top
       * `maxHeight` pixels of the page. Default 4000 (operator can pass
       * `null`/0 to disable for a deliberate full-page capture).
       */
      maxHeight?: number;
    };

export type BrowserOperateInput = {
  commands: BrowserOperateCommand[];
  viewport?: { width?: number; height?: number };
  userAgent?: string;
  extraHttpHeaders?: Record<string, string>;
  storageState?: BrowserContextOptions["storageState"];
  defaultTimeoutMs?: number;
  maxCommands?: number;
};

export type BrowserOperateStep = {
  index: number;
  type: string;
  status: "completed" | "failed";
  summary: string;
  durationMs: number;
};

export type BrowserOperateData = {
  finalUrl?: string;
  title?: string;
  extractedText: Array<{ label: string; text: string }>;
  extractedLinks: Array<{ label: string; links: Array<{ text: string; href: string }> }>;
  screenshots: ArtifactCreateInput[];
  steps: BrowserOperateStep[];
  storageState?: unknown;
};

export function isBrowserOperateData(data: unknown): data is BrowserOperateData {
  return (
    Boolean(data) &&
    typeof data === "object" &&
    Array.isArray((data as { steps?: unknown }).steps) &&
    Array.isArray((data as { extractedText?: unknown }).extractedText) &&
    Array.isArray((data as { screenshots?: unknown }).screenshots)
  );
}
