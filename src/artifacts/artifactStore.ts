import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
  path?: string;
  content?: Buffer;
};

export type ArtifactMetadataRecord = {
  artifact: AgentArtifact;
  objectKey: string;
  storageProvider: string;
  checksumSha256: string;
};

export type ArtifactStore = {
  saveUpload(runId: string, upload: ArtifactUploadInput): Promise<AgentArtifact>;
  saveGenerated(runId: string, input: ArtifactCreateInput): Promise<AgentArtifact>;
  list(runId: string): Promise<AgentArtifact[]>;
  read(runId: string, artifactId: string): Promise<StoredArtifact | undefined>;
  /**
   * Phase 13 follow-up: remove an artifact by id. Returns true when
   * something was actually deleted (so callers can return 404 vs 200).
   * Implementations remove both the metadata record and the underlying
   * object/file; missing inputs are treated as a no-op (idempotent
   * delete).
   */
  delete(runId: string, artifactId: string): Promise<boolean>;
};

export type ArtifactMetadataStore = {
  save(record: ArtifactMetadataRecord): Promise<AgentArtifact>;
  list(runId: string): Promise<AgentArtifact[]>;
  get(runId: string, artifactId: string): Promise<ArtifactMetadataRecord | undefined>;
  delete(runId: string, artifactId: string): Promise<ArtifactMetadataRecord | undefined>;
};

export type ArtifactObjectStore = {
  readonly provider: string;
  ensureReady?(): Promise<void>;
  putObject(key: string, content: Buffer, metadata: { mimeType: string }): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
};

export class LocalArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root = process.env.ARTIFACT_ROOT ?? defaultArtifactRoot()) {
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

  async delete(runId: string, artifactId: string): Promise<boolean> {
    const manifest = await this.readManifest(runId);
    const target = manifest.artifacts.find((item) => item.id === artifactId);
    if (!target) return false;
    const path = this.artifactPath(runId, target.kind, target.id, target.filename);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(path, { force: true });
    } catch {
      // Missing file → already gone; manifest update still proceeds.
    }
    manifest.artifacts = manifest.artifacts.filter((item) => item.id !== artifactId);
    await this.writeManifest(runId, manifest);
    return true;
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
      contentPreview: previewContent(input.mimeType, content),
      quality: input.quality,
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

function defaultArtifactRoot(): string {
  return existsSync("/app/workspace") ? "/app/workspace/artifacts" : "workspace/artifacts";
}

export class DurableArtifactStore implements ArtifactStore {
  private ready?: Promise<void>;

  constructor(
    private readonly metadataStore: ArtifactMetadataStore,
    private readonly objectStore: ArtifactObjectStore,
  ) {}

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
    return this.metadataStore.list(runId);
  }

  async read(runId: string, artifactId: string): Promise<StoredArtifact | undefined> {
    const record = await this.metadataStore.get(runId, artifactId);
    if (!record) return undefined;

    return {
      artifact: record.artifact,
      content: await this.objectStore.getObject(record.objectKey),
    };
  }

  async delete(runId: string, artifactId: string): Promise<boolean> {
    const record = await this.metadataStore.delete(runId, artifactId);
    if (!record) return false;
    try {
      await this.objectStore.deleteObject(record.objectKey);
    } catch {
      // Object already gone in the store — metadata is the source of truth
      // for visibility, so report success either way.
    }
    return true;
  }

  private async save(
    runId: string,
    kind: AgentArtifactKind,
    input: ArtifactCreateInput,
  ): Promise<AgentArtifact> {
    await this.ensureReady();

    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
    const id = createArtifactId();
    const filename = safeFilename(input.filename);
    const objectKey = `${safeSegment(runId)}/${kind}/${safeSegment(id)}-${filename}`;
    const artifact: AgentArtifact = {
      id,
      runId,
      kind,
      filename,
      mimeType: input.mimeType,
      sizeBytes: content.byteLength,
      url: `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(id)}`,
      description: input.description,
      contentPreview: previewContent(input.mimeType, content),
      quality: input.quality,
      createdAt: new Date().toISOString(),
    };

    await this.objectStore.putObject(objectKey, content, { mimeType: artifact.mimeType });
    return this.metadataStore.save({
      artifact,
      objectKey,
      storageProvider: this.objectStore.provider,
      checksumSha256: sha256Hex(content),
    });
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.objectStore.ensureReady?.() ?? Promise.resolve();
    return this.ready;
  }
}

export class FallbackArtifactStore implements ArtifactStore {
  constructor(
    private readonly primary: ArtifactStore,
    private readonly fallback: ArtifactStore,
  ) {}

  saveUpload(runId: string, upload: ArtifactUploadInput): Promise<AgentArtifact> {
    return this.primary.saveUpload(runId, upload);
  }

  saveGenerated(runId: string, input: ArtifactCreateInput): Promise<AgentArtifact> {
    return this.primary.saveGenerated(runId, input);
  }

  async list(runId: string): Promise<AgentArtifact[]> {
    const [primary, fallback] = await Promise.all([this.primary.list(runId), this.fallback.list(runId)]);
    const seen = new Set<string>();
    return [...primary, ...fallback].filter((artifact) => {
      const key = `${artifact.runId}:${artifact.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async read(runId: string, artifactId: string): Promise<StoredArtifact | undefined> {
    return (await this.primary.read(runId, artifactId)) ?? this.fallback.read(runId, artifactId);
  }

  async delete(runId: string, artifactId: string): Promise<boolean> {
    // Try both stores so we don't leak orphan rows when an artifact lived in
    // one tier but not the other (the historical fallback flow saved
    // generated artifacts only to primary).
    const primary = await this.primary.delete(runId, artifactId).catch(() => false);
    const fallback = await this.fallback.delete(runId, artifactId).catch(() => false);
    return primary || fallback;
  }
}

export class InMemoryArtifactMetadataStore implements ArtifactMetadataStore {
  private readonly records = new Map<string, ArtifactMetadataRecord>();

  async save(record: ArtifactMetadataRecord): Promise<AgentArtifact> {
    this.records.set(recordKey(record.artifact.runId, record.artifact.id), record);
    return record.artifact;
  }

  async list(runId: string): Promise<AgentArtifact[]> {
    return [...this.records.values()]
      .filter((record) => record.artifact.runId === runId)
      .map((record) => record.artifact)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  async get(runId: string, artifactId: string): Promise<ArtifactMetadataRecord | undefined> {
    return this.records.get(recordKey(runId, artifactId));
  }

  async delete(runId: string, artifactId: string): Promise<ArtifactMetadataRecord | undefined> {
    const key = recordKey(runId, artifactId);
    const existing = this.records.get(key);
    if (!existing) return undefined;
    this.records.delete(key);
    return existing;
  }
}

export class InMemoryArtifactObjectStore implements ArtifactObjectStore {
  readonly provider = "memory";
  private readonly objects = new Map<string, Buffer>();

  async putObject(key: string, content: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(content));
  }

  async getObject(key: string): Promise<Buffer> {
    const content = this.objects.get(key);
    if (!content) throw new Error(`Artifact object not found: ${key}`);
    return Buffer.from(content);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
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
    mimeType === "image/svg+xml" ||
    mimeType === "text/csv" ||
    mimeType === "text/tab-separated-values" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

function recordKey(runId: string, artifactId: string): string {
  return `${runId}:${artifactId}`;
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
