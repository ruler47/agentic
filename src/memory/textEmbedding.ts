const embeddingDimensions = 128;

export type TextEmbedding = {
  dimensions: number;
  values: number[];
};

export function createDeterministicTextEmbedding(text: string, dimensions = embeddingDimensions): TextEmbedding {
  const values = new Array<number>(dimensions).fill(0);
  const normalized = normalizeEmbeddingText(text);
  const features = extractEmbeddingFeatures(normalized);

  for (const feature of features) {
    const bucket = hashFeature(feature) % dimensions;
    const sign = hashFeature(`sign:${feature}`) % 2 === 0 ? 1 : -1;
    values[bucket] += sign;
  }

  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return {
    dimensions,
    values: magnitude > 0 ? values.map((value) => Number((value / magnitude).toFixed(6))) : values,
  };
}

export function formatPgVector(embedding: TextEmbedding): string {
  return `[${embedding.values.join(",")}]`;
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
