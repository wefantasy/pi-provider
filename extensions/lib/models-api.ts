/**
 * Model list + metadata fetching and conversion to pi models.json config.
 *
 * - `fetchProviderModels` tries the provider's own `/models` endpoint first
 *   (OpenAI-compatible, Anthropic Messages and Google Generative AI shapes).
 * - `fetchOpenRouterCatalog` is the fallback "common models" list from
 *   https://openrouter.ai/api/v1/models (cached in memory for the session).
 * - `toPiModelConfig` converts one OpenRouter metadata entry into a pi
 *   `models.json` model entry per https://pi.dev/docs/latest/models.
 */

import type { PiModelConfig } from "./store.ts";

export interface ModelOption {
	value: string;
	description?: string;
}

export interface OpenRouterModel {
	id: string;
	name?: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: Record<string, string | number | undefined>;
	top_provider?: {
		max_completion_tokens?: number;
		context_length?: number;
	};
	supported_parameters?: string[];
	reasoning?: {
		mandatory?: boolean;
		default_enabled?: boolean;
		supported_efforts?: string[];
	};
}

const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;

let catalogCache: { at: number; data: OpenRouterModel[] } | undefined;
const CATALOG_TTL_MS = 10 * 60 * 1000;

function timeoutSignal() {
	return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

/** Crude resolution of `$VAR` / `${VAR}` / literal apiKey values for the list fetch. */
export function resolveKeyForFetch(
	apiKey: string | undefined,
): string | undefined {
	if (!apiKey) return undefined;
	const envMatch = apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
	if (envMatch) {
		return process.env[envMatch[1]] ?? undefined;
	}
	// `!command` keys are resolved by pi at request time; we cannot run arbitrary
	// commands here, so treat them as unknown → the provider list fetch just
	// goes out without auth (and falls back to the OpenRouter catalog on failure).
	if (apiKey.startsWith("!")) return undefined;
	return apiKey;
}

/**
 * Try to list models from the provider's own endpoint.
 * Returns `{ ok: false, error }` on any failure so callers can fall back.
 */
export async function fetchProviderModels(
	baseUrl: string,
	api: string,
	apiKey: string | undefined,
): Promise<{ ok: true; models: ModelOption[] } | { ok: false; error: string }> {
	try {
		const base = baseUrl.trim().replace(/\/+$/, "");
		if (!base) return { ok: false, error: "Empty base URL" };

		let url: string;
		const headers: Record<string, string> = {};
		const key = resolveKeyForFetch(apiKey);

		if (api === "anthropic-messages") {
			url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
			if (key) {
				headers["x-api-key"] = key;
				headers["anthropic-version"] = "2023-06-01";
			}
		} else if (api === "google-generative-ai") {
			url = `${base}/models`;
			if (key) headers["x-goog-api-key"] = key;
		} else {
			// openai-completions / openai-responses and anything else
			url = `${base}/models`;
			if (key) headers["Authorization"] = `Bearer ${key}`;
		}

		const res = await fetch(url, { headers, signal: timeoutSignal() });
		if (!res.ok) {
			return {
				ok: false,
				error: `HTTP ${res.status} ${res.statusText}`.trim(),
			};
		}
		const json = (await res.json()) as unknown;

		const models: ModelOption[] = [];
		if (json && typeof json === "object") {
			const anyJson = json as Record<string, unknown>;
			if (Array.isArray(anyJson.data)) {
				for (const entry of anyJson.data as Array<Record<string, unknown>>) {
					if (typeof entry?.id !== "string" || !entry.id) continue;
					const name = entry.name ?? entry.display_name ?? entry.displayName;
					models.push({
						value: entry.id,
						...(typeof name === "string" && name ? { description: name } : {}),
					});
				}
			} else if (Array.isArray(anyJson.models)) {
				// Google Generative AI shape: { models: [{ name: "models/gemini-…", displayName }] }
				for (const entry of anyJson.models as Array<Record<string, unknown>>) {
					if (typeof entry?.name !== "string" || !entry.name) continue;
					const id = entry.name.replace(/^models\//, "");
					const name = entry.displayName ?? entry.display_name;
					models.push({
						value: id,
						...(typeof name === "string" && name ? { description: name } : {}),
					});
				}
			}
		}

		if (models.length === 0) {
			return { ok: false, error: "The provider returned no models" };
		}
		models.sort((a, b) => a.value.localeCompare(b.value));
		return { ok: true, models };
	} catch (err) {
		let message: string;
		if (err instanceof Error && err.name === "TimeoutError") {
			message = "timed out";
		} else if (err instanceof Error) {
			message = err.message;
		} else {
			message = String(err);
		}
		return { ok: false, error: message };
	}
}

/** Fetch (and cache) the OpenRouter model catalog. Throws on failure. */
export async function fetchOpenRouterCatalog(): Promise<OpenRouterModel[]> {
	const now = Date.now();
	if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) {
		return catalogCache.data;
	}
	const res = await fetch(OPENROUTER_CATALOG_URL, { signal: timeoutSignal() });
	if (!res.ok) {
		throw new Error(`OpenRouter catalog returned HTTP ${res.status}`);
	}
	const json = (await res.json()) as { data?: unknown };
	if (!Array.isArray(json.data)) {
		throw new Error("OpenRouter catalog returned an unexpected shape");
	}
	const data = (json.data as OpenRouterModel[]).filter(
		(m) => typeof m?.id === "string" && m.id,
	);
	catalogCache = { at: now, data };
	return data;
}

/** Catalog entries as selectable options for the model picker. */
export function catalogToOptions(data: OpenRouterModel[]): ModelOption[] {
	return data.map((m) => ({
		value: m.id,
		...(m.name && m.name !== m.id ? { description: m.name } : {}),
	}));
}

/**
 * Fetch metadata for the given model ids (one catalog request, filtered).
 * Returns a Map of id → metadata; ids without an entry are absent.
 */
export async function fetchOpenRouterMetadata(
	ids: string[],
): Promise<Map<string, OpenRouterModel>> {
	const catalog = await fetchOpenRouterCatalog();
	const wanted = new Set(ids);
	const map = new Map<string, OpenRouterModel>();
	for (const m of catalog) {
		// OpenRouter ids are namespaced ("provider/model"), while ids from a
		// provider's own /models list or manual entry are usually bare
		// ("model"). Satisfy whichever form was requested: the exact id and/or
		// the namespace-stripped model name (first hit wins).
		const slash = m.id.lastIndexOf("/");
		const base = slash >= 0 ? m.id.slice(slash + 1) : m.id;
		for (const key of base === m.id ? [m.id] : [m.id, base]) {
			if (wanted.has(key) && !map.has(key)) map.set(key, m);
		}
	}
	return map;
}

/** Round to at most 6 significant decimals to avoid float noise. */
function round6(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.round(n * 1e6) / 1e6;
}

/** OpenRouter pricing is USD per token → pi wants USD per 1M tokens. */
function perTokenToPerMillion(value: string | number | undefined): number {
	if (value === undefined || value === null || value === "") return 0;
	const n =
		typeof value === "number" ? value : Number.parseFloat(String(value));
	if (!Number.isFinite(n)) return 0;
	return round6(n * 1_000_000);
}

const PI_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/**
 * Convert one OpenRouter metadata entry into a pi models.json model config.
 * When `meta` is undefined (no metadata match) a basic `{ id }` entry is
 * returned — every other field keeps its pi default.
 */
export function toPiModelConfig(
	meta: OpenRouterModel | undefined,
	id: string,
): PiModelConfig {
	if (!meta) {
		return { id };
	}

	const config: PiModelConfig = { id };

	if (meta.name && meta.name !== id) {
		config.name = meta.name;
	}

	// Input modalities → pi `input: ["text"] | ["text", "image"]`.
	const modalities = meta.architecture?.input_modalities ?? [];
	const input: string[] = [];
	if (modalities.includes("text")) input.push("text");
	if (modalities.includes("image")) input.push("image");
	if (input.length === 0) input.push("text");
	config.input = input;

	const contextWindow =
		meta.context_length ?? meta.top_provider?.context_length;
	if (typeof contextWindow === "number" && contextWindow > 0) {
		config.contextWindow = contextWindow;
	}

	const maxTokens = meta.top_provider?.max_completion_tokens;
	if (typeof maxTokens === "number" && maxTokens > 0) {
		config.maxTokens = maxTokens;
	}

	// Cost (per 1M tokens).
	const pricing = meta.pricing ?? {};
	const cost: Record<string, number> = {
		input: perTokenToPerMillion(pricing.prompt),
		output: perTokenToPerMillion(pricing.completion),
		cacheRead: perTokenToPerMillion(pricing.input_cache_read),
		cacheWrite: perTokenToPerMillion(pricing.input_cache_write),
	};
	if (Object.values(cost).some((v) => v > 0)) {
		config.cost = cost;
	}

	// Reasoning + thinking level map.
	const reasoning =
		meta.reasoning ??
		(meta.supported_parameters?.includes("reasoning")
			? { default_enabled: true }
			: undefined);
	if (reasoning && (reasoning.mandatory || reasoning.default_enabled)) {
		config.reasoning = true;
		const supported = reasoning.supported_efforts;
		if (Array.isArray(supported) && supported.length > 0) {
			const map: Record<string, string | null> = {};
			for (const level of PI_THINKING_LEVELS) {
				if (level === "off") {
					if (reasoning.mandatory) map.off = null;
					continue;
				}
				map[level] = supported.includes(level) ? level : null;
			}
			// Only emit the map when it actually constrains something.
			if (Object.keys(map).length > 0) {
				config.thinkingLevelMap = map;
			}
		} else if (reasoning.mandatory) {
			config.thinkingLevelMap = { off: null };
		}
	}

	return config;
}
