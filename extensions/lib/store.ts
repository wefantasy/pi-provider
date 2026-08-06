/**
 * models.json store — reads, validates and atomically writes `~/.pi/agent/models.json`.
 *
 * The file layout follows https://pi.dev/docs/latest/models:
 *
 *   {
 *     "providers": {
 *       "<providerId>": {
 *         "baseUrl": "...",
 *         "api": "openai-completions",
 *         "apiKey": "...",
 *         "models": [{ "id": "...", ... }]
 *       }
 *     }
 *   }
 *
 * Unknown top-level keys and unknown provider keys are preserved on write so
 * hand-edited content (comments are not valid JSON, but future fields are) is
 * never destroyed.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A single model entry inside a provider's `models` array. */
export interface PiModelConfig {
	id: string;
	[key: string]: unknown;
}

/** A custom provider entry from models.json. */
export interface PiProviderConfig {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	models?: PiModelConfig[];
	modelOverrides?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}

/** Top-level models.json document. */
export interface ModelsDoc {
	providers: Record<string, PiProviderConfig>;
	[key: string]: unknown;
}

/** Resolve the models.json path honouring PI_CODING_AGENT_DIR (default ~/.pi/agent). */
export function getModelsPath(): string {
	const dir =
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(dir, "models.json");
}

/** Resolve the directory that contains models.json. */
export function getModelsDir(): string {
	return dirname(getModelsPath());
}

/** Errors thrown by the store carry a user-facing message. */
export class StoreError extends Error {}

/**
 * Read and parse models.json.
 * - Missing file → empty document `{ providers: {} }`.
 * - Unreadable/invalid file → throws StoreError with a readable message.
 */
export function readModelsDoc(): ModelsDoc {
	const path = getModelsPath();
	if (!existsSync(path)) {
		return { providers: {} };
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		throw new StoreError(
			`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	// Strip a UTF-8 BOM if present.
	if (raw.charCodeAt(0) === 0xfeff) {
		raw = raw.slice(1);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new StoreError(
			`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
				`Fix or remove the file and try again.`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new StoreError(
			`${path} must contain a JSON object at the top level.`,
		);
	}
	const doc = parsed as Record<string, unknown>;
	if (doc.providers === undefined) {
		doc.providers = {};
	} else if (
		typeof doc.providers !== "object" ||
		doc.providers === null ||
		Array.isArray(doc.providers)
	) {
		throw new StoreError(
			`${path} has a "providers" field that is not an object.`,
		);
	}
	return doc as unknown as ModelsDoc;
}

/**
 * Write models.json atomically (tmp file + rename) so a crash mid-write never
 * leaves a truncated file that pi can no longer parse.
 */
export function writeModelsDoc(doc: ModelsDoc): void {
	const path = getModelsPath();
	const dir = getModelsDir();
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		throw new StoreError(
			`Cannot create ${dir}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
		renameSync(tmp, path);
	} catch (err) {
		try {
			// best-effort cleanup of the temp file
			existsSync(tmp) && renameSync(tmp, `${tmp}.failed`);
		} catch {
			/* ignore */
		}
		throw new StoreError(
			`Cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Convenience: read the doc, run `mutate`, write back, and return the mutated
 * doc. Throws StoreError on read/write failure.
 */
export function updateModelsDoc(
	mutate: (doc: ModelsDoc) => void | ModelsDoc,
): ModelsDoc {
	const doc = readModelsDoc();
	const result = mutate(doc);
	writeModelsDoc(result ?? doc);
	return result ?? doc;
}
