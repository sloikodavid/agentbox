import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
	console.log(`\n$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		...options
	});
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function canRun(command, args) {
	const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "ignore" });
	return result.status === 0;
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function toRepoPath(file) {
	return relative(REPO_ROOT, file).replaceAll("\\", "/");
}

function findCargoManifests() {
	// Discover via git so .gitignore is respected (e.g. throwaway checkouts
	// under tmp/ are excluded), matching scripts/format.mjs.
	const output = execFileSync(
		"git",
		[
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"-z",
			"*Cargo.toml"
		],
		{ cwd: REPO_ROOT }
	);
	return output
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.map((path) => join(REPO_ROOT, path))
		.sort((left, right) => left.localeCompare(right));
}

function isWorkspaceManifest(manifest) {
	const contents = readFileSync(manifest, "utf8");
	return /^\s*\[workspace\]\s*$/m.test(contents);
}

function cargoTargets() {
	const manifests = findCargoManifests();
	if (manifests.length === 0) return [];

	const workspace = manifests.find(isWorkspaceManifest);
	if (workspace) {
		return [{ all: true, manifest: toRepoPath(workspace) }];
	}

	return manifests.map((manifest) => ({
		all: false,
		manifest: toRepoPath(manifest)
	}));
}

function cargoCommands(targets = cargoTargets()) {
	return targets.flatMap((target) => {
		const fmtArgs = ["fmt", "--manifest-path", target.manifest, "--check"];
		if (target.all) fmtArgs.push("--all");
		const commonArgs = [
			"--manifest-path",
			target.manifest,
			target.all ? "--workspace" : undefined,
			"--all-targets",
			"--all-features"
		].filter(Boolean);

		return [
			["cargo", fmtArgs],
			["cargo", ["clippy", ...commonArgs, "--", "-D", "warnings"]],
			["cargo", ["test", ...commonArgs]]
		];
	});
}

function rustImage() {
	const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
	const match = /^FROM\s+(rust:[^\s]+)\s+AS\s+persistd-chef\s*$/m.exec(
		dockerfile
	);
	if (!match) {
		console.error("Could not find the persistd-chef Rust image in Dockerfile.");
		process.exit(1);
	}
	return match[1];
}

const targets = cargoTargets();
if (targets.length === 0) process.exit(0);

if (process.platform === "linux" && canRun("cargo", ["--version"])) {
	for (const [command, args] of cargoCommands(targets)) run(command, args);
	process.exit(0);
}

if (!canRun("docker", ["version", "--format", "{{.Server.Version}}"])) {
	console.error(
		"Rust checks need Linux. Install Rust on Linux or start Docker so pnpm check can run them in a Linux container."
	);
	process.exit(1);
}

const script = [
	"set -e",
	'export PATH="/usr/local/cargo/bin:${PATH}"',
	"rustup component add rustfmt clippy >/dev/null",
	...cargoCommands(targets).map(([command, args]) =>
		[command, ...args.map(shellQuote)].join(" ")
	)
].join(" && ");

run("docker", [
	"run",
	"--rm",
	"-v",
	`${REPO_ROOT}:/work`,
	"-w",
	"/work",
	rustImage(),
	"sh",
	"-lc",
	script
]);
