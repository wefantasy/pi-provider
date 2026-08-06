/**
 * Multi-select component test — drives the custom TUI component logic with a
 * mocked ui.custom / theme / tui, no terminal needed.
 * Run: node test/multiselect.test.mjs
 */
import { searchableMultiSelect } from "../extensions/lib/multi-select.ts";

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

/** Real runtime delivers one keypress per handleInput call. */
function type(comp, text) {
	for (const ch of text) comp.handleInput(ch);
}

function makeHarness() {
	let component;
	let resolveResult;
	const resultPromise = new Promise((resolve) => (resolveResult = resolve));
	const ui = {
		custom: async (factory) => {
			const theme = {
				fg: (_c, s) => s,
				bold: (s) => s,
			};
			component = factory({ requestRender() {} }, theme, {}, (value) =>
				resolveResult(value),
			);
			return resultPromise;
		},
	};
	return {
		ui,
		run: () => resultPromise,
		get comp() {
			return component;
		},
	};
}

const options = Array.from({ length: 25 }, (_, i) => ({
	value: `provider/model-${i < 10 ? "0" : ""}${i}`,
	...(i % 3 === 0 ? { description: `Model number ${i}` } : {}),
}));

// 0. width guard: every rendered line must fit the render width (the TUI crashes otherwise)
{
	const h0 = makeHarness();
	const p0 = searchableMultiSelect(h0.ui, "Pick models", options, {
		height: 8,
	});
	const comp0 = h0.comp;
	const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
	for (const width of [100, 80, 40, 20]) {
		type(comp0, "model-"); // with active search query
		let lines0 = comp0.render(width);
		let bad = lines0.filter((l) => visible(l) > width);
		assert(
			bad.length === 0,
			`width guard (search): no line exceeds ${width} (${bad.length} bad)`,
		);
		comp0.handleInput(KEY.escape); // back to list
		lines0 = comp0.render(width);
		bad = lines0.filter((l) => visible(l) > width);
		assert(
			bad.length === 0,
			`width guard (list): no line exceeds ${width} (${bad.length} bad)`,
		);
	}
	comp0.handleInput(KEY.escape); // close dialog
	comp0.handleInput(KEY.escape);
	await p0;
}

const h = makeHarness();
const p = searchableMultiSelect(h.ui, "Pick models", options, { height: 8 });
const comp = h.comp;

// 1. render: fixed height + footer rows
const lines = comp.render(80);
const optionRows = lines.filter((l) => l.includes("☐") || l.includes("☑"));
assert(
	optionRows.length === 8,
	`fixed height 8 option rows (got ${optionRows.length})`,
);
assert(
	lines.some((l) => l.includes("Finish")),
	"finish row present",
);
assert(
	lines.some((l) => l.includes("Add custom model")),
	"add-custom row present",
);
assert(
	lines.some((l) => l.includes("25 models")),
	"count in title",
);

// 2. typing filters (fuzzy)
type(comp, "model-17");
const filteredLines = comp.render(80);
const shown = filteredLines.filter((l) => l.includes("☐") || l.includes("☑"));
assert(
	shown.length === 1 && /model-17/.test(shown[0] ?? ""),
	`search narrows to exactly one match (got ${shown.length})`,
);
assert(shown.length <= 8, "filtered list still fixed height");

// 3. toggle selection: enter on first filtered item, then finish
// (query "model-17" is still active from test 2; reset it first)
comp.handleInput(KEY.escape); // clear query → back to full list
type(comp, "model-0");
comp.handleInput(KEY.down); // into the filtered list
comp.handleInput(KEY.enter); // toggle first
comp.handleInput(KEY.enter); // toggle second (enter moves down)
comp.handleInput(KEY.ctrlS); // finish
const result = await p;
assert(result !== null, "finish resolves");
assert(result.selected.includes("provider/model-00"), "first toggled selected");
assert(
	result.selected.includes("provider/model-01"),
	"second toggled selected",
);
assert(
	result.selected.length === 2,
	`exactly 2 selected (got ${result.selected.length})`,
);
console.log("  · selected:", result.selected.join(", "));

// 4. ctrl+a select all filtered + custom add
const h2 = makeHarness();
const p2 = searchableMultiSelect(h2.ui, "Pick models", options, { height: 8 });
const comp2 = h2.comp;
type(comp2, "zzz"); // no matches
comp2.handleInput(KEY.ctrlA); // select all filtered (none)
comp2.handleInput(KEY.escape); // escape in search mode clears query, back to list
comp2.handleInput(KEY.escape); // second escape cancels dialog
const result2 = await p2;
assert(result2 === null, "double-escape cancels");

// 5. add custom model via the add row
const h3 = makeHarness();
const p3 = searchableMultiSelect(h3.ui, "Pick models", options, { height: 8 });
const comp3 = h3.comp;
// navigate to "+ Add custom model id" row: 25 options → rows 0..24, add = 25
const optCount = 25; // no filter
for (let i = 0; i < optCount; i++) comp3.handleInput(KEY.down); // cursor 25 = add row
comp3.handleInput(KEY.enter); // enter add mode
type(comp3, "my/custom-model"); // type (add mode routes to Input)
comp3.handleInput(KEY.enter); // submit add
comp3.handleInput(KEY.ctrlS); // finish
const result3 = await p3;
assert(result3 !== null, "add-flow finishes");
assert(
	result3.custom.includes("my/custom-model"),
	`custom id recorded (${result3.custom.join(",")})`,
);
assert(result3.selected.includes("my/custom-model"), "custom id auto-selected");

// 6. ↓ from search jumps straight into the filtered list
const h4 = makeHarness();
const p4 = searchableMultiSelect(h4.ui, "Pick models", options, { height: 8 });
const comp4 = h4.comp;
type(comp4, "model-0"); // search mode
comp4.handleInput(KEY.down); // exit search → list, cursor on first match
comp4.handleInput(KEY.enter); // toggle first match
comp4.handleInput(KEY.ctrlS); // finish
const result4 = await p4;
assert(
	result4 !== null && result4.selected.includes("provider/model-00"),
	"down from search enters list and first item is selectable",
);

// 7. continuing typing in list mode appends to the query
const h5 = makeHarness();
const p5 = searchableMultiSelect(h5.ui, "Pick models", options, { height: 8 });
const comp5 = h5.comp;
type(comp5, "model"); // search "model"
comp5.handleInput(KEY.down); // back to list, query kept
type(comp5, "-0"); // keeps typing → query "model-0"
comp5.handleInput(KEY.down); // into list
comp5.handleInput(KEY.space); // toggle first match
comp5.handleInput(KEY.ctrlS); // finish
const result5 = await p5;
assert(
	result5.selected.includes("provider/model-00"),
	"typing in list mode appends to the active query",
);

// 8. esc in list mode with a query clears it instead of cancelling
const h6 = makeHarness();
const p6 = searchableMultiSelect(h6.ui, "Pick models", options, { height: 8 });
const comp6 = h6.comp;
type(comp6, "zzz"); // search, no matches
comp6.handleInput(KEY.escape); // clear query → back to full list
const lines6 = comp6.render(80);
assert(
	lines6.some((l) => l.includes("provider/model-00")),
	"esc with active query clears it, dialog stays open",
);
comp6.handleInput(KEY.escape); // now cancel
const result6 = await p6;
assert(result6 === null, "second esc cancels the dialog");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
