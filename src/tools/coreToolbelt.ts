import { FileReadTool, FileWriteTool } from "./fileTools.js";
import { BrowserOperateHttpTool } from "./browserOperateHttpTool.js";
import type { Tool } from "./tool.js";
import { WebSearchTool } from "./webSearchTool.js";
import { WebReadTool } from "./webReadTool.js";
import { BrowserScreenshotTool } from "./browserScreenshotTool.js";
import { HttpRequestTool } from "./httpRequestTool.js";
import { DocumentExtractTool } from "./documentExtractTool.js";
import { DataTransformTool } from "./dataTransformTool.js";
import { ExternalActionCommitTool, ExternalActionPrepareTool } from "./externalActionTools.js";
import { createChannelTelegramTool } from "./channelTelegramTool.js";

export type CoreToolbeltOptions = {
  enabled?: boolean;
};

export function createCoreToolbelt(options: CoreToolbeltOptions = {}): Tool[] {
  if (options.enabled === false) return [];

  return [
    new WebSearchTool(),
    new WebReadTool(),
    new BrowserOperateHttpTool(),
    new BrowserScreenshotTool(),
    new HttpRequestTool(),
    new FileReadTool(),
    new FileWriteTool(),
    new DocumentExtractTool(),
    new DataTransformTool(),
    new ExternalActionPrepareTool(),
    new ExternalActionCommitTool(),
    createChannelTelegramTool(),
  ];
}
