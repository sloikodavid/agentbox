import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

const require = createRequire(import.meta.url);
const PRETTIER_BIN = require.resolve("prettier/bin/prettier.cjs");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const ALLOWED_ARGS = new Set(["--check", "-c", "--write", "-w"]);
const write = args.has("--write") || args.has("-w");
const explicitCheck = args.has("--check") || args.has("-c");
const hasUnknownArg = process.argv
	.slice(2)
	.some((arg) => !ALLOWED_ARGS.has(arg));
const check = !write && (args.size === 0 || explicitCheck);
const LIST_OUTPUT_FILE = ".agents/skills/list/SKILL.md";
const IGNORE_PATH = [
	join(REPO_ROOT, ".gitignore"),
	join(REPO_ROOT, ".prettierignore"),
];

if (hasUnknownArg || (write && explicitCheck) || (!write && !check)) {
	console.error("Usage: node scripts/format.mjs [--check|--write]");
	process.exit(2);
}

const LLM_REPLACEMENTS = [
	[/\u2014/g, "-"],
	[/\u2013/g, "-"],
	[/\u2212/g, "-"],
	[/\u2192/g, "->"],
	[/\u2190/g, "<-"],
	[/\u21d2/g, "=>"],
	[/\u2026/g, "..."],
	[/[\u201c\u201d]/g, '"'],
	[/[\u2018\u2019]/g, "'"],
	[/\u2265/g, ">="],
	[/\u2264/g, "<="],
	[/\u2260/g, "!="],
	[/\u00d7/g, "x"],
	[/\u00a0/g, " "],
	[/\u202f/g, " "],
	[/\u2009/g, " "],
	[/\u200b/g, ""],
	[/\u200c/g, ""],
	[/\u200d/g, ""],
	[/\ufeff/g, ""],
];
const LIST_ITEM = /^(\s*(?:[-*+]|\d+\.)\s+)(.+)$/;
const TERMINAL_PUNCTUATION = /[.!?:;,)\]"']$/;

function toRelative(file) {
	return relative(REPO_ROOT, file).replaceAll("\\", "/");
}

function gitFiles() {
	const output = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: REPO_ROOT },
	);
	return output
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.filter(
			(path) => path !== LIST_OUTPUT_FILE && existsSync(join(REPO_ROOT, path)),
		);
}

function readTextFile(file) {
	const buffer = readFileSync(file);
	if (buffer.includes(0)) return undefined;
	return buffer.toString("utf8");
}

async function checkedFiles() {
	const files = [];
	for (const path of gitFiles()) {
		const file = join(REPO_ROOT, path);
		const info = await prettier.getFileInfo(file, { ignorePath: IGNORE_PATH });
		if (!info.ignored) files.push({ file, parser: info.inferredParser });
	}
	return files;
}

function renderList() {
	const root = {
		children: new Map(),
		name: basename(REPO_ROOT),
		type: "directory",
	};

	for (const path of [...gitFiles(), LIST_OUTPUT_FILE]) {
		const parts = path.split("/").filter(Boolean);
		let current = root;
		for (const [index, name] of parts.entries()) {
			const type = index === parts.length - 1 ? "file" : "directory";
			let next = current.children.get(name);
			if (!next) {
				next = { children: new Map(), name, type };
				current.children.set(name, next);
			}
			current = next;
		}
	}

	function renderNode(node, depth = 0) {
		const entries = [...node.children.values()].sort((left, right) => {
			if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
			return left.name.localeCompare(right.name, undefined, {
				sensitivity: "base",
			});
		});

		if (depth > 0 && entries.length > 40)
			return [`${"  ".repeat(depth)}... (${entries.length} items)`];

		return entries.flatMap((entry) => [
			`${"  ".repeat(depth)}${entry.name}${entry.type === "directory" ? "/" : ""}`,
			...(entry.type === "directory" ? renderNode(entry, depth + 1) : []),
		]);
	}

	return [
		"---",
		"name: list",
		"description: Use when you're not sure where to look, need to find the right file, or need to understand the project structure in a token-efficient list format. Saves the user time and money.",
		"---",
		"",
		"> Run `pnpm fix` to regenerate this file - do not edit manually.",
		"",
		"```text",
		...renderNode(root),
		"```",
		"",
	].join("\n");
}

