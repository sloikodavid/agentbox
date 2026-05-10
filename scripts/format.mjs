import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

const require = createRequire(import.meta.url);
const prettierBin = require.resolve("prettier/bin/prettier.cjs");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--check", "-c", "--write", "-w"]);
const write = args.has("--write") || args.has("-w");
const explicitCheck = args.has("--check") || args.has("-c");
const hasUnknownArg = process.argv
	.slice(2)
	.some((arg) => !allowedArgs.has(arg));
const check = !write && (args.size === 0 || explicitCheck);
const treeOutputFile = "TREE.md";
const ignorePath = [
	join(repoRoot, ".gitignore"),
	join(repoRoot, ".prettierignore"),
];

if (hasUnknownArg || (write && explicitCheck) || (!write && !check)) {
	console.error("Usage: node scripts/format.mjs [--check|--write]");
	process.exit(2);
}

const llmReplacements = [
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
const listItem = /^(\s*(?:[-*+]|\d+\.)\s+)(.+)$/;
const terminalPunctuation = /[.!?:;,)\]"']$/;

function toRelative(file) {
	return relative(repoRoot, file).replaceAll("\\", "/");
}

function gitFiles() {
	const output = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: repoRoot },
	);
	return output
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.filter(
			(path) => path !== treeOutputFile && existsSync(join(repoRoot, path)),
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
		const file = join(repoRoot, path);
		const info = await prettier.getFileInfo(file, { ignorePath });
		if (!info.ignored) files.push({ file, parser: info.inferredParser });
	}
	return files;
}

function renderTree() {
	const root = {
		children: new Map(),
		name: basename(repoRoot),
		type: "directory",
	};

	for (const path of [...gitFiles(), treeOutputFile]) {
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
		"# Tree",
		"",
		"> Run `pnpm fix` to regenerate.",
		"",
		"```text",
		...renderNode(root),
		"```",
		"",
	].join("\n");
}

function runTree({ write }) {
	const file = join(repoRoot, treeOutputFile);
	const expected = renderTree();
	const actual = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (actual === expected) return true;
	if (write) {
		writeFileSync(file, expected);
		return true;
	}
	console.error(`${treeOutputFile} is out of date. Run 'pnpm fix'.`);
	return false;
}

function replaceLlmCharacters(content) {
	let output = content;
	for (const [from, to] of llmReplacements) output = output.replace(from, to);
	return output;
}

function lineHasLlmCharacter(line) {
	return llmReplacements.some(([pattern]) => {
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
		const match = listItem.exec(line);
		if (!match) return line;
		const [, prefix, text] = match;
		if (terminalPunctuation.test(text)) return line;
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
		[prettierBin, "--log-level", "warn", write ? "--write" : "--check", "."],
		{ cwd: repoRoot, stdio: "inherit" },
	);
	return result.status === 0;
}

async function runAll({ write }) {
	const results = [
		runTree({ write }),
		await runLlmCharacters({ write }),
		await runListPeriods({ write }),
		runPrettier({ write }),
	];
	return results.every(Boolean);
}

if (!(await runAll({ write }))) process.exit(1);
