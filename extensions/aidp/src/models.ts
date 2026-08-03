/**
 * Model list configuration for the AIDP gateway provider.
 *
 * The gateway is an internal service: the set of available models changes
 * without notice and has no public docs. Instead of hardcoding one model,
 * the provider registers every id listed in the `AIDP_MODELS` env var
 * (comma-separated), falling back to the default below.
 */

/** Default model when AIDP_MODELS is unset. */
export const DEFAULT_MODEL_ID = "gpt-5.6-sol";

/**
 * Parse the AIDP_MODELS env value (comma-separated model ids) into a list.
 * Whitespace is trimmed; empty values fall back to the default model.
 */
export function parseModelIds(envValue: string | undefined): string[] {
  const ids = (envValue ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : [DEFAULT_MODEL_ID];
}

/**
 * Extract model ids from the `providers.aidp.models` section of a raw
 * models.json file. Returns undefined when absent or invalid, in which case
 * the extension falls back to the AIDP_MODELS env var.
 */
export function parseJsonModelIds(raw: string): string[] | undefined {
  try {
    const json = JSON.parse(raw) as {
      providers?: { aidp?: { models?: Array<{ id?: string }> } };
    };
    const models = json?.providers?.aidp?.models;
    if (!Array.isArray(models) || models.length === 0) {
      return undefined;
    }
    const ids = models
      .map((m) => m.id?.trim())
      .filter((id): id is string => Boolean(id));
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Human-readable display name for a model id: `gpt-5.6-sol` → `GPT-5.6 Sol`.
 * Numeric segments keep their hyphen (`5.6`), letter segments are spaced.
 */
export function modelDisplayName(id: string): string {
  const words = id.split("-").map((part) =>
    part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1),
  );
  // Re-join numeric segments to the previous word: gpt-5.6-sol → GPT-5.6 Sol
  const out: string[] = [];
  for (const word of words) {
    if (out.length > 0 && /^\d/.test(word)) {
      out[out.length - 1] += `-${word}`;
    } else {
      out.push(word);
    }
  }
  return out.join(" ");
}
