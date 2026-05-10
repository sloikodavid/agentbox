import { constants, createReadStream, createWriteStream } from "node:fs";
import {
	copyFile,
	cp,
	link,
	lstat,
	lutimes,
	mkdir,
	open,
	readlink,
	rename,
	rm,
	chown,
	lchown,
	symlink,
	utimes,
	watch,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { parseConfig } from "./config.ts";

export const removalSuffix = ".__removed__";
export const rootfsHeartbeatPath = "/run/agentbox/rootfs.ready";
export const rootfsHeartbeatIntervalMs = 5_000;
export const rootfsHeartbeatMaxAgeMs = 15_000;
export const eventBatchWindowMs = 200;

export interface RootfsOptions {
	readonly volumePath?: string;
	readonly rootPath?: string;
}

export interface RootfsPaths {
	readonly rootPath: string;
	readonly filesPath: string;
	readonly removedFilesPath: string;
}

export interface RootfsWatcherFailure {
	readonly path: string;
	readonly message: string;
}

export interface RootfsHeartbeat {
	readonly updatedAt: string;
	readonly watcherCount: number;
	readonly failedWatchers: readonly RootfsWatcherFailure[];
}

interface QueuedEvent {
	readonly livePath: string;
	readonly kind: "store" | "remove";
}

const hardlinks = new Map<string, string>();

export function rootfsPaths(options: RootfsOptions = {}): RootfsPaths {
	const volumePath = options.volumePath ?? parseConfig().volumePath;
	return {
		rootPath: options.rootPath ?? "/",
		filesPath: join(volumePath, "rootfs", "files"),
		removedFilesPath: join(volumePath, "rootfs", "removed-files"),
	};
}

export async function restoreRootfs(
	options: RootfsOptions = {},
): Promise<void> {
	const paths = rootfsPaths(options);
	await mkdir(paths.filesPath, { recursive: true });
	await mkdir(paths.removedFilesPath, { recursive: true });
	await run("rsync", [
		"-a",
		"-H",
		"--numeric-ids",
		`${paths.filesPath}/`,
		paths.rootPath,
	]).catch(async (error: unknown) => {
		if (String(error).includes("ENOENT")) {
			await cp(paths.filesPath, paths.rootPath, {
				recursive: true,
				force: true,
			});
			return;
		}
		throw error;
	});
	await applyRemovalMarkers(paths);
}

export async function watchRootfs(
	options: RootfsOptions = {},
): Promise<() => Promise<void>> {
	const paths = rootfsPaths(options);
	await mkdir(paths.filesPath, { recursive: true });
	await mkdir(paths.removedFilesPath, { recursive: true });
	await mkdir(dirname(rootfsHeartbeatPath), { recursive: true });

	const queue = new Map<string, QueuedEvent>();
	const watchers: AsyncDisposable[] = [];
	const watcherFailures: RootfsWatcherFailure[] = [];
	let timer: NodeJS.Timeout | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let stopping = false;

	const beat = async (): Promise<void> => {
		const heartbeat: RootfsHeartbeat = {
			updatedAt: new Date().toISOString(),
			watcherCount: watchers.length,
			failedWatchers: watcherFailures,
		};
		const tempPath = `${rootfsHeartbeatPath}.${process.pid}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(heartbeat)}\n`);
		await rename(tempPath, rootfsHeartbeatPath);
	};

	const flush = async (): Promise<void> => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		const events = [...queue.values()];
		queue.clear();
		const removals = events.filter((event) => event.kind === "remove");
		const stores = events.filter((event) => event.kind === "store");
		for (const event of removals) {
			await processRemove(paths, event.livePath);
		}
		for (const event of stores) {
			await processStore(paths, event.livePath);
		}
		await beat();
	};

	const schedule = (event: QueuedEvent): void => {
		if (stopping || isExcludedPath(event.livePath, paths)) {
			return;
		}
		queue.set(event.livePath, event);
		timer ??= setTimeout(() => {
			flush().catch((error: unknown) => log(`flush failed: ${String(error)}`));
		}, eventBatchWindowMs);
	};

	const watchDirectory = (livePath: string, recursive: boolean): void => {
		if (isExcludedPath(livePath, paths)) {
			return;
		}
		try {
			const watcher = watch(livePath, { recursive });
			watchers.push(watcher);
			void (async () => {
				for await (const event of watcher) {
					if (!event.filename) {
						continue;
					}
					const changedPath = resolve(livePath, event.filename.toString());
					try {
						const stats = await lstat(changedPath);
						schedule({ livePath: changedPath, kind: "store" });
						if (stats.isDirectory()) {
							await queueRecursiveContents(changedPath, schedule);
						}
					} catch {
						schedule({ livePath: changedPath, kind: "remove" });
					}
				}
			})().catch((error: unknown) => {
				if (!stopping) {
					const message = String(error);
					watcherFailures.push({ path: livePath, message });
					log(`watch failed for ${livePath}: ${message}`);
				}
			});
		} catch (error) {
			const message = String(error);
			watcherFailures.push({ path: livePath, message });
			log(`could not watch ${livePath}: ${message}`);
		}
	};

	watchDirectory(paths.rootPath, false);
	for (const dir of [
		"/bin",
		"/boot",
		"/etc",
		"/home",
		"/lib",
		"/lib64",
		"/media",
		"/mnt",
		"/opt",
		"/root",
		"/sbin",
		"/srv",
		"/usr",
		"/var",
	]) {
		watchDirectory(dir, true);
	}

	await beat();
	heartbeatTimer = setInterval(() => {
		beat().catch((error: unknown) =>
			log(`heartbeat update failed: ${String(error)}`),
		);
	}, rootfsHeartbeatIntervalMs);
	heartbeatTimer.unref();

	const stop = async (): Promise<void> => {
		stopping = true;
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		for (const watcher of watchers) {
			await watcher[Symbol.asyncDispose]();
		}
		await flush();
	};

	process.once("SIGTERM", () => {
		stop()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	});

	return stop;
}

