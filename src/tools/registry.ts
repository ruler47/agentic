import { Tool } from "./tool.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  findByCapability(capability: string): Tool[] {
    return this.list().filter((tool) => tool.capabilities.includes(capability));
  }
}
