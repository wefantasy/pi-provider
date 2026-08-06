/**
 * Interactive wizards: add / delete / modify custom providers in models.json.
 *
 * Add flow (step-by-step):
 *   1. provider name   → 2. api type   → 3. baseUrl   → 4. apiKey (optional)
 *   → 5. headers (optional) → 6. model multi-select (provider list first,
 *   OpenRouter catalog as fallback) → 7. OpenRouter metadata → pi config
 *   → 8. confirm & merge into models.json
 *
 * Delete flow: pick a provider, confirm, remove.
 * Modify flow: provider-level fields, per-model fields, rename, raw JSON.
 */

import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiModelConfig, PiProviderConfig } from "./store.ts";
import {
	getModelsPath,
	readModelsDoc,
	StoreError,
	updateModelsDoc,
} from "./store.ts";
import {
	catalogToOptions,
	fetchOpenRouterCatalog,
	fetchOpenRouterMetadata,
	fetchProviderModels,
	toPiModelConfig,
	type ModelOption,
} from "./models-api.ts";
import { searchableMultiSelect } from "./multi-select.ts";

const API_TYPES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

const API_DEFAULTS: Record<string, string> = {
	"openai-completions": "https://api.openai.com/v1",
	"openai-responses": "https://api.openai.com/v1",
	"anthropic-messages": "https://api.anthropic.com",
	"google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

// ---------------------------------------------------------------------------
// small UI helpers
// ---------------------------------------------------------------------------

/** Run an async op behind a BorderedLoader. Resolves `null` when user aborts. */
async function withLoader<T>(
	ctx: ExtensionContext,
	message: string,
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
	if (ctx.mode !== "tui") {
		return fn(new AbortController().signal);
	}
	return ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, message);
		loader.onAbort = () => done(null);
		Promise.resolve()
			.then(() => fn(loader.signal))
			.then((value) => done(value))
			.catch((err) => {
				console.error("[pi-provider]", err);
				done(null);
			});
		return loader;
	});
}

function notifyError(ctx: ExtensionContext, err: unknown) {
	ctx.ui.notify(
		err instanceof StoreError || err instanceof Error
			? err.message
			: String(err),
		"error",
	);
}

function maskKey(key: string | undefined): string {
	if (!key) return "none";
	if (key.startsWith("$") || key.startsWith("!")) return key;
	if (key.length <= 8) return "••••";
	return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// step helpers
// ---------------------------------------------------------------------------

type ApiKeyResult =
	| { kind: "set"; value: string }
	| { kind: "keep" }
	| { kind: "none" }
	| undefined;

/**
 * API key input with pi's value-resolution formats:
 * - `$ENV_VAR` environment interpolation
 * - `!command` shell command
 * - literal value
 */
async function promptApiKey(
	ctx: ExtensionContext,
	current: string | undefined,
): Promise<ApiKeyResult> {
	const options: string[] = [];
	if (current !== undefined) options.push(`Keep current (${maskKey(current)})`);
	options.push("Literal value");
	options.push("Shell command (!cmd)");
	options.push("Environment variable ($VAR)");
	options.push("None — auth via /login or --api-key");

	const choice = await ctx.ui.select("API key", options);
	if (!choice) return undefined;
	if (choice.startsWith("Keep current")) return { kind: "keep" };
	if (choice.startsWith("None")) return { kind: "none" };

	let value: string | undefined;
	if (choice.startsWith("Environment")) {
		const v = await ctx.ui.input("Environment variable name", "MY_API_KEY");
		if (!v) return undefined;
		value = `$${v.trim().replace(/^\$/, "")}`;
	} else if (choice.startsWith("Shell command")) {
		const v = await ctx.ui.input(
			"Shell command",
			"!op read 'op://vault/item/credential'",
		);
		if (!v) return undefined;
		value = v.trim().startsWith("!") ? v.trim() : `!${v.trim()}`;
	} else {
		const v = await ctx.ui.input("API key (literal)", "sk-…");
		if (!v) return undefined;
		value = v.trim();
	}
	if (!value) return undefined;
	return { kind: "set", value };
}

/** Parse "name=value, name2=value2" into a headers object (values may be $ENV / !cmd). */
function parseHeaders(str: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const part of str.split(",")) {
		const eq = part.indexOf("=");
		const name = (eq >= 0 ? part.slice(0, eq) : part).trim();
		const value = eq >= 0 ? part.slice(eq + 1).trim() : "";
		if (name) headers[name] = value;
	}
	return headers;
}

