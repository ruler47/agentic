const embeddingDimensions = 128;

export type TextEmbedding = {
  dimensions: number;
  values: number[];
};

export type TextEmbeddingProvider = {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<TextEmbedding>;
};

export type OpenAiCompatibleEmbeddingConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  targetDimensions?: number;
  fetchImpl?: typeof fetch;
};

type EmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
  error?: unknown;
};

export class DeterministicTextEmbeddingProvider implements TextEmbeddingProvider {
  readonly name = "deterministic-local";

  constructor(readonly dimensions = embeddingDimensions) {}

  async embed(text: string): Promise<TextEmbedding> {
    return createDeterministicTextEmbedding(text, this.dimensions);
  }
}

export class OpenAiCompatibleTextEmbeddingProvider implements TextEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenAiCompatibleEmbeddingConfig) {
    this.name = `openai-compatible:${config.model}`;
    this.dimensions = config.targetDimensions ?? embeddingDimensions;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async embed(text: string): Promise<TextEmbedding> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        input: text,
      }),
    });
    const rawBody = await response.text();
    const data = parseEmbeddingResponse(rawBody);

    if (!response.ok) {
      throw new Error(extractEmbeddingError(data, response.status, rawBody));
    }

    const values = data.data?.[0]?.embedding;
    if (!values?.length || values.some((value) => !Number.isFinite(value))) {
      throw new Error("Embedding response did not contain a numeric embedding vector");
    }

    return projectEmbedding({ dimensions: values.length, values }, this.dimensions);
  }
}

export class FallbackTextEmbeddingProvider implements TextEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  constructor(
    private readonly primary: TextEmbeddingProvider,
    private readonly fallback: TextEmbeddingProvider = new DeterministicTextEmbeddingProvider(primary.dimensions),
  ) {
    this.name = `${primary.name}+fallback:${fallback.name}`;
    this.dimensions = fallback.dimensions;
  }

  async embed(text: string): Promise<TextEmbedding> {
    try {
      return projectEmbedding(await this.primary.embed(text), this.dimensions);
    } catch {
      return this.fallback.embed(text);
    }
  }
}

export function createTextEmbeddingProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TextEmbeddingProvider {
  const dimensions = parseEmbeddingDimensions(env.MEMORY_EMBEDDING_DIMENSIONS);
  const fallback = new DeterministicTextEmbeddingProvider(dimensions);
  const model = env.EMBEDDING_MODEL;

  if (!model || env.EMBEDDING_PROVIDER === "deterministic") return fallback;

  return new FallbackTextEmbeddingProvider(
    new OpenAiCompatibleTextEmbeddingProvider({
      baseUrl: env.EMBEDDING_BASE_URL ?? env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1",
      model,
      apiKey: env.EMBEDDING_API_KEY ?? env.OPENAI_API_KEY,
      targetDimensions: dimensions,
    }),
    fallback,
  );
}

export function createDeterministicTextEmbedding(text: string, dimensions = embeddingDimensions): TextEmbedding {
  const values = new Array<number>(dimensions).fill(0);
  const normalized = normalizeEmbeddingText(text);
  const features = extractEmbeddingFeatures(normalized);

  for (const feature of features) {
    const bucket = hashFeature(feature) % dimensions;
    const sign = hashFeature(`sign:${feature}`) % 2 === 0 ? 1 : -1;
    values[bucket] += sign;
  }

  return normalizeEmbedding({ dimensions, values });
}

export function formatPgVector(embedding: TextEmbedding): string {
  return `[${embedding.values.join(",")}]`;
}

export function projectEmbedding(embedding: TextEmbedding, dimensions = embeddingDimensions): TextEmbedding {
  if (embedding.dimensions === dimensions && embedding.values.length === dimensions) {
    return normalizeEmbedding(embedding);
  }

  const values = new Array<number>(dimensions).fill(0);
  embedding.values.forEach((value, index) => {
    const bucket = hashFeature(`dimension:${index}`) % dimensions;
    const sign = hashFeature(`dimension-sign:${index}`) % 2 === 0 ? 1 : -1;
    values[bucket] += value * sign;
  });

  return normalizeEmbedding({ dimensions, values });
}

export function memoryEmbeddingText(input: {
  title: string;
  tags: string[];
  summary: string;
  reusableProcedure: string;
  evidence?: string[];
}): string {
  return [
    input.title,
    input.tags.join(" "),
    input.summary,
    input.reusableProcedure,
    ...(input.evidence ?? []),
  ].join("\n");
}

function normalizeEmbeddingText(text: string): string {
  return text.toLowerCase().normalize("NFKC");
}

function normalizeEmbedding(embedding: TextEmbedding): TextEmbedding {
  const values = embedding.values.slice(0, embedding.dimensions);
  while (values.length < embedding.dimensions) values.push(0);

  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return {
    dimensions: embedding.dimensions,
    values: magnitude > 0 ? values.map((value) => Number((value / magnitude).toFixed(6))) : values,
  };
}

function extractEmbeddingFeatures(text: string): string[] {
  const tokens = text
    .split(/[^a-zа-яё0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  const features = [...tokens];

  for (const token of tokens) {
    for (let index = 0; index <= token.length - 3; index += 1) {
      features.push(token.slice(index, index + 3));
    }
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    features.push(`${tokens[index]}_${tokens[index + 1]}`);
  }

  return features;
}

function hashFeature(feature: string): number {
  let hash = 2166136261;
  for (let index = 0; index < feature.length; index += 1) {
    hash ^= feature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseEmbeddingResponse(rawBody: string): EmbeddingResponse {
  if (!rawBody.trim()) return {};

  try {
    return JSON.parse(rawBody) as EmbeddingResponse;
  } catch {
    return {};
  }
}

function extractEmbeddingError(data: EmbeddingResponse, status: number, rawBody: string): string {
  const fallback = rawBody.trim() ? `HTTP ${status}: ${rawBody.slice(0, 500)}` : `HTTP ${status}`;
  const error = data.error;

  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    if (typeof record.type === "string") return `${record.type}: ${fallback}`;
  }

  return fallback;
}

function parseEmbeddingDimensions(value: string | undefined): number {
  const parsed = Number(value ?? embeddingDimensions);
  if (!Number.isInteger(parsed) || parsed < 8 || parsed > 4096) return embeddingDimensions;
  return parsed;
}
