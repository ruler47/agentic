import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "./tool.js";

export type ToolUsageEvent = {
  toolName: string;
  outcome: "success" | "failure";
  at: Date;
};

export type ToolUsageReporter = (event: ToolUsageEvent) => Promise<void> | void;
export type ToolRuntimeContextProvider = (input: {
  tool: Tool;
  input: ToolInput;
  context: ToolExecutionContext;
}) => Promise<Partial<Omit<ToolExecutionContext, "toolName" | "now">> | undefined>
  | Partial<Omit<ToolExecutionContext, "toolName" | "now">>
  | undefined;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private usageReporter?: ToolUsageReporter;
  private runtimeContextProvider?: ToolRuntimeContextProvider;

  setUsageReporter(reporter: ToolUsageReporter | undefined): void {
    this.usageReporter = reporter;
  }

  setRuntimeContextProvider(provider: ToolRuntimeContextProvider | undefined): void {
    this.runtimeContextProvider = provider;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  findByCapability(capability: string): Tool[] {
    return this.list().filter((tool) => tool.capabilities.includes(capability));
  }

  async execute(
    tool: Tool,
    input: ToolInput,
    context?: Partial<Omit<ToolExecutionContext, "toolName">>,
  ): Promise<ToolResult> {
    const now = context?.now ?? new Date();
    const baseContext: ToolExecutionContext = {
      ...(context ?? {}),
      toolName: tool.name,
      now,
    };
    try {
      const providedContext = await this.runtimeContextProvider?.({
        tool,
        input,
        context: baseContext,
      });
      const result = await tool.run(input, {
        ...baseContext,
        ...(providedContext ?? {}),
        toolName: tool.name,
        now,
      });
      await this.recordUsage(tool.name, result.ok ? "success" : "failure");
      return result;
    } catch (error) {
      await this.recordUsage(tool.name, "failure");
      throw error;
    }
  }

  private async recordUsage(toolName: string, outcome: "success" | "failure"): Promise<void> {
    if (!this.usageReporter) return;

    try {
      await this.usageReporter({ toolName, outcome, at: new Date() });
    } catch (error) {
      console.warn(
        `Failed to record usage for tool ${toolName}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