function formatHeaders(headers: Record<string, string> | undefined): string {
	if (!headers) return "";
	return Object.entries(headers)
		.map(([k, v]) => `${k}=${v}`)
		.join(", ");
}

async function promptHeaders(
	ctx: ExtensionContext,
	current?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const has = current && Object.keys(current).length > 0;
	const action = await ctx.ui.select("Custom headers", [
		"Skip",
		...(has ? ["Edit headers"] : []),
		...(has ? ["Clear headers"] : []),
		"Add headers",
	]);
	if (!action) return undefined;
	if (action === "Skip") return current ?? {};
	if (action === "Clear headers") return {};
	if (action === "Edit headers" || action === "Add headers") {
		const input = await ctx.ui.input(
			"Headers (name=value, name2=value2)",
			has ? formatHeaders(current) : "",
		);
		if (input === undefined) return undefined;
		return parseHeaders(input);
	}
	return undefined;
}

/**
 * The model-selection step shared by add + modify:
 * 1. try the provider's own model list;
 * 2. on failure, load the OpenRouter catalog and present it fixed-height;
 * 3. multi-select + add unlisted ids;
 * 4. fetch OpenRouter metadata for the chosen ids and convert to pi config.
 */
async function selectModelsStep(
	ctx: ExtensionContext,
	provider: { baseUrl: string; api: string; apiKey?: string },
	existing: Map<string, PiModelConfig>,
): Promise<PiModelConfig[] | null> {
	// 1. provider's own list (preferred)
	const fetched = await withLoader(
		ctx,
		`Fetching model list from ${provider.baseUrl}/models …`,
		() => fetchProviderModels(provider.baseUrl, provider.api, provider.apiKey),
	);

	let options: ModelOption[];
	let sourceLabel: string;

	if (fetched && fetched.ok) {
		options = fetched.models;
		sourceLabel = `from provider (${options.length} models)`;
	} else {
		const reason = fetched?.error ?? "cancelled";
		const catalog = await withLoader(
			ctx,
			"Provider list unavailable — loading OpenRouter catalog …",
			() => fetchOpenRouterCatalog(),
		);
		if (!catalog) return null;
		options = catalogToOptions(catalog);
		sourceLabel = `OpenRouter catalog (provider list failed: ${reason})`;
	}

	const result = await searchableMultiSelect(
		ctx.ui,
		`Select models — ${sourceLabel}`,
		options,
		{
			preselected: existing.keys(),
		},
	);
	if (!result) return null;

	const ids = [...new Set([...result.selected, ...result.custom])];
	if (ids.length === 0) {
		const ok = await ctx.ui.confirm(
			"No models selected",
			"Add the provider without any models?",
		);
		if (!ok) return null;
	}

	// 2. OpenRouter metadata → pi config
	const metadata = await withLoader(
		ctx,
		"Fetching model metadata from OpenRouter …",
		() => fetchOpenRouterMetadata(ids),
	);
	if (!metadata) return null;

	const configs: PiModelConfig[] = ids.map((id) => {
		const meta = metadata.get(id);
		if (meta) return toPiModelConfig(meta, id);
		// unmatched metadata → basic config (or keep an existing richer config)
		const existingConfig = existing.get(id);
		return existingConfig ?? { id };
	});

	return configs;
}

// ---------------------------------------------------------------------------
// main menu + add / delete / modify
// ---------------------------------------------------------------------------

export async function runProviderManager(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Provider manager requires an interactive session", "error");
		return;
	}
	for (;;) {
		const action = await ctx.ui.select("Provider management", [
			"＋ Add provider",
			"✗  Delete provider",
			"✡  Modify provider",
		]);
		if (!action) return;
		if (action.startsWith("＋")) await addProviderFlow(ctx);
		else if (action.startsWith("✗")) await deleteProviderFlow(ctx);
		else await modifyProviderFlow(ctx);
	}
}