function runList({ write }) {
	const file = join(REPO_ROOT, LIST_OUTPUT_FILE);
	const expected = renderList();
	const actual = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (actual === expected) return true;
	if (write) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, expected);
		return true;
	}
	console.error(`${LIST_OUTPUT_FILE} is out of date. Run 'pnpm fix'.`);
	return false;
}

function replaceLlmCharacters(content) {
	let output = content;
	for (const [from, to] of LLM_REPLACEMENTS) output = output.replace(from, to);
	return output;
}

function lineHasLlmCharacter(line) {
	return LLM_REPLACEMENTS.some(([pattern]) => {
		pattern.lastIndex = 0;
		return pattern.test(line);
	});
}

async function runLlmCharacters({ write }) {
	const violations = [];
	for (const { file } of await checkedFiles()) {
		const original = readTextFile(file);
		if (original === undefined) continue;
		const content = replaceLlmCharacters(original);
		if (content === original) continue;
		const hits = original
			.split("\n")
			.map((line, index) => ({ line, lineNo: index + 1 }))
			.filter(({ line }) => lineHasLlmCharacter(line))
			.map(({ line, lineNo }) => ({ lineNo, text: line.trim() }));
		violations.push({ content, file, hits });
	}

	if (violations.length === 0) return true;
	if (write) {
		for (const violation of violations)
			writeFileSync(violation.file, violation.content, "utf8");
		return true;
	}

	console.error("LLM-style characters found:");
	for (const { file, hits } of violations) {
		console.error(`\n  ${toRelative(file)}`);
		for (const hit of hits)
			console.error(`  ${String(hit.lineNo).padStart(4)}  ${hit.text}`);
	}
	return false;
}

function addListPeriods(content) {
	const hits = [];
	const fixed = content.split(/\r?\n/).map((line, index) => {
		const match = LIST_ITEM.exec(line);
		if (!match) return line;
		const [, prefix, text] = match;
		if (TERMINAL_PUNCTUATION.test(text)) return line;
		hits.push({ lineNo: index + 1, text: line.trim() });
		return `${prefix}${text}.`;
	});
	return { content: fixed.join("\n"), hits };
}

async function runListPeriods({ write }) {
	const violations = [];
	for (const { file, parser } of await checkedFiles()) {
		if (parser !== "markdown" && parser !== "mdx") continue;
		const original = readTextFile(file);
		if (original === undefined) continue;
		const result = addListPeriods(original);
		if (result.content !== original) violations.push({ ...result, file });
	}

	if (violations.length === 0) return true;
	if (write) {
		for (const violation of violations)
			writeFileSync(violation.file, violation.content, "utf8");
		return true;
	}

	console.error("Markdown list items missing trailing periods:");
	for (const { file, hits } of violations) {
		console.error(`\n  ${toRelative(file)}`);
		for (const hit of hits)
			console.error(`  ${String(hit.lineNo).padStart(4)}  ${hit.text}`);
	}
	return false;
}

function runPrettier({ write }) {
	const result = spawnSync(
		process.execPath,
		[PRETTIER_BIN, "--log-level", "warn", write ? "--write" : "--check", "."],
		{ cwd: REPO_ROOT, stdio: "inherit" },
	);
	return result.status === 0;
}

async function runAll({ write }) {
	const results = [
		runList({ write }),
		await runLlmCharacters({ write }),
		await runListPeriods({ write }),
		runPrettier({ write }),
	];
	return results.every(Boolean);
}

if (!(await runAll({ write }))) process.exit(1);
