import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  AgentArtifact,
  AgentArtifactKind,
  ArtifactCreateInput,
  ArtifactUploadInput,
} from "../types.js";

type ArtifactManifest = {
  artifacts: AgentArtifact[];
};

type StoredArtifact = {
  artifact: AgentArtifact;
  path: string;
};

export type ArtifactStore = {
  saveUpload(runId: string, upload: ArtifactUploadInput): Promise<AgentArtifact>;
  saveGenerated(runId: string, input: ArtifactCreateInput): Promise<AgentArtifact>;
  list(runId: string): Promise<AgentArtifact[]>;
  read(runId: string, artifactId: string): Promise<StoredArtifact | undefined>;
};

export class LocalArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root = process.env.ARTIFACT_ROOT ?? "/app/workspace/artifacts") {
    this.root = resolve(root);
  }

  async saveUpload(runId: string, upload: ArtifactUploadInput): Promise<AgentArtifact> {
    const content = Buffer.from(upload.contentBase64, "base64");
    return this.save(runId, "input", {
      filename: upload.filename,
      mimeType: upload.mimeType || "application/octet-stream",
      content,
      description: upload.description,
    });
  }

  async saveGenerated(runId: string, input: ArtifactCreateInput): Promise<AgentArtifact> {
    return this.save(runId, "output", input);
  }

  async list(runId: string): Promise<AgentArtifact[]> {
    const manifest = await this.readManifest(runId);
    return manifest.artifacts;
  }

  async read(runId: string, artifactId: string): Promise<StoredArtifact | undefined> {
    const artifact = (await this.list(runId)).find((item) => item.id === artifactId);
    if (!artifact) return undefined;

    return {
      artifact,
      path: this.artifactPath(runId, artifact.kind, artifact.id, artifact.filename),
    };
  }

  private async save(
    runId: string,
    kind: AgentArtifactKind,
    input: ArtifactCreateInput,
  ): Promise<AgentArtifact> {
    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
    const id = createArtifactId();
    const filename = safeFilename(input.filename);
    const directory = this.kindDir(runId, kind);
    const path = this.artifactPath(runId, kind, id, filename);

    await mkdir(directory, { recursive: true });
    await writeFile(path, content);

    const artifact: AgentArtifact = {
      id,
      runId,
      kind,
      filename,
      mimeType: input.mimeType,
      sizeBytes: content.byteLength,
      url: `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(id)}`,
      description: input.description,
      contentPreview: kind === "input" ? previewContent(input.mimeType, content) : undefined,
      createdAt: new Date().toISOString(),
    };
    const manifest = await this.readManifest(runId);
    manifest.artifacts = [...manifest.artifacts.filter((item) => item.id !== id), artifact];
    await this.writeManifest(runId, manifest);

    return artifact;
  }

  private async readManifest(runId: string): Promise<ArtifactManifest> {
    try {
      return JSON.parse(await readFile(this.manifestPath(runId), "utf8")) as ArtifactManifest;
    } catch {
      return { artifacts: [] };
    }
  }

  private async writeManifest(runId: string, manifest: ArtifactManifest): Promise<void> {
    await mkdir(this.runDir(runId), { recursive: true });
    await writeFile(this.manifestPath(runId), JSON.stringify(manifest, null, 2));
  }

  private runDir(runId: string): string {
    return inside(this.root, safeSegment(runId));
  }

  private kindDir(runId: string, kind: AgentArtifactKind): string {
    return inside(this.runDir(runId), kind);
  }

  private manifestPath(runId: string): string {
    return inside(this.runDir(runId), "manifest.json");
  }

  private artifactPath(
    runId: string,
    kind: AgentArtifactKind,
    artifactId: string,
    filename: string,
  ): string {
    return inside(this.kindDir(runId, kind), `${safeSegment(artifactId)}-${safeFilename(filename)}`);
  }
}

function inside(root: string, child: string): string {
  const resolved = resolve(join(root, child));
  const location = relative(root, resolved);
  if (location.startsWith("..") || location === "" || resolve(location) === location) {
    throw new Error("Artifact path escapes artifact root");
  }

  return resolved;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "artifact";
}

function safeFilename(value: string): string {
  return safeSegment(basename(value));
}

function createArtifactId(): string {
  return `artifact_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function previewContent(mimeType: string, content: Buffer): string | undefined {
  if (content.byteLength > 64 * 1024) return undefined;
  if (!isTextLike(mimeType)) return undefined;

  return content.toString("utf8").slice(0, 8000);
}

function isTextLike(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}
