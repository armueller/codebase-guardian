import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getAllEmbeddings, insertEmbedding, getEmbedding } from './db.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EmbeddingInput {
  functionId: number;
  name: string;
  description: string;
  domains: string[];
  systemlayers: string[];
  tags: string[];
  body: string;
}

export interface SemanticResult {
  functionId: number;
  similarity: number;
}

// ─── Embedding Pipeline (Lazy-Loaded) ────────────────────────────────────────

let pipeline: any = null;

async function getPipeline(): Promise<any> {
  if (pipeline) return pipeline;

  // Dynamic import to avoid loading at module level
  const { pipeline: createPipeline } = await import('@huggingface/transformers');
  pipeline = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'fp32',
  });

  return pipeline;
}

async function embed(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

// ─── Input Hash ──────────────────────────────────────────────────────────────

function computeInputHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ─── Signature Text ──────────────────────────────────────────────────────────

function buildSignatureText(input: EmbeddingInput): string {
  let text = `${input.name}: ${input.description}`;

  if (input.domains.length > 0) {
    text += `. Domains: ${input.domains.join(', ')}`;
  }
  if (input.systemlayers.length > 0) {
    text += `. System layers: ${input.systemlayers.join(', ')}`;
  }
  if (input.tags.length > 0) {
    text += `. Tags: ${input.tags.join(', ')}`;
  }

  return text;
}

// ─── Generate Embeddings ─────────────────────────────────────────────────────

export async function generateEmbeddings(
  db: Database.Database,
  input: EmbeddingInput
): Promise<{ signatureGenerated: boolean; bodyGenerated: boolean }> {
  let signatureGenerated = false;
  let bodyGenerated = false;

  // Signature embedding
  const signatureText = buildSignatureText(input);
  const signatureHash = computeInputHash(signatureText);

  const existingSignature = getEmbedding(db, input.functionId, 'signature');
  if (!existingSignature || existingSignature.input_hash !== signatureHash) {
    const signatureEmbedding = await embed(signatureText);
    insertEmbedding(db, input.functionId, 'signature', signatureEmbedding, signatureHash);
    signatureGenerated = true;
  }

  // Body embedding (first 1000 chars of function body)
  if (input.body && input.body.trim().length > 0) {
    const bodyText = input.body.slice(0, 1000);
    const bodyHash = computeInputHash(bodyText);

    const existingBody = getEmbedding(db, input.functionId, 'body');
    if (!existingBody || existingBody.input_hash !== bodyHash) {
      const bodyEmbedding = await embed(bodyText);
      insertEmbedding(db, input.functionId, 'body', bodyEmbedding, bodyHash);
      bodyGenerated = true;
    }
  }

  return { signatureGenerated, bodyGenerated };
}

// ─── Semantic Search ─────────────────────────────────────────────────────────

// In-memory cache for brute-force search
let embeddingCache: Map<number, Float32Array> | null = null;

export function invalidateCache(): void {
  embeddingCache = null;
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export async function semanticSearch(
  db: Database.Database,
  query: string,
  limit: number
): Promise<SemanticResult[]> {
  // Load all signature embeddings into cache if not already loaded
  if (!embeddingCache) {
    embeddingCache = getAllEmbeddings(db, 'signature');
  }

  if (embeddingCache.size === 0) return [];

  // Embed the query
  const queryEmbedding = await embed(query);

  // Brute-force cosine similarity (vectors are L2-normalized, so dot product = cosine similarity)
  const results: SemanticResult[] = [];
  for (const [functionId, funcEmbedding] of embeddingCache) {
    const similarity = dotProduct(queryEmbedding, funcEmbedding);
    results.push({ functionId, similarity });
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, limit);
}
