import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PersistenceOptions } from "./types.ts";
import { CONFIG_DEFAULTS, PERSISTENCE_DEFAULTS } from "../defaults.ts";

const DEFAULT_ROOT_PATH = PERSISTENCE_DEFAULTS.rootPath;
const DEFAULT_VOLUME_PATH = CONFIG_DEFAULTS.volumePath;
const ROOTFS_STORAGE_DIRECTORY = "rootfs";
const LEGACY_ROOTFS_STORAGE_DIRECTORY = "rootfs-persistence";

const REMOVAL_SUFFIX = ".__removed__";
const ROOT_RELATIVE_EXCLUSIONS = [
	"/.dockerenv",
	"/dev",
	"/etc/hostname",
	"/etc/hosts",
	"/etc/resolv.conf",
	"/etc/supervisor",
	"/home/user/.cache",
	"/home/user/.local/share/Trash",
	"/opt/agentbox",
	"/usr/share/applications/agentbox.desktop",
	"/opt/code-server",
	"/proc",
	"/run",
	"/sys",
	"/tmp",
	"/var/cache/apt/archives",
	"/var/lib/apt/lists/lock",
	"/var/lib/dpkg/lock",
	"/var/lib/dpkg/lock-frontend",
	"/var/lib/dpkg/triggers/Lock",
	"/var/run",
] as const;

export interface RootfsPaths {
	readonly rootPath: string;
	readonly storagePath: string;
	readonly legacyStoragePath: string;
	readonly filesPath: string;
	readonly removedFilesPath: string;
}

export function rootfsPaths(options: PersistenceOptions = {}): RootfsPaths {
	const volumePath = options.volumePath ?? volumePathFromEnv(process.env);
	const storagePath = join(volumePath, ROOTFS_STORAGE_DIRECTORY);
	return {
		rootPath: options.rootPath ?? DEFAULT_ROOT_PATH,
		storagePath,
		legacyStoragePath: join(volumePath, LEGACY_ROOTFS_STORAGE_DIRECTORY),
		filesPath: join(storagePath, "files"),
		removedFilesPath: join(storagePath, "removed-files"),
	};
}

export async function prepareRootfsStorage(paths: RootfsPaths): Promise<void> {
	await migrateLegacyRootfsStorage(paths);
	await mkdir(paths.filesPath, { recursive: true });
	await mkdir(paths.removedFilesPath, { recursive: true });
}

async function migrateLegacyRootfsStorage(paths: RootfsPaths): Promise<void> {
	if (await pathExists(paths.storagePath)) {
		return;
	}
	try {
		await rename(paths.legacyStoragePath, paths.storagePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function volumePathFromEnv(env: NodeJS.ProcessEnv): string {
	const volumePath = env.AGENTBOX_VOLUME_PATH?.trim() || DEFAULT_VOLUME_PATH;
	if (!isAbsolute(volumePath)) {
		throw new Error("AGENTBOX_VOLUME_PATH must be an absolute path");
	}
	return volumePath;
}

export function isExcludedPath(livePath: string, paths: RootfsPaths): boolean {
	const path = resolve(livePath);
	const rootPath = resolve(paths.rootPath);
	if (path === rootPath) {
		return true;
	}
	const rootRelativeExclusions = ROOT_RELATIVE_EXCLUSIONS.map((entry) =>
		resolve(rootPath, entry.slice(1)),
	);
	const excluded = [
		...rootRelativeExclusions,
		resolve(paths.storagePath),
		resolve(paths.legacyStoragePath),
	];

	return excluded.some(
		(entry) => path === entry || path.startsWith(`${entry}${sep}`),
	);
}

export function isTopLevelEntry(livePath: string, paths: RootfsPaths): boolean {
	const relativePath = relative(resolve(paths.rootPath), resolve(livePath));
	return (
		relativePath !== "" &&
		!isOutsideRelativePath(relativePath) &&
		!relativePath.includes(sep)
	);
}

export async function removeStoredPath(
	livePath: string,
	paths: RootfsPaths,
): Promise<void> {
	await rm(storedPathForLivePath(livePath, paths), {
		recursive: true,
		force: true,
	});
}

export async function markRemoved(
	livePath: string,
	paths: RootfsPaths,
): Promise<void> {
	const marker = removalMarkerForLivePath(livePath, paths);
	await mkdir(dirname(marker), { recursive: true });
	await writeFile(marker, "");
}

export async function unmarkRemoved(
	livePath: string,
	paths: RootfsPaths,
): Promise<void> {
	let current = resolve(livePath);
	const root = resolve(paths.rootPath);
	while (current !== root && isWithinRoot(current, root)) {
		await rm(removalMarkerForLivePath(current, paths), {
			force: true,
		});
		current = dirname(current);
	}
	await rm(removalSubtreeForLivePath(livePath, paths), {
		recursive: true,
		force: true,
	});
}

export function storedPathForLivePath(
	livePath: string,
	paths: RootfsPaths,
): string {
	return join(paths.filesPath, relativeFromRoot(livePath, paths));
}

function removalMarkerForLivePath(
	livePath: string,
	paths: RootfsPaths,
): string {
	return join(
		paths.removedFilesPath,
		`${relativeFromRoot(livePath, paths)}${REMOVAL_SUFFIX}`,
	);
}

function removalSubtreeForLivePath(
	livePath: string,
	paths: RootfsPaths,
): string {
	return join(paths.removedFilesPath, relativeFromRoot(livePath, paths));
}

export async function applyRemovalMarkers(
	paths: RootfsPaths,
	shouldApply: (livePath: string) => boolean = () => true,
): Promise<void> {
	await walkRemovedMarkers(paths, async (marker) => {
		if (!marker.endsWith(REMOVAL_SUFFIX)) {
			return;
		}
		const relativeMarker = relative(paths.removedFilesPath, marker).slice(
			0,
			-REMOVAL_SUFFIX.length,
		);
		const livePath = join(paths.rootPath, relativeMarker);
		if (!shouldApply(livePath)) {
			return;
		}
		await rm(livePath, {
			recursive: true,
			force: true,
		});
	});
}

async function walkRemovedMarkers(
	paths: RootfsPaths,
	visitor: (path: string) => Promise<void> | void,
): Promise<void> {
	async function walk(path: string): Promise<void> {
		let stats;
		try {
			stats = await lstat(path);
		} catch {
			return;
		}
		await visitor(path);
		if (!stats.isDirectory()) {
			return;
		}
		for (const entry of await readdir(path)) {
			await walk(join(path, entry));
		}
	}
	await walk(paths.removedFilesPath);
}

export function relativeFromRoot(livePath: string, paths: RootfsPaths): string {
	const resolvedRoot = resolve(paths.rootPath);
	const resolvedPath = resolve(livePath);
	const relativePath = relative(resolvedRoot, resolvedPath);
	if (isOutsideRelativePath(relativePath)) {
		throw new Error(`${livePath} is outside ${paths.rootPath}`);
	}
	return relativePath || ".";
}

export function isWithinRoot(path: string, resolvedRoot: string): boolean {
	return !isOutsideRelativePath(relative(resolvedRoot, resolve(path)));
}

export function isOutsideRelativePath(relativePath: string): boolean {
	return (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	);
}
