export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ModelInfo {
  /** Model id without the "models/" prefix, e.g. "gemini-2.5-flash". */
  id: string;
  supportedGenerationMethods: string[];
}

const LIST_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=300';

/** Returns the first available id matching the earliest preference (preferences are ordered). */
export function pickModel(available: string[], preferences: RegExp[]): string | undefined {
  for (const pattern of preferences) {
    const hit = available.find((id) => pattern.test(id));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** All available ids ordered by the preference list (earliest pattern first, list order within a pattern), deduplicated. */
export function pickModels(available: string[], preferences: RegExp[]): string[] {
  const out: string[] = [];
  for (const pattern of preferences) {
    for (const id of available) if (pattern.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Lists Gemini models for an API key via the ListModels endpoint. */
export async function listModels(fetchFn: FetchFn, key: string): Promise<ModelInfo[]> {
  const res = await fetchFn(LIST_MODELS_URL, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error(`ListModels failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };
  return (body.models ?? []).map((m) => ({
    id: m.name.replace(/^models\//, ''),
    supportedGenerationMethods: m.supportedGenerationMethods ?? [],
  }));
}
