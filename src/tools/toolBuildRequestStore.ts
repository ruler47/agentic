import { ToolSchema, ToolStartupMode } from "./tool.js";

export type ToolBuildRequestStatus =
  | "requested"
  | "building"
  | "qa_failed"
  | "qa_passed"
  | "registered"
  | "blocked";

export type ToolBuildRequestInput = {
  capability: string;
  displayName?: string;
  reason: string;
  sourceRunId?: string;
  sourceSpanId?: string;
  taskSummary?: string;
  desiredToolName?: string;
  requiredInputs?: string[];
  requiredOutputs?: string[];
  qaCriteria?: string[];
  credentialHandles?: string[];
  credentialNotes?: string;
  reworkOf?: string;
  feedback?: string;
  replacesToolName?: string;
  replacesVersion?: string;
  startupMode?: ToolStartupMode;
};

export type ToolBuildContract = {
  toolName: string;
  displayName?: string;
  modulePath: string;
  testPath: string;
  capability: string;
  description: string;
  startupMode: ToolStartupMode;
  inputSchema: ToolSchema;
  outputSchema: ToolSchema;
  acceptanceCriteria: string[];
  qaCriteria: string[];
  builderInstructions: string[];
  version: string;
  replacesVersion?: string;
};

export type ToolBuildQaReport = {
  ok: boolean;
  summary: string;
  checks: string[];
  artifacts?: string[];
};

export type ToolBuildRequest = ToolBuildRequestInput & {
  id: string;
  status: ToolBuildRequestStatus;
  statusDetail?: string;
  qaReport?: ToolBuildQaReport;
  registeredToolName?: string;
  contract: ToolBuildContract;
  createdAt: string;
  updatedAt: string;
};

export type ToolBuildRequestStatusUpdate = {
  status: ToolBuildRequestStatus;
  statusDetail?: string;
  qaReport?: ToolBuildQaReport;
  registeredToolName?: string;
};

export type ToolBuildRequestStore = {
  create(input: ToolBuildRequestInput): Promise<ToolBuildRequest>;
  get(id: string): Promise<ToolBuildRequest | undefined>;
  list(limit?: number): Promise<ToolBuildRequest[]>;
  claimNextRequested?(statusDetail?: string): Promise<ToolBuildRequest | undefined>;
  updateStatus(id: string, update: ToolBuildRequestStatusUpdate): Promise<ToolBuildRequest>;
  delete(id: string): Promise<boolean>;
};

export class InMemoryToolBuildRequestStore implements ToolBuildRequestStore {
  private readonly requests = new Map<string, ToolBuildRequest>();

  async create(input: ToolBuildRequestInput): Promise<ToolBuildRequest> {
    const now = new Date().toISOString();
    const request: ToolBuildRequest = {
      ...input,
      id: createToolBuildRequestId(input.capability),
      status: "requested",
      contract: createToolBuildContract(input),
      createdAt: now,
      updatedAt: now,
    };

    this.requests.set(request.id, cloneRequest(request));
    return cloneRequest(request);
  }

  async get(id: string): Promise<ToolBuildRequest | undefined> {
    const request = this.requests.get(id);
    return request ? cloneRequest(request) : undefined;
  }

