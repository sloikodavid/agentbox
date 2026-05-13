import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { PersistenceChange } from "./types.ts";
import type { RootfsPaths } from "./rootfs.ts";
import {
	isWithinRoot,
	removeStoredPath,
	relativeFromRoot,
	storedPathForLivePath,
} from "./rootfs.ts";

interface ReconcileOptions {
	readonly paths: RootfsPaths;
	readonly record: (change: PersistenceChange) => Promise<void>;
	readonly shouldPersist: (livePath: string) => boolean;
}

type LiveEntryType = "directory" | "other";

interface LiveEntry {
	readonly livePath: string;
	readonly relativePath: string;
	readonly type: LiveEntryType;
}

interface StoredEntry {
	readonly livePath: string;
	readonly relativePath: string;
}

export async function reconcileRootfs(
	options: ReconcileOptions,
	livePath: string = options.paths.rootPath,
): Promise<void> {
	const scope = reconcileScope(livePath, options.paths);
	const liveEntries = new Map<string, LiveEntry>();
	await collectLiveEntries(scope, options, liveEntries);
	const staleStoredEntries = await collectStaleStoredEntries(
		scope,
		options,
		liveEntries,
	);

	for (const entry of sortLiveEntries(liveEntries.values())) {
		if (await shouldRecordPresentEntry(entry.livePath, options.paths)) {
			await options.record({ type: "present", livePath: entry.livePath });
		}
	}
	for (const entry of staleStoredEntries) {
		await removeOrMarkStaleEntry(entry, liveEntries, options);
	}
}

export async function repairPersistedRootfs(
	options: ReconcileOptions,
): Promise<void> {
	const storedEntries: StoredEntry[] = [];
	await walkStoredEntries(options.paths.filesPath, options, storedEntries);
	const liveEntries = new Map<string, LiveEntry>();
	for (const entry of storedEntries) {
		await collectLiveEntryIfPresent(entry.livePath, options, liveEntries);
	}
	for (const entry of sortLiveEntries(liveEntries.values())) {
		if (await shouldRecordPresentEntry(entry.livePath, options.paths)) {
			await options.record({ type: "present", livePath: entry.livePath });
		}
	}
	const staleAncestors = new Set<string>();
	for (const entry of storedEntries.sort(compareRelativeDepth)) {
		if (hasAncestor(entry.relativePath, staleAncestors)) {
			continue;
		}
		if (liveEntries.has(entry.relativePath)) {
			continue;
		}
		staleAncestors.add(entry.relativePath);
		await removeOrMarkStaleEntry(entry, liveEntries, options);
	}
}

async function removeOrMarkStaleEntry(
	entry: StoredEntry,
	liveEntries: Map<string, LiveEntry>,
	options: ReconcileOptions,
): Promise<void> {
	if (!options.shouldPersist(entry.livePath)) {
		await removeStoredPath(entry.livePath, options.paths);
		return;
	}
	if (hasLiveNonDirectoryAncestor(entry.relativePath, liveEntries)) {
		await removeStoredPath(entry.livePath, options.paths);
		return;
	}
	await options.record({ type: "removed", livePath: entry.livePath });
}

function reconcileScope(livePath: string, paths: RootfsPaths): string {
	const root = resolve(paths.rootPath);
	const path = resolve(livePath);
	if (!isWithinRoot(path, root)) {
		throw new Error(`${livePath} is outside ${paths.rootPath}`);
	}
	return path;
}

async function collectLiveEntries(
	scope: string,
	options: ReconcileOptions,
	entries: Map<string, LiveEntry>,
): Promise<void> {
	if (resolve(scope) === resolve(options.paths.rootPath)) {
		let names;
		try {
			names = await readdir(scope);
		} catch {
			return;
		}
		for (const name of names) {
			await collectLiveEntry(join(scope, name), options, entries);
		}
		return;
	}
	await collectLiveEntry(scope, options, entries);
}

