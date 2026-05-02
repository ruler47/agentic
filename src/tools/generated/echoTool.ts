import { Tool } from "../tool.js";

export const tool: Tool = {
  name: "generated.test.echo",
  version: "1.0.0",
  description: "Generated fixture tool used to verify generated tool loading.",
  capabilities: ["test-echo"],
  startupMode: "on-demand",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
    },
    required: ["ok", "content"],
  },
  async healthcheck() {
    return { ok: true, detail: "Generated echo fixture is healthy." };
  },
  async run(input) {
    const text = typeof input.text === "string" ? input.text : "";
    if (!text) return { ok: false, content: "text is required." };

    return { ok: true, content: text };
  },
};

export default tool;
