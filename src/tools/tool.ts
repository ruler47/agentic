export type ToolInput = Record<string, unknown>;

export type ToolResult = {
  ok: boolean;
  content: string;
};

export type Tool = {
  name: string;
  description: string;
  run(input: ToolInput): Promise<ToolResult>;
};
