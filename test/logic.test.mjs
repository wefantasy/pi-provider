/**
 * Logic test harness — exercises store.ts and models-api.ts without the TUI.
 * Run: node test/logic.test.mjs
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import {
	readModelsDoc,
	writeModelsDoc,
	updateModelsDoc,
	getModelsPath,
	StoreError,
} from "../extensions/lib/store.ts";
import {
	toPiModelConfig,
	fetchOpenRouterCatalog,
	fetchOpenRouterMetadata,
	fetchProviderModels,
	resolveKeyForFetch,
	catalogToOptions,
} from "../extensions/lib/models-api.ts";

let failures = 0;
function assert(cond, label) {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.error(`  ✗ ${label}`);
	}
}

// ---- store ---------------------------------------------------------------
console.log("store:");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		// missing file → empty doc
		let doc = readModelsDoc();
		assert(
			doc.providers !== undefined && Object.keys(doc.providers).length === 0,
			"missing file → empty doc",
		);
		assert(
			getModelsPath() === join(dir, "models.json"),
			"path honors PI_CODING_AGENT_DIR",
		);

		// write + read round trip, unknown top-level keys preserved
		writeModelsDoc({
			providers: {
				test: {
					baseUrl: "https://x.test/v1",
					api: "openai-completions",
					models: [{ id: "m1" }],
				},
			},
			customTopLevel: { kept: true },
		});
		doc = readModelsDoc();
		assert(doc.providers.test.models[0].id === "m1", "round trip");
		assert(
			doc.customTopLevel?.kept === true,
			"unknown top-level key preserved",
		);

		// update merge
		updateModelsDoc((d) => {
			d.providers.test.models.push({ id: "m2" });
			d.providers.other = {
				baseUrl: "https://y.test",
				api: "anthropic-messages",
				models: [],
			};
		});
		doc = readModelsDoc();
		assert(doc.providers.test.models.length === 2, "merge append");
		assert(doc.providers.other !== undefined, "merge add provider");

		// atomic write: no stray tmp files
		const leftovers = readdirSafe(dir).filter(
			(f) => f.includes(".tmp-") && !f.endsWith(".failed"),
		);
		assert(leftovers.length === 0, "no leftover tmp files");

		// invalid JSON → StoreError
		writeFileSync(getModelsPath(), "{ not json", "utf8");
		try {
			readModelsDoc();
			assert(false, "invalid JSON throws StoreError");
		} catch (err) {
			assert(err instanceof StoreError, "invalid JSON throws StoreError");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	}
}

// ---- apiKey resolution ----------------------------------------------------
console.log("resolveKeyForFetch:");
{
	assert(resolveKeyForFetch("$FOO_BAR") === undefined, "unset env → undefined");
	process.env.TEST_PI_KEY = "abc123";
	assert(resolveKeyForFetch("$TEST_PI_KEY") === "abc123", "$VAR resolution");
	assert(
		resolveKeyForFetch("${TEST_PI_KEY}") === "abc123",
		"${VAR} resolution",
	);
	assert(resolveKeyForFetch("!op read x") === undefined, "!cmd not executed");
	assert(
		resolveKeyForFetch("sk-literal") === "sk-literal",
		"literal passthrough",
	);
	delete process.env.TEST_PI_KEY;
}

// ---- conversion -----------------------------------------------------------
console.log("toPiModelConfig:");
{
	const meta = {
		id: "qwen/qwen3.8-max",
		name: "Qwen: Qwen3.8 Max",
		context_length: 1_000_000,
		architecture: {
			input_modalities: ["text", "image", "video"],
			output_modalities: ["text"],
		},
		pricing: {
			prompt: "0.000002",
			completion: "0.000006",
			input_cache_read: "0.00000025",
			input_cache_write: "0.0000025",
		},
		top_provider: { context_length: 1_000_000, max_completion_tokens: 131072 },
		supported_parameters: [
			"reasoning",
			"reasoning_effort",
			"tools",
			"temperature",
		],
		reasoning: {
			mandatory: true,
			default_enabled: true,
			supported_efforts: ["xhigh", "high", "medium", "low", "minimal"],
		},
	};
	const cfg = toPiModelConfig(meta, meta.id);
	assert(cfg.id === "qwen/qwen3.8-max", "id");
	assert(cfg.name === "Qwen: Qwen3.8 Max", "name");
	assert(
		JSON.stringify(cfg.input) === JSON.stringify(["text", "image"]),
		"input maps text+image (video dropped)",
	);
	assert(cfg.contextWindow === 1_000_000, "contextWindow");
	assert(cfg.maxTokens === 131072, "maxTokens");
	assert(
		cfg.cost?.input === 2 && cfg.cost?.output === 6,
		"cost per-token → per-1M",
	);
	assert(
		cfg.cost?.cacheRead === 0.25 && cfg.cost?.cacheWrite === 2.5,
		"cache cost",
	);
	assert(cfg.reasoning === true, "reasoning");
	assert(
		cfg.thinkingLevelMap?.xhigh === "xhigh" &&
			cfg.thinkingLevelMap?.max === null,
		"thinkingLevelMap efforts",
	);
	assert(cfg.thinkingLevelMap?.off === null, "mandatory thinking → off null");

	const gemini = toPiModelConfig(
		{
			id: "google/gemini-2.5-pro",
			context_length: 1_048_576,
			architecture: { input_modalities: ["text", "image"] },
			pricing: {
				prompt: "0.00000125",
				completion: "0.00001",
				input_cache_read: "0.000000125",
				input_cache_write: "0.000000375",
			},
			top_provider: { max_completion_tokens: 65536 },
		},
		"google/gemini-2.5-pro",
	);
	assert(
		gemini.cost?.input === 1.25 && gemini.cost?.output === 10,
		"gemini cost",
	);
	assert(gemini.reasoning === undefined, "no reasoning → not set");

	// unmatched → basic config only
	const basic = toPiModelConfig(undefined, "mystery/model");
	assert(
		JSON.stringify(basic) === JSON.stringify({ id: "mystery/model" }),
		"unmatched → { id } only",
	);
}

// ---- openrouter catalog ----------------------------------------------------
console.log("openrouter:");
{
	try {
		const catalog = await fetchOpenRouterCatalog();
		assert(
			Array.isArray(catalog) && catalog.length > 100,
			`catalog fetched (${catalog.length} models)`,
		);
		const opts = catalogToOptions(catalog);
		assert(
			opts.some((o) => o.value === "anthropic/claude-sonnet-4"),
			"catalog contains known model",
		);
		assert(
			opts.every((o) => typeof o.value === "string"),
			"options well-formed",
		);

		const meta = await fetchOpenRouterMetadata([
			"anthropic/claude-sonnet-4",
			"not-a-real-model-xyz",
			"claude-sonnet-4", // bare id → should match anthropic/claude-sonnet-4 via namespace strip
		]);
		assert(meta.has("anthropic/claude-sonnet-4"), "metadata matched");
		assert(!meta.has("not-a-real-model-xyz"), "unknown id absent");
		assert(meta.has("claude-sonnet-4"), "bare id matched via namespace strip");
	} catch (err) {
		failures++;
		console.error("  ✗ openrouter fetch failed:", err.message);
	}
}

// ---- provider model fetch (openai-compatible endpoint) ---------------------
console.log("fetchProviderModels:");
{
	try {
		// public OpenAI-compatible endpoint
		const res = await fetchProviderModels(
			"https://api.deepseek.com",
			"openai-completions",
			"sk-test-invalid",
		);
		// deepseek requires auth → expect failure (that's the fallback path) OR a valid list; both acceptable
		console.log(
			`  · deepseek w/o valid key → ${res.ok ? `ok (${res.models.length})` : `failed (${"error" in res ? res.error : "?"})`}`,
		);
	} catch (err) {
		console.error("  ✗ unexpected throw:", err.message);
		failures++;
	}
	{
		const res = await fetchProviderModels(
			"https://api.openai.com/v1",
			"openai-completions",
			"sk-invalid",
		);
		if (res.ok) assert(res.models.length > 0, "openai list");
		else
			assert(
				!res.ok && "error" in res,
				`openai w/ bad key fails gracefully (${res.error})`,
			);
	}
	{
		const res = await fetchProviderModels("", "openai-completions", undefined);
		assert(!res.ok, "empty baseUrl → failure");
	}
}

// ---- cleanup ----------------------------------------------------------------
function readdirSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