export async function addProviderFlow(ctx: ExtensionContext): Promise<void> {
	let doc;
	try {
		doc = readModelsDoc();
	} catch (err) {
		notifyError(ctx, err);
		return;
	}

	// 1. provider name
	const nameInput = await ctx.ui.input("Provider name (id)", "");
	if (!nameInput) return;
	const name = nameInput.trim();
	if (!name) {
		ctx.ui.notify("Provider name is required", "error");
		return;
	}
	if (doc.providers[name]) {
		const overwrite = await ctx.ui.confirm(
			"Provider exists",
			`"${name}" already exists in ${getModelsPath()}. Overwrite it?`,
		);
		if (!overwrite) return;
	}

	// 2. api type
	const api = await ctx.ui.select("API type", [...API_TYPES]);
	if (!api) return;

	// 3. baseUrl
	const baseUrlInput = await ctx.ui.input("Base URL", API_DEFAULTS[api] ?? "");
	if (baseUrlInput === undefined) return;
	const baseUrl = baseUrlInput.trim();
	if (!baseUrl) {
		ctx.ui.notify("Base URL is required", "error");
		return;
	}

	// 4. apiKey
	const keyResult = await promptApiKey(ctx, undefined);
	if (!keyResult) return;
	const apiKey = keyResult.kind === "set" ? keyResult.value : undefined;

	// 5. headers (optional)
	const headers = await promptHeaders(ctx, undefined);
	if (headers === undefined) return;

	// 6. models
	const models = await selectModelsStep(
		ctx,
		{ baseUrl, api, apiKey },
		new Map(),
	);
	if (!models) return;

	// 7. confirm & write
	const modelSummary =
		models.length > 0
			? models.map((m) => `  ${m.id}`).join("\n")
			: "  (no models)";
	const ok = await ctx.ui.confirm(
		"Add provider",
		`Provider: ${name}\nAPI: ${api}\nBase URL: ${baseUrl}\nAPI key: ${maskKey(apiKey)}\n\nModels:\n${modelSummary}\n\nWrite to ${getModelsPath()}?`,
	);
	if (!ok) return;

	try {
		updateModelsDoc((d) => {
			const providerConfig: PiProviderConfig = { baseUrl, api };
			if (apiKey) providerConfig.apiKey = apiKey;
			if (headers && Object.keys(headers).length > 0)
				providerConfig.headers = headers;
			providerConfig.models = models;
			d.providers[name] = providerConfig;
		});
		ctx.ui.notify(
			`✓ Provider "${name}" added with ${models.length} model(s). Run /model to load it.`,
			"info",
		);
	} catch (err) {
		notifyError(ctx, err);
	}
}

export async function deleteProviderFlow(ctx: ExtensionContext): Promise<void> {
	let doc;
	try {
		doc = readModelsDoc();
	} catch (err) {
		notifyError(ctx, err);
		return;
	}
	const names = Object.keys(doc.providers);
	if (names.length === 0) {
		ctx.ui.notify("No custom providers in models.json", "info");
		return;
	}
	const choice = await ctx.ui.select("Delete provider", [...names]);
	if (!choice) return;

	const provider = doc.providers[choice];
	const modelCount = Array.isArray(provider.models)
		? provider.models.length
		: 0;
	const ok = await ctx.ui.confirm(
		"Delete provider",
		`Delete provider "${choice}" (${modelCount} model${modelCount === 1 ? "" : "s"}) from ${getModelsPath()}?\n\nThis cannot be undone.`,
	);
	if (!ok) return;

	try {
		updateModelsDoc((d) => {
			delete d.providers[choice];
		});
		ctx.ui.notify(`✓ Provider "${choice}" deleted.`, "info");
	} catch (err) {
		notifyError(ctx, err);
	}
}

export async function modifyProviderFlow(ctx: ExtensionContext): Promise<void> {
	let doc;
	try {
		doc = readModelsDoc();
	} catch (err) {
		notifyError(ctx, err);
		return;
	}
	const names = Object.keys(doc.providers);
	if (names.length === 0) {
		ctx.ui.notify("No custom providers in models.json", "info");
		return;
	}

	const name = await ctx.ui.select("Modify provider", [...names]);
	if (!name) return;

	for (;;) {
		const target = await ctx.ui.select(`Modify "${name}"`, [
			"Provider settings",
			"Models",
			"Rename provider",
			"Edit raw JSON",
			"← Back",
		]);
		if (!target || target === "← Back") return;

		if (target === "Rename provider") {
			await renameProvider(ctx, name);
			return;
		}
		if (target === "Edit raw JSON") {
			const saved = await editRawJson(
				ctx,
				`Provider "${name}" (JSON)`,
				doc.providers[name],
				(parsed) => {
					updateModelsDoc((d) => {
						d.providers[name] = parsed as PiProviderConfig;
					});
				},
			);
			if (saved) return;
			continue;
		}
		if (target === "Provider settings") {
			await editProviderSettings(ctx, name);
			continue;
		}
		if (target === "Models") {
			await editProviderModels(ctx, name);
		}
	}
}

