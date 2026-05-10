import { createHash, createHmac } from "node:crypto";
import { ArtifactObjectStore } from "./artifactStore.js";

export type S3ObjectStoreConfig = {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
};

export class S3ObjectStore implements ArtifactObjectStore {
  readonly provider = "s3";
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly region: string;

  constructor(config: S3ObjectStoreConfig) {
    this.endpoint = new URL(config.endpoint);
    this.bucket = config.bucket;
    this.accessKey = config.accessKey;
    this.secretKey = config.secretKey;
    this.region = config.region ?? "us-east-1";
  }

  async ensureReady(): Promise<void> {
    const head = await this.request("HEAD", undefined);
    if (head.status >= 200 && head.status < 300) return;
    if (head.status !== 404) {
      throw new Error(`Artifact bucket healthcheck failed: ${head.status} ${head.statusText}`);
    }

    const created = await this.request("PUT", undefined);
    if (created.status < 200 || created.status >= 300) {
      throw new Error(`Artifact bucket creation failed: ${created.status} ${created.statusText}`);
    }
  }

  async putObject(key: string, content: Buffer, metadata: { mimeType: string }): Promise<void> {
    const response = await this.request("PUT", key, content, metadata.mimeType);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Artifact object upload failed: ${response.status} ${response.statusText}`);
    }
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.request("GET", key);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Artifact object read failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    // 200 / 204 mean deleted; 404 means already gone (idempotent).
    if (response.status >= 200 && response.status < 300) return;
    if (response.status === 404) return;
    throw new Error(`Artifact object delete failed: ${response.status} ${response.statusText}`);
  }

  private request(
    method: "GET" | "HEAD" | "PUT" | "DELETE",
    objectKey?: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<Response> {
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
    const requestDate = new Date();
    const amzDate = toAmzDate(requestDate);
    const dateScope = amzDate.slice(0, 8);
    const canonicalUri = objectKey
      ? `/${encodePathSegments([this.bucket, ...objectKey.split("/")])}`
      : `/${encodeURIComponent(this.bucket)}`;
    const url = new URL(canonicalUri, this.endpoint);
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (contentType) headers["content-type"] = contentType;

    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((key) => `${key}:${headers[key]}\n`)
      .join("");
    const canonicalRequest = [
      method,
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateScope}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(Buffer.from(canonicalRequest)),
    ].join("\n");
    const signature = hmacHex(signingKey(this.secretKey, dateScope, this.region), stringToSign);
    headers.authorization = [
      `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(", ");

    return fetch(url, {
      method,
      headers,
      body: method === "PUT" && body ? new Uint8Array(body) : undefined,
    });
  }
}

export function s3ConfigFromEnv(): S3ObjectStoreConfig | undefined {
  const endpoint = process.env.MINIO_ENDPOINT ?? process.env.S3_ENDPOINT;
  const bucket = process.env.MINIO_BUCKET ?? process.env.S3_BUCKET ?? "agentic-artifacts";
  const accessKey = process.env.MINIO_ACCESS_KEY ?? process.env.S3_ACCESS_KEY;
  const secretKey = process.env.MINIO_SECRET_KEY ?? process.env.S3_SECRET_KEY;
  const region = process.env.S3_REGION ?? "us-east-1";

  if (!endpoint || !accessKey || !secretKey) return undefined;
  return { endpoint, bucket, accessKey, secretKey, region };
}

function encodePathSegments(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hmac(key: Buffer | string, content: string): Buffer {
  return createHmac("sha256", key).update(content).digest();
}

function hmacHex(key: Buffer, content: string): string {
  return createHmac("sha256", key).update(content).digest("hex");
}

function signingKey(secretKey: string, dateScope: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretKey}`, dateScope);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}
