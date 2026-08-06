/**
 * End-to-end wizard test — runs addProviderFlow / deleteProviderFlow /
 * modifyProviderFlow against a mocked ui and a temp PI_CODING_AGENT_DIR.
 * The model picker is auto-driven (ctrl+a select all, ctrl+s finish); loaders
 * run their fn and resolve. Requires network for the OpenRouter fallback.
 * Run: node test/wizard.test.mjs
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { readModelsDoc } from "../extensions/lib/store.ts";
import {
	addProviderFlow,
	deleteProviderFlow,
	modifyProviderFlow,
} from "../extensions/lib/wizard.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

let failures = 0;
function assert(cond, label) {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.error(`  ✗ ${label}`);
	}
}

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	space: " ",
	ctrlA: "\x01",
	ctrlS: "\x13",
};

const fakeTheme = { fg: (_c, s) => s, bold: (s) => s };
const fakeTui = { requestRender() {} };

/** Scripted ui. `script` is a queue of [method, value] pairs. */
function makeUi(script) {
	const queue = [...script];
	const log = [];
	const ui = {
		select: async (title) => {
			const next = queue.shift();
			if (next === undefined)
				throw new Error(`select called but script exhausted (${title})`);
			if (next[0] !== "select")
				throw new Error(`expected select for "${title}", got ${next[0]}`);
			log.push(`select:${title} → ${next[1]}`);
			return next[1];
		},
		input: async (title) => {
			const next = queue.shift();
			if (next === undefined)
				throw new Error(`input called but script exhausted (${title})`);
			if (next[0] !== "input")
				throw new Error(`expected input for "${title}", got ${next[0]}`);
			log.push(`input:${title} → ${next[1]}`);
			return next[1];
		},
		confirm: async (title) => {
			const next = queue.shift();
			if (next === undefined)
				throw new Error(`confirm called but script exhausted (${title})`);
			if (next[0] !== "confirm")
				throw new Error(`expected confirm for "${title}", got ${next[0]}`);
			log.push(`confirm:${title} → ${next[1]}`);
			return next[1];
		},
		editor: async (title) => {
			const next = queue.shift();
			if (next === undefined)
				throw new Error(`editor called but script exhausted (${title})`);
			if (next[0] !== "editor")
				throw new Error(`expected editor for "${title}", got ${next[0]}`);
			log.push(
				`editor:${title} → ${typeof next[1] === "string" ? "…" : next[1]}`,
			);
			return next[1];
		},
		notify: (msg) => log.push(`notify: ${msg}`),
		custom: async (factory) => {
			let resolveDone;
			const donePromise = new Promise((resolve) => (resolveDone = resolve));
			const comp = factory(fakeTui, fakeTheme, {}, resolveDone);
			if (comp && typeof comp.onAbort === "function") {
				// BorderedLoader — resolves when its fn completes
				return donePromise;
			}
			if (comp && typeof comp.handleInput === "function") {
				// searchableMultiSelect — select all filtered, then finish
				comp.handleInput(KEY.ctrlA);
				comp.handleInput(KEY.ctrlS);
				return donePromise;
			}
			throw new Error("unknown custom component");
		},
	};
	return { ui, log };
}

const ctx = { mode: "tui", hasUI: true, ui: null };

// ---------------------------------------------------------------------------
console.log("addProviderFlow (fallback path):");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-wiz-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const script = [
			["input", "myproxy"], // provider name
			["select", "openai-completions"], // api
			["input", "https://proxy.example.com/v1"], // baseUrl (fails to fetch → fallback)
			["select", "Environment variable ($VAR)"], // apiKey mode
			["input", "MY_PROXY_KEY"], // env name
			["select", "Skip"], // headers
			["confirm", true], // add provider confirm
		];
		const { ui } = makeUi(script);
		ctx.ui = ui;
		await addProviderFlow(ctx);

		const doc = readModelsDoc();
		const p = doc.providers.myproxy;
		assert(p !== undefined, "provider written");
		assert(p.baseUrl === "https://proxy.example.com/v1", "baseUrl");
		assert(p.api === "openai-completions", "api");
		assert(p.apiKey === "$MY_PROXY_KEY", "apiKey normalized to $VAR");
		assert(
			Array.isArray(p.models) && p.models.length > 0,
			`models fetched from fallback (${p.models?.length})`,
		);
		const anyRich = p.models.some(
			(m) => m.contextWindow !== undefined || m.cost !== undefined,
		);
		assert(anyRich, "some models got rich metadata config");
		console.log(`  · wrote ${p.models.length} models`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	}
}