export async function storePath(
	livePath: string,
	options: RootfsOptions = {},
): Promise<void> {
	await processStore(rootfsPaths(options), livePath);
}

export async function storeAncestors(
	livePath: string,
	options: RootfsOptions = {},
): Promise<void> {
	const paths = rootfsPaths(options);
	let current = dirname(resolve(livePath));
	const root = resolve(paths.rootPath);
	const ancestors: string[] = [];
	while (current !== root && current.startsWith(root)) {
		ancestors.push(current);
		current = dirname(current);
	}
	for (const ancestor of ancestors.reverse()) {
		await processStore(paths, ancestor);
	}
}

export async function removeStoredPath(
	livePath: string,
	options: RootfsOptions = {},
): Promise<void> {
	await rm(storedPathForLivePath(livePath, rootfsPaths(options)), {
		recursive: true,
		force: true,
	});
}

export async function markRemoved(
	livePath: string,
	options: RootfsOptions = {},
): Promise<void> {
	const marker = removalMarkerForLivePath(livePath, rootfsPaths(options));
	await mkdir(dirname(marker), { recursive: true });
	await writeFile(marker, "");
}

export async function unmarkRemoved(
	livePath: string,
	options: RootfsOptions = {},
): Promise<void> {
	const paths = rootfsPaths(options);
	let current = resolve(livePath);
	const root = resolve(paths.rootPath);
	while (current !== root && current.startsWith(root)) {
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
	paths: RootfsPaths = rootfsPaths(),
): string {
	return join(paths.filesPath, relativeFromRoot(livePath, paths));
}

export function removalMarkerForLivePath(
	livePath: string,
	paths: RootfsPaths = rootfsPaths(),
): string {
	return join(
		paths.removedFilesPath,
		`${relativeFromRoot(livePath, paths)}${removalSuffix}`,
	);
}

export function removalSubtreeForLivePath(
	livePath: string,
	paths: RootfsPaths = rootfsPaths(),
): string {
	return join(paths.removedFilesPath, relativeFromRoot(livePath, paths));
}

export function isExcludedPath(
	livePath: string,
	paths: RootfsPaths = rootfsPaths(),
): boolean {
	const path = resolve(livePath);
	const volumePath = resolve(dirname(dirname(paths.filesPath)));
	const excluded = [
		"/",
		"/.dockerenv",
		"/dev",
		"/etc/hostname",
		"/etc/hosts",
		"/etc/resolv.conf",
		"/home/user/.cache",
		"/home/user/.local/share/Trash",
		"/opt/agentbox",
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
		volumePath,
	].map((entry) => resolve(entry));

	return excluded.some(
		(entry) => path === entry || path.startsWith(`${entry}${sep}`),
	);
}

async function processStore(
	paths: RootfsPaths,
	livePath: string,
): Promise<void> {
	if (isExcludedPath(livePath, paths)) {
		return;
	}
	try {
		const stats = await lstat(livePath);
		if (
			stats.isSocket() ||
			stats.isFIFO() ||
			stats.isBlockDevice() ||
			stats.isCharacterDevice()
		) {
			return;
		}

		await storeAncestorMetadata(paths, livePath);
		const storedPath = storedPathForLivePath(livePath, paths);
		await rm(storedPath, { recursive: true, force: true });
		await mkdir(dirname(storedPath), { recursive: true });

		if (stats.isSymbolicLink()) {
			await symlink(await readlink(livePath), storedPath);
		} else if (stats.isDirectory()) {
			await mkdir(storedPath, { recursive: true, mode: stats.mode });
			await copyMetadata(livePath, storedPath);
		} else if (stats.isFile()) {
			const hardlinkKey = `${stats.dev}:${stats.ino}`;
			const existingHardlink = hardlinks.get(hardlinkKey);
			if (
				stats.nlink > 1 &&
				existingHardlink &&
				existingHardlink !== storedPath &&
				(await isStoredFile(existingHardlink))
			) {
				await link(existingHardlink, storedPath);
			} else {
				await copyFileConsistently(livePath, storedPath);
				if (stats.nlink > 1) {
					hardlinks.set(hardlinkKey, storedPath);
				}
			}
			await copyMetadata(livePath, storedPath);
		}

		await unmarkRemoved(livePath, {
			rootPath: paths.rootPath,
			volumePath: dirname(dirname(paths.filesPath)),
		});
	} catch (error) {
		log(`store failed for ${livePath}: ${String(error)}`);
	}
}

async function processRemove(
	paths: RootfsPaths,
	livePath: string,
): Promise<void> {
	if (isExcludedPath(livePath, paths)) {
		return;
	}
	await removeStoredPath(livePath, {
		rootPath: paths.rootPath,
		volumePath: dirname(dirname(paths.filesPath)),
	});
	await markRemoved(livePath, {
		rootPath: paths.rootPath,
		volumePath: dirname(dirname(paths.filesPath)),
	});
}

async function applyRemovalMarkers(paths: RootfsPaths): Promise<void> {
	await walk(paths.removedFilesPath, async (marker) => {
		if (!marker.endsWith(removalSuffix)) {
			return;
		}
		const relativeMarker = relative(paths.removedFilesPath, marker).slice(
			0,
			-removalSuffix.length,
		);
		await rm(join(paths.rootPath, relativeMarker), {
			recursive: true,
			force: true,
		});
	});
}

async function storeAncestorMetadata(
	paths: RootfsPaths,
	livePath: string,
): Promise<void> {
	let current = dirname(resolve(livePath));
	const root = resolve(paths.rootPath);
	const ancestors: string[] = [];
	while (current !== root && current.startsWith(root)) {
		ancestors.push(current);
		current = dirname(current);
	}
	for (const ancestor of ancestors.reverse()) {
		await storeOnePath(paths, ancestor);
	}
}

async function storeOnePath(
	paths: RootfsPaths,
	livePath: string,
): Promise<void> {
	const stats = await lstat(livePath);
	if (!stats.isDirectory()) {
		return;
	}
	const storedPath = storedPathForLivePath(livePath, paths);
	await mkdir(storedPath, { recursive: true, mode: stats.mode });
	await copyMetadata(livePath, storedPath);
}

async function queueRecursiveContents(
	livePath: string,
	schedule: (event: QueuedEvent) => void,
): Promise<void> {
	await walk(livePath, (path) => schedule({ livePath: path, kind: "store" }));
}

async function walk(
	path: string,
	visitor: (path: string) => Promise<void> | void,
): Promise<void> {
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
	const { readdir } = await import("node:fs/promises");
	for (const entry of await readdir(path)) {
		await walk(join(path, entry), visitor);
	}
}

async function copyFileConsistently(
	source: string,
	destination: string,
): Promise<void> {
	const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const before = await lstat(source);
		await copyFile(source, temp, constants.COPYFILE_FICLONE_FORCE).catch(
			async () => {
				await streamCopy(source, temp);
			},
		);
		const after = await lstat(source);
		if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
			await rename(temp, destination);
			return;
		}
	}
	await rename(temp, destination);
}