async function collectLiveEntry(
	livePath: string,
	options: ReconcileOptions,
	entries: Map<string, LiveEntry>,
): Promise<void> {
	const stats = await collectLiveEntryIfPresent(livePath, options, entries);
	if (!stats?.isDirectory()) {
		return;
	}
	let names;
	try {
		names = await readdir(livePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	for (const name of names) {
		await collectLiveEntry(join(livePath, name), options, entries);
	}
}

async function collectLiveEntryIfPresent(
	livePath: string,
	options: ReconcileOptions,
	entries: Map<string, LiveEntry>,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
	if (!options.shouldPersist(livePath)) {
		return undefined;
	}
	let stats;
	try {
		stats = await lstat(livePath);
	} catch {
		return undefined;
	}
	const relativePath = relativeFromRoot(livePath, options.paths);
	const type: LiveEntryType = stats.isDirectory() ? "directory" : "other";
	entries.set(relativePath, { livePath, relativePath, type });
	return stats;
}

async function collectStaleStoredEntries(
	scope: string,
	options: ReconcileOptions,
	liveEntries: Map<string, LiveEntry>,
): Promise<StoredEntry[]> {
	const storedEntries: StoredEntry[] = [];
	const storedScope =
		resolve(scope) === resolve(options.paths.rootPath)
			? options.paths.filesPath
			: storedPathForLivePath(scope, options.paths);
	await walkStoredEntries(storedScope, options, storedEntries);

	const staleEntries: StoredEntry[] = [];
	const staleAncestors = new Set<string>();
	for (const entry of storedEntries.sort(compareRelativeDepth)) {
		if (hasAncestor(entry.relativePath, staleAncestors)) {
			continue;
		}
		if (liveEntries.has(entry.relativePath)) {
			continue;
		}
		staleEntries.push(entry);
		staleAncestors.add(entry.relativePath);
	}
	return staleEntries;
}

async function walkStoredEntries(
	storedPath: string,
	options: ReconcileOptions,
	entries: StoredEntry[],
): Promise<void> {
	let stats;
	try {
		stats = await lstat(storedPath);
	} catch {
		return;
	}
	if (resolve(storedPath) !== resolve(options.paths.filesPath)) {
		const relativePath = relative(options.paths.filesPath, storedPath);
		entries.push({
			livePath: join(options.paths.rootPath, relativePath),
			relativePath,
		});
	}
	if (!stats.isDirectory()) {
		return;
	}
	for (const name of await readdir(storedPath)) {
		await walkStoredEntries(join(storedPath, name), options, entries);
	}
}

async function shouldRecordPresentEntry(
	livePath: string,
	paths: RootfsPaths,
): Promise<boolean> {
	const storedPath = storedPathForLivePath(livePath, paths);
	let liveStats;
	let storedStats;
	try {
		[liveStats, storedStats] = await Promise.all([
			lstat(livePath),
			lstat(storedPath),
		]);
	} catch {
		return true;
	}
	if (
		liveStats.isDirectory() !== storedStats.isDirectory() ||
		liveStats.isFile() !== storedStats.isFile() ||
		liveStats.isSymbolicLink() !== storedStats.isSymbolicLink()
	) {
		return true;
	}
	if (liveStats.isSymbolicLink()) {
		try {
			return (await readlink(livePath)) !== (await readlink(storedPath));
		} catch {
			return true;
		}
	}
	if (
		liveStats.size !== storedStats.size ||
		liveStats.mtimeMs !== storedStats.mtimeMs ||
		liveStats.mode !== storedStats.mode ||
		liveStats.uid !== storedStats.uid ||
		liveStats.gid !== storedStats.gid
	) {
		return true;
	}
	if (liveStats.isFile()) {
		if (liveStats.nlink > 1) {
			return true;
		}
		return (await hashFile(livePath)) !== (await hashFile(storedPath));
	}
	return false;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const input = createReadStream(path);
		input.on("data", (chunk: Buffer) => hash.update(chunk));
		input.on("error", rejectPromise);
		input.on("end", resolvePromise);
	});
	return hash.digest("hex");
}

function sortLiveEntries(entries: Iterable<LiveEntry>): LiveEntry[] {
	return [...entries].sort((left, right) => {
		if (left.type !== right.type) {
			return left.type === "directory" ? -1 : 1;
		}
		return pathDepth(left.relativePath) - pathDepth(right.relativePath);
	});
}

function compareRelativeDepth(left: StoredEntry, right: StoredEntry): number {
	return pathDepth(left.relativePath) - pathDepth(right.relativePath);
}

function pathDepth(path: string): number {
	return path === "." ? 0 : path.split(sep).length;
}

function hasAncestor(relativePath: string, ancestors: Set<string>): boolean {
	let current = dirname(relativePath);
	while (current && current !== ".") {
		if (ancestors.has(current)) {
			return true;
		}
		const next = dirname(current);
		if (next === current) {
			break;
		}
		current = next;
	}
	return false;
}

function hasLiveNonDirectoryAncestor(
	relativePath: string,
	liveEntries: Map<string, LiveEntry>,
): boolean {
	let current = dirname(relativePath);
	while (current && current !== ".") {
		const liveEntry = liveEntries.get(current);
		if (liveEntry) {
			return liveEntry.type !== "directory";
		}
		const next = dirname(current);
		if (next === current) {
			break;
		}
		current = next;
	}
	return false;
}
