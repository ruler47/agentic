import type { ToolModuleMetadata } from "./toolMetadataStore.js";
import type { ToolPackageLoadResult, ToolPackageRunner, ToolPackageRunnerInfo } from "./toolPackageRunnerTypes.js";
import { externalHttpProxyTool } from "./toolPackageRunnerHttpRuntime.js";
import { isHttpUrl, normalizeBaseUrl } from "./toolPackageRunnerShared.js";

export class ExternalHttpToolPackageRunner implements ToolPackageRunner {
  readonly type = "external-package";

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  canLoad(metadata: ToolModuleMetadata): boolean {
    const reference = metadata.packageManifest?.package;
    return reference?.type === "external-package" && isHttpUrl(reference.ref);
  }

  async load(metadata: ToolModuleMetadata): Promise<ToolPackageLoadResult> {
    const ref = metadata.packageManifest?.package.ref;
    if (!ref || !isHttpUrl(ref)) {
      const detail = "External package ref must be an http(s) URL for the HTTP package runner.";
      return { loaded: false, detail, health: { ok: false, detail } };
    }
    const baseUrl = normalizeBaseUrl(ref);
    const tool = externalHttpProxyTool(metadata, baseUrl, this.fetchImpl);
    const health = await tool.healthcheck?.() ?? { ok: true, detail: "No healthcheck registered." };
    if (!health.ok) return { loaded: false, detail: health.detail, health };
    return {
      loaded: true,
      detail: `Loaded ${metadata.name} as external HTTP package ${baseUrl}`,
      tool,
      health,
    };
  }

  describe(): ToolPackageRunnerInfo {
    return {
      name: "External HTTP package runner",
      type: this.type,
      status: "available",
      detail: "Loads external-package manifests whose package.ref is an HTTP(S) tool-runtime endpoint exposing /health, /run, and optional /service lifecycle routes.",
      supportedPackageTypes: ["external-package"],
    };
  }
}