async function renameProvider(
	ctx: ExtensionContext,
	name: string,
): Promise<void> {
	const newName = await ctx.ui.input("New provider name (id)", name);
	if (!newName) return;
	const trimmed = newName.trim();
	if (!trimmed || trimmed === name) return;
	try {
		const doc = readModelsDoc();
		if (doc.providers[trimmed]) {
			ctx.ui.notify(`Provider "${trimmed}" already exists`, "error");
			return;
		}
		updateModelsDoc((d) => {
			d.providers[trimmed] = d.providers[name];
			delete d.providers[name];
		});
		ctx.ui.notify(`✓ Provider renamed to "${trimmed}".`, "info");
	} catch (err) {
		notifyError(ctx, err);
	}
}

async function editProviderSettings(
	ctx: ExtensionContext,
	name: string,
): Promise<void> {
	for (;;) {
		let provider;
		try {
			provider = readModelsDoc().providers[name];
		} catch (err) {
			notifyError(ctx, err);
			return;
		}
		const field = await ctx.ui.select(`Provider settings — ${name}`, [
			`baseUrl (${provider.baseUrl ?? "unset"})`,
			`api (${provider.api ?? "unset"})`,
			`apiKey (${maskKey(provider.apiKey)})`,
			`headers (${provider.headers && Object.keys(provider.headers).length > 0 ? Object.keys(provider.headers).length + " header(s)" : "none"})`,
			`authHeader (${provider.authHeader ? "on" : "off"})`,
			"← Back",
		]);
		if (!field || field === "← Back") return;

		try {
			if (field.startsWith("baseUrl")) {
				const value = await ctx.ui.input("Base URL", provider.baseUrl ?? "");
				if (value === undefined) continue;
				const trimmed = value.trim();
				if (!trimmed) {
					ctx.ui.notify("Base URL is required", "error");
					continue;
				}
				updateModelsDoc((d) => {
					d.providers[name].baseUrl = trimmed;
				});
			} else if (field.startsWith("api (")) {
				const value = await ctx.ui.select("API type", [...API_TYPES]);
				if (!value) continue;
				updateModelsDoc((d) => {
					d.providers[name].api = value;
				});
			} else if (field.startsWith("apiKey")) {
				const result = await promptApiKey(ctx, provider.apiKey);
				if (!result) continue;
				if (result.kind === "set" || result.kind === "none") {
					updateModelsDoc((d) => {
						if (result.kind === "none") delete d.providers[name].apiKey;
						else d.providers[name].apiKey = result.value;
					});
				}
			} else if (field.startsWith("headers")) {
				const headers = await promptHeaders(ctx, provider.headers);
				if (headers === undefined) continue;
				updateModelsDoc((d) => {
					if (Object.keys(headers).length > 0)
						d.providers[name].headers = headers;
					else delete d.providers[name].headers;
				});
			} else if (field.startsWith("authHeader")) {
				const value = await ctx.ui.confirm(
					"authHeader",
					`Send Authorization: Bearer <apiKey> automatically for "${name}"?`,
				);
				updateModelsDoc((d) => {
					if (value) d.providers[name].authHeader = true;
					else delete d.providers[name].authHeader;
				});
			}
			ctx.ui.notify(
				`✓ Provider "${name}" updated. Run /model to reload.`,
				"info",
			);
		} catch (err) {
			notifyError(ctx, err);
		}
	}
}

