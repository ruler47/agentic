export type ToolInput = Record<string, unknown>;

export type ToolResult = {
  ok: boolean;
  content: string;
  data?: unknown;
};

export type Tool = {
  name: string;
  description: string;
  capabilities: string[];
  run(input: ToolInput): Promise<ToolResult>;
};
