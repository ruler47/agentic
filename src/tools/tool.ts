export type ToolInput = Record<string, unknown>;

export type ToolResult = {
  ok: boolean;
  content: string;
  data?: unknown;
};

export type ToolSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolStartupMode = "always-on" | "on-demand" | "ephemeral";

export type ToolHealth = {
  ok: boolean;
  detail: string;
};

export type Tool = {
  name: string;
  version?: string;
  description: string;
  capabilities: string[];
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  startupMode?: ToolStartupMode;
  healthcheck?(): Promise<ToolHealth>;
  run(input: ToolInput): Promise<ToolResult>;
};