async function editProviderModels(
	ctx: ExtensionContext,
	name: string,
): Promise<void> {
	for (;;) {
		let provider;
		let models: PiModelConfig[];
		try {
			provider = readModelsDoc().providers[name];
			models = Array.isArray(provider.models) ? provider.models : [];
		} catch (err) {
			notifyError(ctx, err);
			return;
		}

		const choice = await ctx.ui.select(`Models — ${name}`, [
			...models.map((m) => m.id),
			"＋ Add / refresh models…",
			"← Back",
		]);
		if (!choice || choice === "← Back") return;
		if (choice === "＋ Add / refresh models…") {
			const configs = await selectModelsStep(
				ctx,
				{
					baseUrl: provider.baseUrl ?? "",
					api: provider.api ?? "openai-completions",
					apiKey: provider.apiKey,
				},
				new Map(models.map((m) => [m.id, m])),
			);
			if (!configs) continue;
			if (configs.length === 0) continue;
			try {
				updateModelsDoc((d) => {
					const existing = new Map(
						(Array.isArray(d.providers[name].models)
							? d.providers[name].models
							: []
						).map((m) => [m.id, m]),
					);
					for (const cfg of configs) existing.set(cfg.id, cfg);
					d.providers[name].models = [...existing.values()];
				});
				ctx.ui.notify(
					`✓ Models updated for "${name}". Run /model to reload.`,
					"info",
				);
			} catch (err) {
				notifyError(ctx, err);
			}
			continue;
		}

		const model = models.find((m) => m.id === choice);
		if (!model) continue;
		const removed = await editModel(ctx, name, model);
		if (removed) {
			try {
				updateModelsDoc((d) => {
					const list = Array.isArray(d.providers[name].models)
						? d.providers[name].models
						: [];
					d.providers[name].models = list.filter((m) => m.id !== model.id);
				});
				ctx.ui.notify(`✓ Model "${model.id}" deleted.`, "info");
			} catch (err) {
				notifyError(ctx, err);
			}
		}
	}
}