// ---------------------------------------------------------------------------
console.log("addProviderFlow (provider list path, no network auth needed):");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-wiz-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const script = [
			["input", "openrouter"], // provider name
			["select", "openai-completions"], // api
			["input", "https://openrouter.ai/api/v1"], // baseUrl — this DOES return a model list
			["select", "None — auth via /login or --api-key"], // apiKey
			["select", "Skip"], // headers
			["confirm", true], // confirm
		];
		const { ui } = makeUi(script);
		ctx.ui = ui;
		await addProviderFlow(ctx);

		const doc = readModelsDoc();
		const p = doc.providers.openrouter;
		assert(
			p !== undefined && p.baseUrl === "https://openrouter.ai/api/v1",
			"provider written",
		);
		assert(p.apiKey === undefined, "no apiKey when None chosen");
		assert(p.models.length > 0, "models from provider list path");
		// openrouter api/v1/models exposes ids like anthropic/claude-sonnet-4 → metadata matched
		const matched = p.models.filter((m) => m.contextWindow !== undefined);
		assert(matched.length > 0, "metadata conversion applied");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	}
}

// ---------------------------------------------------------------------------
console.log("deleteProviderFlow:");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-wiz-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const { writeModelsDoc } = await import("../extensions/lib/store.ts");
		writeModelsDoc({
			providers: {
				alpha: {
					baseUrl: "https://a",
					api: "openai-completions",
					models: [{ id: "m1" }],
				},
				beta: { baseUrl: "https://b", api: "openai-completions", models: [] },
			},
		});
		const script = [
			["select", "alpha"], // pick provider
			["confirm", true], // confirm delete
		];
		const { ui } = makeUi(script);
		ctx.ui = ui;
		await deleteProviderFlow(ctx);
		const doc = readModelsDoc();
		assert(doc.providers.alpha === undefined, "alpha deleted");
		assert(doc.providers.beta !== undefined, "beta untouched");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	}
}

// ---------------------------------------------------------------------------
console.log("modifyProviderFlow (provider settings + model edit + rename):");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-wiz-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const { writeModelsDoc } = await import("../extensions/lib/store.ts");
		writeModelsDoc({
			providers: {
				gamma: {
					baseUrl: "https://g.test/v1",
					api: "openai-completions",
					apiKey: "sk-old",
					models: [
						{ id: "gpt-x", name: "GPT X", contextWindow: 128000 },
						{ id: "gpt-y" },
					],
				},
			},
		});
		const script = [
			// main modify menu
			["select", "gamma"],
			// target
			["select", "Provider settings"],
			// field → apiKey
			["select", "apiKey (sk-o••••old)"],
			// apiKey action → literal
			["select", "Literal value"],
			["input", "sk-new-key"],
			// back out
			["select", "← Back"],
			// target → Models
			["select", "Models"],
			// pick gpt-x
			["select", "gpt-x"],
			// field → contextWindow
			["select", "contextWindow (128000)"],
			["input", "256000"],
			// back out
			["select", "← Back"],
			["select", "← Back"],
			// target → Rename
			["select", "Rename provider"],
			["input", "gamma2"],
			// back out
			["select", "← Back"],
		];
		const { ui } = makeUi(script);
		ctx.ui = ui;
		await modifyProviderFlow(ctx);

		const doc = readModelsDoc();
		const p = doc.providers.gamma2;
		assert(
			p !== undefined && doc.providers.gamma === undefined,
			"provider renamed",
		);
		assert(p.apiKey === "sk-new-key", "apiKey updated");
		const m = p.models.find((x) => x.id === "gpt-x");
		assert(
			m !== undefined && m.contextWindow === 256000,
			"contextWindow updated",
		);
		assert(
			p.models.find((x) => x.id === "gpt-y") !== undefined,
			"other model untouched",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	}
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
