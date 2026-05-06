import {
  ToolBuildQaReport,
  ToolBuildReviewReport,
  ToolBuildRequest,
  ToolBuildRequestStore,
} from "./toolBuildRequestStore.js";
import { ToolExample, ToolSchema, ToolStorageContract } from "./tool.js";
import type { ToolPackageManifest } from "./toolPackage.js";

export type ToolBuildOutput = {
  modulePath: string;
  testPath: string;
  summary: string;
  displayName?: string;
  capabilities?: string[];
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  requiredSecretHandles?: string[];
  requiredConfigurationKeys?: string[];
  settingsSchema?: ToolSchema;
  storage?: ToolStorageContract;
  docsMarkdown?: string;
  examples?: ToolExample[];
  packageManifest?: ToolPackageManifest;
  packageWorkspace?: {
    packageRef: string;
    manifestPath: string;
    files: string[];
  };
  changeSummary?: string;
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

export type ToolBuildReviewer = {
  review(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    qaReport: ToolBuildQaReport,
  ): Promise<ToolBuildReviewReport>;
};

export type ToolRegistrar = {
  register(request: ToolBuildRequest, output: ToolBuildOutput, qaReport?: ToolBuildQaReport): Promise<string>;
};

export type ToolBuildActivationReport = {
  ok: boolean;
  summary: string;
  checks: string[];
};

export type ToolActivationRunner = {
  activate(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    registeredToolName: string,
  ): Promise<ToolBuildActivationReport>;
};

export type ToolBuildWorkflowResult = {
  request: ToolBuildRequest;
  registeredToolName?: string;
  activationReport?: ToolBuildActivationReport;
};

export type ToolBuildWorkflowOptions = {
  maxAttempts?: number;
  reviewers?: ToolBuildReviewer[];
  activationRunner?: ToolActivationRunner;
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
    if (request.status === "registered") {
      return {
        request,
        registeredToolName: request.registeredToolName,
      };
    }

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

        const reviewedQaReport = await this.runReviewGates(request, output, qaReport);
        previousQaReport = reviewedQaReport;
        const failedReview = reviewedQaReport.reviews?.find((review) => review.decision !== "pass");
        if (failedReview) {
          if (attempt < maxAttempts) {
            await this.requests.updateStatus(id, {
              status: "building",
              statusDetail: `${failedReview.kind} review returned ${failedReview.decision} on attempt ${attempt}/${maxAttempts}; returning findings to Tool Builder for repair.`,
              qaReport: reviewedQaReport,
            });
            continue;
          }

          return {
            request: await this.requests.updateStatus(id, {
              status: "qa_failed",
              statusDetail: `${failedReview.kind} review returned ${failedReview.decision}: ${failedReview.summary}`,
              qaReport: reviewedQaReport,
            }),
          };
        }

        await this.requests.updateStatus(id, {
          status: "qa_passed",
          statusDetail: reviewedQaReport.summary,
          qaReport: reviewedQaReport,
        });

        const registeredToolName = await this.registrar.register(request, output, reviewedQaReport);
        const activationReport = await this.runActivation(request, output, registeredToolName);
        const finalQaReport = appendActivationReport(reviewedQaReport, activationReport);
        if (activationReport && !activationReport.ok) {
          return {
            registeredToolName,
            activationReport,
            request: await this.requests.updateStatus(id, {
              status: "blocked",
              statusDetail: `Registered ${registeredToolName}, but activation failed: ${activationReport.summary}`,
              qaReport: finalQaReport,
              registeredToolName,
            }),
          };
        }

        return {
          registeredToolName,
          activationReport,
          request: await this.requests.updateStatus(id, {
            status: "registered",
            statusDetail: activationReport
              ? `Registered and activated ${registeredToolName}. ${activationReport.summary}`
              : `Registered ${registeredToolName}.`,
            qaReport: finalQaReport,
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

  private async runActivation(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    registeredToolName: string,
  ): Promise<ToolBuildActivationReport | undefined> {
    if (!this.options.activationRunner) return undefined;

    try {
      return await this.options.activationRunner.activate(request, output, registeredToolName);
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
        checks: ["runtime activation runner threw before confirming generated tool availability"],
      };
    }
  }

  private async runReviewGates(
    request: ToolBuildRequest,
    output: ToolBuildOutput,
    qaReport: ToolBuildQaReport,
  ): Promise<ToolBuildQaReport> {
    const reviews: ToolBuildReviewReport[] = [];
    for (const reviewer of this.options.reviewers ?? []) {
      reviews.push(await reviewer.review(request, output, qaReport));
    }
    if (reviews.length === 0) return qaReport;

    return {
      ...qaReport,
      checks: [
        ...qaReport.checks,
        ...reviews.map((review) => `${review.kind} review ${review.decision}: ${review.summary}`),
      ],
      reviews,
    };
  }
}

function appendActivationReport(
  qaReport: ToolBuildQaReport,
  activationReport?: ToolBuildActivationReport,
): ToolBuildQaReport {
  if (!activationReport) return qaReport;

  return {
    ...qaReport,
    ok: qaReport.ok && activationReport.ok,
    summary: activationReport.ok
      ? `${qaReport.summary} Activation passed: ${activationReport.summary}`
      : `${qaReport.summary} Activation failed: ${activationReport.summary}`,
    checks: [
      ...qaReport.checks,
      ...activationReport.checks.map((check) => `activation ${activationReport.ok ? "pass" : "fail"}: ${check}`),
    ],
  };
}