async function streamCopy(source: string, destination: string): Promise<void> {
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const input = createReadStream(source);
		const output = createWriteStream(destination);
		input.on("error", rejectPromise);
		output.on("error", rejectPromise);
		output.on("finish", resolvePromise);
		input.pipe(output);
	});
}

async function copyMetadata(
	source: string,
	destination: string,
): Promise<void> {
	const stats = await lstat(source);
	if (stats.isSymbolicLink()) {
		await lchown(destination, stats.uid, stats.gid).catch(ignoreUnsupported);
		await lutimes(destination, stats.atime, stats.mtime).catch(
			ignoreUnsupported,
		);
		return;
	}
	await chown(destination, stats.uid, stats.gid).catch(ignoreUnsupported);
	await open(destination, "r")
		.then((file) => file.chmod(stats.mode).finally(() => file.close()))
		.catch(ignoreUnsupported);
	await utimes(destination, stats.atime, stats.mtime).catch(ignoreUnsupported);
}

async function isStoredFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

function ignoreUnsupported(error: unknown): void {
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== "EPERM" && code !== "ENOSYS" && code !== "ENOENT") {
		throw error;
	}
}

function relativeFromRoot(livePath: string, paths: RootfsPaths): string {
	const resolvedRoot = resolve(paths.rootPath);
	const resolvedPath = resolve(livePath);
	const relativePath = relative(resolvedRoot, resolvedPath);
	if (relativePath.startsWith("..")) {
		throw new Error(`${livePath} is outside ${paths.rootPath}`);
	}
	return relativePath || ".";
}

async function run(command: string, args: readonly string[]): Promise<void> {
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("exit", (code) => {
			if (code === 0) {
				resolvePromise();
			} else {
				rejectPromise(new Error(`${command} exited with ${code ?? "unknown"}`));
			}
		});
		child.on("error", rejectPromise);
	});
}

function log(message: string): void {
	console.log(`[agentbox-rootfs] ${message}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const mode = process.argv[2];
	if (mode === "restore") {
		await restoreRootfs();
	} else if (mode === "watch") {
		await watchRootfs();
	} else {
		console.error("usage: node /opt/agentbox/rootfs.ts <restore|watch>");
		process.exit(64);
	}
}