  async list(limit = 100): Promise<ToolBuildRequest[]> {
    return [...this.requests.values()]
      .map(cloneRequest)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async updateStatus(id: string, update: ToolBuildRequestStatusUpdate): Promise<ToolBuildRequest> {
    const existing = this.requests.get(id);
    if (!existing) {
      throw new Error(`Tool build request ${id} was not found`);
    }

    const updated: ToolBuildRequest = {
      ...existing,
      status: update.status,
      statusDetail: update.statusDetail,
      qaReport: update.qaReport,
      registeredToolName: update.registeredToolName,
      updatedAt: new Date().toISOString(),
    };
    this.requests.set(id, cloneRequest(updated));
    return cloneRequest(updated);
  }

  async claimNextRequested(statusDetail = "Claimed by Tool Builder worker."): Promise<ToolBuildRequest | undefined> {
    const next = [...this.requests.values()]
      .filter((request) => request.status === "requested")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return undefined;

    return this.updateStatus(next.id, {
      status: "building",
      statusDetail,
      qaReport: next.qaReport,
      registeredToolName: next.registeredToolName,
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.requests.delete(id);
  }
}

export function createToolBuildContract(input: ToolBuildRequestInput): ToolBuildContract {
  const slug = slugify(input.capability || "tool-capability");
  const toolName = input.desiredToolName?.trim() || `generated.${slug.replace(/-/g, ".")}`;
  const version = input.replacesVersion ? bumpMinorVersion(input.replacesVersion) : "1.0.0";
  const pathSlug = input.replacesVersion ? `${slug}-v${version.replace(/[^a-z0-9]+/gi, "-")}` : slug;
  const requiredInputs = input.requiredInputs?.length ? input.requiredInputs : ["task", "context"];
  const requiredOutputs = input.requiredOutputs?.length ? input.requiredOutputs : ["content", "data"];
  const qaCriteria = input.qaCriteria?.length
    ? input.qaCriteria
    : [
        "Tool contract has name, version, capabilities, schemas, startup mode, healthcheck, and run implementation.",
        "Tests cover success, invalid input, and at least one failure path.",
        "Manual smoke check proves the tool can satisfy the requested capability.",
        "Generated module is TypeScript-only and does not bypass workspace or network guardrails.",
      ];

  return {
    toolName,
    displayName: input.displayName?.trim() || undefined,
    modulePath: `src/tools/generated/${pathSlug}Tool.ts`,
    testPath: `tests/generated/${pathSlug}Tool.test.ts`,
    capability: input.capability,
    description: `Generated tool module for capability: ${input.capability}.`,
    startupMode: input.startupMode ?? "on-demand",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(requiredInputs.map((name) => [name, { type: "string" }])),
      required: requiredInputs,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        content: { type: "string" },
        data: { type: "object", properties: Object.fromEntries(requiredOutputs.map((name) => [name, {}])) },
      },
      required: ["ok", "content"],
    },
    acceptanceCriteria: [
      `Provides capability "${input.capability}" through the standard Tool interface.`,
      "Registers exactly one explicit capability set and no hidden side effects.",
      "Returns structured failure results instead of throwing for expected bad inputs.",
      "Emits enough content/data for the parent agent to cite evidence in the final answer.",
    ],
    qaCriteria,
    version,
    replacesVersion: input.replacesVersion,
    builderInstructions: [
      "Create a TypeScript module implementing the Tool interface.",
      "Keep dependencies explicit and minimal; prefer existing project utilities.",
      `Use startupMode "${input.startupMode ?? "on-demand"}". For always-on/service-style tools, expose a healthcheck and make lifecycle behavior observable without requiring a special runtime branch.`,
      ...(input.credentialHandles?.length
        ? [
            `Use only these credential handles when credentials are needed: ${input.credentialHandles.join(", ")}.`,
            "Do not copy raw credentials into source, prompts, tests, logs, or artifacts.",
          ]
        : []),
      ...(input.credentialNotes?.trim()
        ? [
            "Operator supplied credential notes for this request. Infer durable secret handles/settings from the request and documentation.",
            "Never echo raw credential material into source, tests, logs, traces, memory, or artifacts.",
          ]
        : []),
      "Add focused tests for the module contract and behavior.",
      "Run automated tests and a manual smoke check before changing registry status.",
      "Register the module only after QA passes.",
    ],
  };
}

function bumpMinorVersion(version: string): string {
  const [majorRaw, minorRaw] = version.split(".");
  const major = Number.parseInt(majorRaw ?? "1", 10);
  const minor = Number.parseInt(minorRaw ?? "0", 10);
  return `${Number.isFinite(major) ? major : 1}.${Number.isFinite(minor) ? minor + 1 : 1}.0`;
}

function createToolBuildRequestId(capability: string): string {
  return `toolbuild_${Date.now()}_${slugify(capability).slice(0, 32)}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "tool";
}

function cloneRequest(request: ToolBuildRequest): ToolBuildRequest {
  return {
    ...request,
    displayName: request.displayName,
    requiredInputs: request.requiredInputs ? [...request.requiredInputs] : undefined,
    requiredOutputs: request.requiredOutputs ? [...request.requiredOutputs] : undefined,
    qaCriteria: request.qaCriteria ? [...request.qaCriteria] : undefined,
    reworkOf: request.reworkOf,
    feedback: request.feedback,
    replacesToolName: request.replacesToolName,
    replacesVersion: request.replacesVersion,
    credentialHandles: request.credentialHandles ? [...request.credentialHandles] : undefined,
    credentialNotes: request.credentialNotes,
    qaReport: request.qaReport
      ? {
          ...request.qaReport,
          checks: [...request.qaReport.checks],
          artifacts: request.qaReport.artifacts ? [...request.qaReport.artifacts] : undefined,
        }
      : undefined,
    contract: {
      ...request.contract,
      inputSchema: { ...request.contract.inputSchema },
      outputSchema: { ...request.contract.outputSchema },
      acceptanceCriteria: [...request.contract.acceptanceCriteria],
      qaCriteria: [...request.contract.qaCriteria],
      builderInstructions: [...request.contract.builderInstructions],
      version: request.contract.version,
      replacesVersion: request.contract.replacesVersion,
    },
  };
}
