import {
  ToolBuildQaReport,
  ToolBuildRequest,
  ToolBuildRequestStore,
} from "./toolBuildRequestStore.js";
import { ToolSchema } from "./tool.js";

export type ToolBuildOutput = {
  modulePath: string;
  testPath: string;
  summary: string;
  capabilities?: string[];
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  requiredSecretHandles?: string[];
  docsMarkdown?: string;
};

export type ToolBuildAttemptContext = {
  attempt: number;
  previousOutput?: ToolBuildOutput;
  previousQaReport?: ToolBuildQaReport;
};

export type ToolBuilder = {
  build(request: ToolBuildRequest, context?: ToolBuildAttemptContext): Promise<ToolBuildOutput>;
};

export type ToolQaRunner = {
  run(request: ToolBuildRequest, output: ToolBuildOutput): Promise<ToolBuildQaReport>;
};

export type ToolRegistrar = {
  register(request: ToolBuildRequest, output: ToolBuildOutput): Promise<string>;
};

export type ToolBuildWorkflowResult = {
  request: ToolBuildRequest;
  registeredToolName?: string;
};

export type ToolBuildWorkflowOptions = {
  maxAttempts?: number;
};

export class ToolBuildWorkflow {
  constructor(
    private readonly requests: ToolBuildRequestStore,
    private readonly builder: ToolBuilder,
    private readonly qaRunner: ToolQaRunner,
    private readonly registrar: ToolRegistrar,
    private readonly options: ToolBuildWorkflowOptions = {},
  ) {}

  async runOnce(id: string): Promise<ToolBuildWorkflowResult> {
    const request = await this.requests.get(id);
    if (!request) {
      throw new Error(`Tool build request ${id} was not found`);
    }

    return this.runRequest(request);
  }

  async runClaimed(request: ToolBuildRequest): Promise<ToolBuildWorkflowResult> {
    if (request.status !== "building") {
      throw new Error(`Tool build request ${request.id} must be claimed before runClaimed`);
    }

    return this.runRequest(request);
  }

  private async runRequest(request: ToolBuildRequest): Promise<ToolBuildWorkflowResult> {
    const id = request.id;

    try {
      const maxAttempts = Math.max(1, Math.min(this.options.maxAttempts ?? 2, 5));
      let previousOutput: ToolBuildOutput | undefined;
      let previousQaReport: ToolBuildQaReport | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await this.requests.updateStatus(id, {
          status: "building",
          statusDetail: `Tool Builder claimed the request. Attempt ${attempt}/${maxAttempts}.`,
          qaReport: previousQaReport,
        });

        const output = await this.builder.build(request, {
          attempt,
          previousOutput,
          previousQaReport,
        });
        previousOutput = output;
        await this.requests.updateStatus(id, {
          status: "building",
          statusDetail: `Tool Builder attempt ${attempt}/${maxAttempts} produced ${output.modulePath} and ${output.testPath}. ${output.summary}`,
          qaReport: previousQaReport,
        });

        const qaReport = await this.qaRunner.run(request, output);
        previousQaReport = qaReport;
        if (!qaReport.ok) {
          if (attempt < maxAttempts) {
            await this.requests.updateStatus(id, {
              status: "building",
              statusDetail: `QA failed on attempt ${attempt}/${maxAttempts}; returning report to Tool Builder for repair.`,
              qaReport,
            });
            continue;
          }

          return {
            request: await this.requests.updateStatus(id, {
              status: "qa_failed",
              statusDetail: qaReport.summary,
              qaReport,
            }),
          };
        }

        await this.requests.updateStatus(id, {
          status: "qa_passed",
          statusDetail: qaReport.summary,
          qaReport,
        });

        const registeredToolName = await this.registrar.register(request, output);
        return {
          registeredToolName,
          request: await this.requests.updateStatus(id, {
            status: "registered",
            statusDetail: `Registered ${registeredToolName}.`,
            qaReport,
            registeredToolName,
          }),
        };
      }

      return {
        request: await this.requests.updateStatus(id, {
          status: "qa_failed",
          statusDetail: "Tool Builder exhausted attempts without a passing QA report.",
          qaReport: previousQaReport,
        }),
      };
    } catch (error) {
      return {
        request: await this.requests.updateStatus(id, {
          status: "blocked",
          statusDetail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
}
