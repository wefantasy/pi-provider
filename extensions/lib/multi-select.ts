/**
 * Searchable, multi-select model picker rendered as a custom TUI component.
 *
 * Features (per requirements):
 * - fixed-height option list with internal scrolling
 * - fuzzy search-as-you-type
 * - multi-select with checkboxes (space/enter toggles)
 * - "add unlisted model id" entry
 *
 * Rendered layout (fixed option area height, footer rows always visible):
 *
 *   ┌ Title ─────────────────────────────────────────┐
 *   │ 🔍 search: deepseek                  3/12     │
 *   │                                              │
 *   │  ☑ deepseek/deepseek-v4   DeepSeek: V4 …     │
 *   │  ☐ …                                        │
 *   │  (1/12)                                     │
 *   │  ─────────────────────────────              │
 *   │  ＋ Add custom model id                     │
 *   │  ✓ Finish (3 selected)                      │
 *   │  ↑↓ navigate · space toggle · type search … │
 *   └──────────────────────────────────────────────┘
 */

import {
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ModelOption } from "./models-api.ts";

export interface MultiSelectResult {
	/** ids selected from the presented list */
	selected: string[];
	/** ids typed in by the user that were not in the list */
	custom: string[];
}

export interface MultiSelectOptions {
	/** Number of option rows visible at once (fixed height). Default 10. */
	height?: number;
	/** Ids initially checked. */
	preselected?: Iterable<string>;
	/** Disable the "add custom model id" row. Default false. */
	allowCustom?: boolean;
}

const CHECKED = "☑";
const UNCHECKED = "☐";

/**
 * Open a custom searchable multi-select dialog. Resolves to `null` on cancel.
 */
