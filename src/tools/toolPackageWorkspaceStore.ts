import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import {
  normalizeToolPackageManifest,
  serializeToolPackageManifest,
  ToolPackageManifest,
} from "./toolPackage.js";

export type ToolPackageWorkspaceFile = {
  path: string;
  content: string;
};

export type ToolPackageWorkspaceInput = {
  manifest: Omit<ToolPackageManifest, "package"> & {
    package?: ToolPackageManifest["package"];
  };
  files?: ToolPackageWorkspaceFile[];
  readmeMarkdown?: string;
  dockerfile?: string;
  packageJson?: Record<string, unknown>;
  tsconfigJson?: Record<string, unknown>;
};

export type ToolPackageWorkspaceRecord = {
  manifest: ToolPackageManifest;
  packageDir: string;
  packageRef: string;
  manifestPath: string;
  files: string[];
};

export class ToolPackageWorkspaceStore {
  constructor(
    private readonly projectRoot = process.cwd(),
    private readonly workspaceRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT ?? "tools",
  ) {}

  async writeSourceBundlePackage(input: ToolPackageWorkspaceInput): Promise<ToolPackageWorkspaceRecord> {
    if (input.manifest.package && input.manifest.package.type !== "source-bundle") {
      throw new Error("ToolPackageWorkspaceStore only writes source-bundle packages.");
    }
    const baseManifest = normalizeToolPackageManifest({
      ...input.manifest,
      package: input.manifest.package ?? {
        type: "source-bundle",
        ref: packageRef(input.manifest.name, input.manifest.version),
      },
    });
    const manifest = normalizeToolPackageManifest({
      ...baseManifest,
      package: {
        type: "source-bundle",
        ref: safePackageRef(baseManifest.package.ref),
      },
    });
    const root = resolve(this.projectRoot, this.workspaceRoot);
    const packageDir = safeChildPath(root, manifest.package.ref);
    await mkdir(packageDir, { recursive: true });

    const files: ToolPackageWorkspaceFile[] = [
      {
        path: "tool.package.json",
        content: serializeToolPackageManifest(manifest),
      },
      {
        path: "README.md",
        content: input.readmeMarkdown ?? defaultReadme(manifest),
      },
      {
        path: "Dockerfile",
        content: input.dockerfile ?? defaultDockerfile(),
      },
      {
        path: "package.json",
        content: `${JSON.stringify(input.packageJson ?? defaultPackageJson(manifest), null, 2)}\n`,
      },
      {
        path: "tsconfig.json",
        content: `${JSON.stringify(input.tsconfigJson ?? defaultTsconfigJson(), null, 2)}\n`,
      },
      {
        path: ".gitignore",
        content: "node_modules/\ndist/\n.env\n.DS_Store\n",
      },
      ...(input.files ?? []),
    ];

    const writtenFiles: string[] = [];
    for (const file of files) {
      const target = safeChildPath(packageDir, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
      writtenFiles.push(relative(this.projectRoot, target).replace(/\\/g, "/"));
    }

    return {
      manifest,
      packageDir,
      packageRef: manifest.package.ref,
      manifestPath: relative(this.projectRoot, join(packageDir, "tool.package.json")).replace(/\\/g, "/"),
      files: writtenFiles,
    };
  }
}

function packageRef(name: string, version: string): string {
  return `${packageSegment(name)}/${packageSegment(version)}`;
}

function packageSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 96) || "package";
}

function safePackageRef(value: string): string {
  if (isAbsolute(value)) throw new Error("source-bundle package refs must be relative.");
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("source-bundle package refs must stay inside the tool package workspace.");
  }
  return normalized;
}

function safeChildPath(root: string, child: string): string {
  if (isAbsolute(child)) throw new Error("tool package paths must be relative.");
  const resolved = resolve(root, child);
  const rel = relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("tool package paths must stay inside the package workspace.");
  }
  return resolved;
}

function defaultReadme(manifest: ToolPackageManifest): string {
  return [
    `# ${manifest.displayName ?? manifest.name}`,
    "",
    manifest.description,
    "",
    "## Runtime Contract",
    "",
    "- `GET /health` returns `{ ok, detail }`.",
    "- `POST /run` accepts `{ input, context }` and returns `{ ok, content, data? }`.",
    "- Always-on tools may also expose `POST /service/start` and `POST /service/stop`.",
    "",
    "## Portability",
    "",
    "This package is designed to run outside the Agentic application. Agentic imports",
    "`tool.package.json`, resolves declared config/secrets, and calls the runtime over HTTP.",
    "",
  ].join("\n");
}

function defaultDockerfile(): string {
  return [
    "FROM node:22-alpine",
    "WORKDIR /app",
    "COPY package*.json ./",
    "RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi",
    "COPY dist ./dist",
    "EXPOSE 8080",
    "CMD [\"node\", \"dist/index.js\"]",
    "",
  ].join("\n");
}

function defaultPackageJson(manifest: ToolPackageManifest): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    private: true,
    type: "module",
    scripts: {
      build: "tsc -p tsconfig.json",
      start: "node dist/index.js",
      test: "node --test \"dist/tests/**/*.test.js\"",
    },
    devDependencies: {
      typescript: "^5.6.3",
    },
  };
}

function defaultTsconfigJson(): Record<string, unknown> {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      outDir: "dist",
      rootDir: ".",
    },
    include: ["src/**/*.ts", "tests/**/*.ts"],
  };
}