/** Edit one model's fields in place (mutates `model`). Returns true if the model should be deleted. */
async function editModel(
	ctx: ExtensionContext,
	providerName: string,
	model: PiModelConfig,
): Promise<boolean> {
	for (;;) {
		const field = await ctx.ui.select(`Model — ${model.id}`, [
			`name (${typeof model.name === "string" ? model.name : "= id"})`,
			`api (${typeof model.api === "string" ? model.api : "provider default"})`,
			`reasoning (${model.reasoning ? "on" : "off"})`,
			`input (${Array.isArray(model.input) ? (model.input as string[]).join("+") : "text"})`,
			`contextWindow (${typeof model.contextWindow === "number" ? model.contextWindow : "default 128000"})`,
			`maxTokens (${typeof model.maxTokens === "number" ? model.maxTokens : "default 16384"})`,
			`cost (${costSummary(model)})`,
			`thinkingLevelMap`,
			`compat`,
			"Edit raw JSON",
			"✗  Delete model",
			"← Back",
		]);
		if (!field || field === "← Back") return false;

		if (field === "✗  Delete model") {
			return ctx.ui.confirm(
				"Delete model",
				`Delete model "${model.id}" from "${providerName}"?`,
			);
		}
		if (field === "Edit raw JSON") {
			const saved = await editRawJson(
				ctx,
				`Model "${model.id}" (JSON)`,
				model,
				(parsed) => {
					updateModelsDoc((d) => {
						const list = Array.isArray(d.providers[providerName].models)
							? d.providers[providerName].models
							: [];
						const parsedId =
							typeof parsed.id === "string" ? parsed.id : model.id;
						const idx = list.findIndex(
							(m) => m.id === model.id || m.id === parsedId,
						);
						if (idx >= 0) list[idx] = parsed as PiModelConfig;
						else list.push(parsed as PiModelConfig);
						d.providers[providerName].models = list;
					});
				},
			);
			if (saved) return false;
			continue;
		}

		// name
		if (field.startsWith("name (")) {
			const value = await ctx.ui.input(
				"Model name (empty = use id)",
				typeof model.name === "string" ? model.name : "",
			);
			if (value === undefined) continue;
			const trimmed = value.trim();
			if (trimmed) model.name = trimmed;
			else delete model.name;
		}
		// api
		else if (field.startsWith("api (")) {
			const value = await ctx.ui.select("Model API", [
				"provider default",
				...API_TYPES,
			]);
			if (!value) continue;
			if (value === "provider default") delete model.api;
			else model.api = value;
		}
		// reasoning
		else if (field.startsWith("reasoning")) {
			const value = await ctx.ui.confirm(
				"Reasoning",
				"Enable reasoning (extended thinking) for this model?",
			);
			if (value) model.reasoning = true;
			else delete model.reasoning;
		}
		// input
		else if (field.startsWith("input (")) {
			const value = await ctx.ui.select("Input types", [
				"text",
				"text + image",
			]);
			if (!value) continue;
			model.input = value === "text" ? ["text"] : ["text", "image"];
		}
		// contextWindow
		else if (field.startsWith("contextWindow")) {
			const value = await ctx.ui.input(
				"Context window (tokens, empty = default)",
				typeof model.contextWindow === "number"
					? String(model.contextWindow)
					: "",
			);
			if (value === undefined) continue;
			const num = parsePositiveInt(value);
			if (num === undefined && value.trim() !== "") {
				ctx.ui.notify("Must be a positive integer", "error");
				continue;
			}
			if (num === undefined) delete model.contextWindow;
			else model.contextWindow = num;
		}
		// maxTokens
		else if (field.startsWith("maxTokens")) {
			const value = await ctx.ui.input(
				"Max output tokens (empty = default)",
				typeof model.maxTokens === "number" ? String(model.maxTokens) : "",
			);
			if (value === undefined) continue;
			const num = parsePositiveInt(value);
			if (num === undefined && value.trim() !== "") {
				ctx.ui.notify("Must be a positive integer", "error");
				continue;
			}
			if (num === undefined) delete model.maxTokens;
			else model.maxTokens = num;
		}
		// cost
		else if (field.startsWith("cost")) {
			const current =
				model.cost && typeof model.cost === "object"
					? (["input", "output", "cacheRead", "cacheWrite"] as const)
							.map((k) => (model.cost as Record<string, unknown>)[k] ?? "0")
							.join(",")
					: "";
			const value = await ctx.ui.input(
				"Cost per 1M tokens: input,output,cacheRead,cacheWrite",
				current,
			);
			if (value === undefined) continue;
			if (value.trim() === "") {
				delete model.cost;
				continue;
			}
			const parts = value.split(",").map((s) => Number.parseFloat(s.trim()));
			if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
				ctx.ui.notify(
					"Enter exactly 4 numbers: input,output,cacheRead,cacheWrite",
					"error",
				);
				continue;
			}
			model.cost = {
				input: parts[0],
				output: parts[1],
				cacheRead: parts[2],
				cacheWrite: parts[3],
			};
		}
		// thinkingLevelMap / compat — JSON editors
		else if (
			field.startsWith("thinkingLevelMap") ||
			field.startsWith("compat")
		) {
			const key = field.startsWith("thinkingLevelMap")
				? "thinkingLevelMap"
				: "compat";
			const currentVal = model[key];
			const currentStr =
				typeof currentVal === "object"
					? JSON.stringify(currentVal, null, 2)
					: "";
			const value = await ctx.ui.editor(
				`Edit ${key} (JSON, empty = remove)`,
				currentStr,
			);
			if (value === undefined) continue;
			if (value.trim() === "") {
				delete model[key];
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch (err) {
				ctx.ui.notify(
					`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				continue;
			}
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				ctx.ui.notify(`${key} must be a JSON object`, "error");
				continue;
			}
			model[key] = parsed;
		}

		// persist
		try {
			updateModelsDoc((d) => {
				const list = Array.isArray(d.providers[providerName].models)
					? d.providers[providerName].models
					: [];
				const idx = list.findIndex((m) => m.id === model.id);
				if (idx >= 0) list[idx] = model;
				else list.push(model);
				d.providers[providerName].models = list;
			});
			ctx.ui.notify(
				`✓ Model "${model.id}" updated. Run /model to reload.`,
				"info",
			);
		} catch (err) {
			notifyError(ctx, err);
		}
	}
}

function costSummary(model: PiModelConfig): string {
	const c = model.cost;
	if (!c || typeof c !== "object") return "all zero";
	const o = c as Record<string, unknown>;
	return `${o.input ?? 0}/${o.output ?? 0}/${o.cacheRead ?? 0}/${o.cacheWrite ?? 0}`;
}

function parsePositiveInt(s: string): number | undefined {
	const n = Number.parseInt(s.trim(), 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Edit a provider or model value as raw JSON. On success, runs `apply(parsed)`
 * (the caller writes the new value into models.json) and returns true.
 */
async function editRawJson(
	ctx: ExtensionContext,
	title: string,
	value: unknown,
	apply: (parsed: Record<string, unknown>) => void,
): Promise<boolean> {
	const prefill = JSON.stringify(value, null, 2);
	const text = await ctx.ui.editor(title, prefill);
	if (text === undefined) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		ctx.ui.notify(
			`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		return false;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		ctx.ui.notify("Must be a JSON object", "error");
		return false;
	}
	try {
		apply(parsed as Record<string, unknown>);
		ctx.ui.notify("✓ Saved. Run /model to reload.", "info");
		return true;
	} catch (err) {
		notifyError(ctx, err);
		return false;
	}
}