export function searchableMultiSelect(
	ui: ExtensionUIContext,
	title: string,
	options: ModelOption[],
	opts: MultiSelectOptions = {},
): Promise<MultiSelectResult | null> {
	const height = opts.height ?? 10;
	const allowCustom = opts.allowCustom !== false;
	const preselected = new Set(opts.preselected ?? []);

	return ui.custom<MultiSelectResult | null>((tui, theme, _kb, done) => {
		// ---- state ---------------------------------------------------------
		const selected = new Set<string>(preselected);
		const customIds: string[] = [];
		let query = "";
		let mode: "list" | "search" | "add" = "list";
		let cursor = 0; // index into `visibleRows` (options + footer rows)

		const searchInput = new Input();
		searchInput.onSubmit = () => {
			mode = "list";
			cursor = 0;
		};
		searchInput.onEscape = () => {
			if (query) {
				query = "";
				searchInput.setValue("");
			}
			mode = "list";
			cursor = 0;
		};

		const addInput = new Input();
		addInput.onSubmit = () => {
			const id = addInput.getValue().trim();
			if (id) {
				if (options.some((o) => o.value === id)) {
					selected.add(id);
				} else if (!customIds.includes(id)) {
					customIds.push(id);
					selected.add(id);
				}
			}
			addInput.setValue("");
			mode = "list";
			cursor = 0;
		};
		addInput.onEscape = () => {
			addInput.setValue("");
			mode = "list";
			cursor = 0;
		};

		// ---- derived -------------------------------------------------------
		function filteredOptions(): ModelOption[] {
			if (!query.trim()) return options;
			return fuzzyFilter(
				options,
				query.trim(),
				(o) => `${o.value} ${o.description ?? ""}`,
			);
		}

		/** Rows the cursor can land on: options + "+ Add" + "✓ Finish". */
		function visibleRows(): Array<
			| { kind: "option"; option: ModelOption }
			| { kind: "add" }
			| { kind: "finish" }
		> {
			const rows: Array<
				| { kind: "option"; option: ModelOption }
				| { kind: "add" }
				| { kind: "finish" }
			> = filteredOptions().map((option) => ({ kind: "option", option }));
			if (allowCustom) rows.push({ kind: "add" });
			rows.push({ kind: "finish" });
			return rows;
		}

		function clampCursor() {
			const rows = visibleRows();
			if (rows.length === 0) {
				cursor = 0;
				return;
			}
			cursor = Math.max(0, Math.min(cursor, rows.length - 1));
		}

		function toggle(option: ModelOption) {
			if (selected.has(option.value)) {
				selected.delete(option.value);
			} else {
				selected.add(option.value);
			}
		}

		function refresh() {
			clampCursor();
			tui.requestRender();
		}

		// ---- input ----------------------------------------------------------
		function setQuery(value: string) {
			query = value;
			searchInput.setValue(value);
		}

		function handleInput(data: string) {
			if (mode === "search") {
				// ↓/↑ leave search (keeping the query) and jump straight into the
				// filtered list so the user can pick without pressing Enter first.
				if (matchesKey(data, Key.down)) {
					mode = "list";
					cursor = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.up)) {
					mode = "list";
					cursor = Math.max(0, filteredOptions().length - 1);
					refresh();
					return;
				}
				searchInput.handleInput(data);
				query = searchInput.getValue();
				cursor = 0;
				refresh();
				return;
			}
			if (mode === "add") {
				addInput.handleInput(data);
				refresh();
				return;
			}

			// list mode
			if (matchesKey(data, Key.up)) {
				cursor =
					(cursor - 1 + visibleRows().length) %
					Math.max(1, visibleRows().length);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = (cursor + 1) % Math.max(1, visibleRows().length);
				refresh();
				return;
			}
			if (matchesKey(data, Key.space)) {
				const row = visibleRows()[cursor];
				if (row?.kind === "option") toggle(row.option);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const row = visibleRows()[cursor];
				if (!row) return;
				if (row.kind === "option") {
					toggle(row.option);
					cursor = Math.min(cursor + 1, visibleRows().length - 1);
				} else if (row.kind === "add") {
					mode = "add";
				} else {
					finish();
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.ctrl("a"))) {
				for (const o of filteredOptions()) selected.add(o.value);
				refresh();
				return;
			}
			if (matchesKey(data, Key.ctrl("s"))) {
				finish();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				// First Esc clears an active search; a second one cancels.
				if (query) {
					setQuery("");
					cursor = 0;
					refresh();
					return;
				}
				done(null);
				return;
			}
			// Printable character continues the current search (or starts one).
			// We go through searchInput.handleInput() — never setValue() mid-typing,
			// because setValue leaves the Input cursor at 0 and subsequent chars
			// would be inserted before the first one ("odel-0m" instead of
			// "model-0"). The Input's own cursor advances correctly on insert.
			if (data.length === 1) {
				const code = data.charCodeAt(0);
				if (code >= 32 && code !== 127) {
					mode = "search";
					searchInput.handleInput(data);
					query = searchInput.getValue();
					cursor = 0;
					refresh();
				}
			}
		}

		function finish() {
			done({
				selected: [...selected],
				custom: [...customIds],
			});
		}

		// ---- render ----------------------------------------------------------
		function render(width: number): string[] {
			const lines: string[] = [];
			const w = Math.max(1, width);
			// Every emitted line must be truncated to the render width — pi's TUI
			// crashes on any line wider than the terminal.
			const trunc = (text: string, suffix = "") =>
				truncateToWidth(text, w, suffix);

			lines.push(trunc(theme.fg("accent", "─".repeat(w))));

			// Title + counts
			const totalCount = filteredOptions().length;
			const countLabel = `${selected.size} selected${customIds.length > 0 ? ` (+${customIds.length} custom)` : ""}`;
			const titleLine = `${theme.fg("accent", theme.bold(title))} ${theme.fg("dim", `(${totalCount} models · ${countLabel})`)}`;
			lines.push(trunc(titleLine, "…"));
			lines.push("");

			// Search / add line
			if (mode === "search") {
				lines.push(
					trunc(
						`${theme.fg("accent", "search:")} ${searchInput.render(Math.max(1, w - 10))[0] ?? ""}`,
					),
				);
			} else if (mode === "add") {
				lines.push(
					trunc(
						`${theme.fg("warning", "model id:")} ${addInput.render(Math.max(1, w - 10))[0] ?? ""}`,
					),
				);
			} else if (query) {
				lines.push(
					trunc(
						`${theme.fg("accent", "search:")} ${theme.fg("text", query)} ${theme.fg("dim", "(esc to clear)")}`,
					),
				);
			} else {
				lines.push(trunc(theme.fg("dim", "type to search models…")));
			}

			// Option rows (fixed height window)
			const opts = filteredOptions();
			// Option rows occupy indices [0, opts.length); scroll window around cursor.
			const windowStart = Math.max(
				0,
				Math.min(
					cursor - Math.floor(height / 2),
					Math.max(0, opts.length - height),
				),
			);
			const windowEnd = Math.min(opts.length, windowStart + height);

			for (let i = windowStart; i < windowEnd; i++) {
				const option = opts[i];
				if (!option) continue;
				const isCursor = cursor === i && mode === "list";
				const isChecked = selected.has(option.value);
				const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
				const box = theme.fg(
					isChecked ? "success" : "muted",
					isChecked ? CHECKED : UNCHECKED,
				);
				const idText = isCursor
					? theme.fg("accent", option.value)
					: theme.fg("text", option.value);
				let line = `${prefix}${box} ${idText}`;
				if (option.description) {
					const desc = theme.fg("dim", option.description);
					const used = visibleWidth(`${prefix}${box} ${option.value} `);
					const max = Math.max(12, w - used);
					line += ` ${truncateToWidth(desc, max, "…")}`;
				}
				lines.push(trunc(line, "…"));
			}
			if (opts.length === 0) {
				lines.push(trunc(theme.fg("warning", "  No matching models")));
			}
			if (opts.length > height) {
				lines.push(
					trunc(
						theme.fg(
							"dim",
							`  (${Math.min(cursor + 1, opts.length)}/${opts.length})`,
						),
					),
				);
			}

			// Footer rows
			lines.push(trunc(theme.fg("muted", "─".repeat(w))));
			if (allowCustom) {
				const isCursor = cursor === opts.length && mode === "list";
				lines.push(
					trunc(
						isCursor
							? `${theme.fg("accent", "> ")}${theme.fg("accent", theme.bold("＋ Add custom model id"))}`
							: `  ${theme.fg("text", "＋ Add custom model id")}`,
					),
				);
			}
			const finishCursor =
				cursor === opts.length + (allowCustom ? 1 : 0) && mode === "list";
			lines.push(
				trunc(
					finishCursor
						? `${theme.fg("accent", "> ")}${theme.fg("accent", theme.bold(`✓ Finish (${selected.size} selected)`))}`
						: `  ${theme.fg("success", `✓ Finish (${selected.size} selected)`)}`,
				),
			);
			lines.push("");
			lines.push(
				trunc(
					theme.fg(
						"dim",
						"↑↓ nav · space toggle · enter select · type to search · ctrl+a all · ctrl+s finish · esc clear/cancel",
					),
				),
			);

			lines.push(trunc(theme.fg("accent", "─".repeat(w))));
			return lines;
		}

		return {
			render,
			invalidate: () => {
				/* state-driven; nothing cached */
			},
			handleInput,
		};
	});
}
