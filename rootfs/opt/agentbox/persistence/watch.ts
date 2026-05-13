import {
	lstat,
	mkdir,
	readdir,
	rename,
	writeFile,
	watch,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
	PersistenceHeartbeat,
	PersistenceWatcher,
	PersistenceWatcherFailure,
} from "./types.ts";
import type { RootfsPaths } from "./rootfs.ts";
import {
	PERSISTENCE_EVENT_BATCH_WINDOW_MS,
	PERSISTENCE_FULL_RECONCILE_INTERVAL_MS,
	PERSISTENCE_HEARTBEAT_INTERVAL_MS,
	PERSISTENCE_RECONCILE_INTERVAL_MS,
} from "./constants.ts";

interface ActiveWatcher {
	readonly controller: AbortController;
	closing: boolean;
}

export async function runPersistenceWatch(options: {
	readonly paths: RootfsPaths;
	readonly heartbeatPath: string;
	readonly reconcile: (livePath?: string) => Promise<void>;
	readonly repair: () => Promise<void>;
	readonly shouldPersist: (livePath: string) => boolean;
	readonly log: (message: string) => void;
}): Promise<PersistenceWatcher> {
	const paths = options.paths;
	const dirtyScopes = new Set<string>();
	const directoryWatchers = new Map<string, ActiveWatcher>();
	const watcherFailures: PersistenceWatcherFailure[] = [];
	let rootWatcher: ActiveWatcher | undefined;
	let timer: NodeJS.Timeout | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let rootReconcileTimer: NodeJS.Timeout | undefined;
	let fullReconcileTimer: NodeJS.Timeout | undefined;
	let flushing: Promise<void> = Promise.resolve();
	let reconciling: Promise<void> = Promise.resolve();
	let rootEntrySnapshot = new Set<string>();
	let stopping = false;
	let heartbeatWriteId = 0;
	let lastHeartbeat: PersistenceHeartbeat = {
		updatedAt: new Date(0).toISOString(),
		watcherCount: 0,
		failedWatchers: [],
	};

	await mkdir(paths.filesPath, { recursive: true });
	await mkdir(paths.removedFilesPath, { recursive: true });
	await mkdir(dirname(options.heartbeatPath), { recursive: true });

	const beat = async (): Promise<void> => {
		lastHeartbeat = {
			updatedAt: new Date().toISOString(),
			watcherCount: (rootWatcher ? 1 : 0) + directoryWatchers.size,
			failedWatchers: [...watcherFailures],
		};
		const tempPath = `${options.heartbeatPath}.${process.pid}.${heartbeatWriteId++}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(lastHeartbeat)}\n`);
		await rename(tempPath, options.heartbeatPath);
	};

	const recordWatchFailure = (livePath: string, error: unknown): void => {
		const message = String(error);
		if (
			!watcherFailures.some(
				(failure) => failure.path === livePath && failure.message === message,
			)
		) {
			watcherFailures.push({ path: livePath, message });
		}
		options.log(`watch failed for ${livePath}: ${message}`);
	};

	const reconcileSafely = async (livePath: string): Promise<void> => {
		const run = reconciling.then(
			() => reconcileOneSafely(livePath),
			() => reconcileOneSafely(livePath),
		);
		reconciling = run.catch(() => {});
		await run;
	};

	const reconcileOneSafely = async (livePath: string): Promise<void> => {
		try {
			await options.reconcile(livePath);
		} catch (error) {
			options.log(`reconcile failed for ${livePath}: ${String(error)}`);
		}
	};

	const repairSafely = async (): Promise<void> => {
		try {
			await options.repair();
		} catch (error) {
			options.log(`repair failed: ${String(error)}`);
		}
	};

	const flushQueuedEvents = async (): Promise<void> => {
		const scopes = collapseDirtyScopes([...dirtyScopes]);
		dirtyScopes.clear();
		for (const livePath of scopes) {
			await reconcileSafely(livePath);
		}
		await beat();
	};

	const flush = async (): Promise<void> => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		const run = flushing.then(flushQueuedEvents, flushQueuedEvents);
		flushing = run.catch(() => {});
		await run;
	};

	const scheduleReconcile = (livePath: string): void => {
		if (stopping) {
			return;
		}
		const path = resolve(livePath);
		if (path !== resolve(paths.rootPath) && !options.shouldPersist(path)) {
			return;
		}
		dirtyScopes.add(path);
		timer ??= setTimeout(() => {
			flush().catch((error: unknown) =>
				options.log(`flush failed: ${String(error)}`),
			);
		}, PERSISTENCE_EVENT_BATCH_WINDOW_MS);
	};

	const watchRecursiveContentsSafely = async (
		livePath: string,
	): Promise<void> => {
		try {
			await watchRecursiveContents(
				livePath,
				options.shouldPersist,
				watchPersistedDirectory,
			);
		} catch (error) {
			recordWatchFailure(livePath, error);
		}
	};

	const watchDirectory = (livePath: string): ActiveWatcher | undefined => {
		if (
			resolve(livePath) !== resolve(paths.rootPath) &&
			!options.shouldPersist(livePath)
		) {
			return undefined;
		}
		try {
			const controller = new AbortController();
			const activeWatcher: ActiveWatcher = { controller, closing: false };
			const watcher = watch(livePath, {
				recursive: false,
				signal: controller.signal,
			});
			void (async () => {
				for await (const event of watcher) {
					if (!event.filename) {
						continue;
					}
					const changedPath = resolve(livePath, event.filename.toString());
					try {
						const stats = await lstat(changedPath);
						if (stats.isDirectory()) {
							await watchRecursiveContentsSafely(changedPath);
						}
						scheduleReconcile(changedPath);
					} catch {
						scheduleReconcile(changedPath);
						disposeDirectoryWatchersWithin(changedPath);
					}
				}
			})().catch((error: unknown) => {
				if (!stopping && !activeWatcher.closing) {
					recordWatchFailure(livePath, error);
				}
			});
			return activeWatcher;
		} catch (error) {
			recordWatchFailure(livePath, error);
			return undefined;
		}
	};

	const watchPersistedDirectory = (livePath: string): void => {
		const path = resolve(livePath);
		if (directoryWatchers.has(path) || !options.shouldPersist(path)) {
			return;
		}
		const watcher = watchDirectory(path);
		if (watcher) {
			directoryWatchers.set(path, watcher);
		}
	};

	const disposeDirectoryWatchersWithin = (livePath: string): void => {
		const path = resolve(livePath);
		for (const [watchPath, watcher] of directoryWatchers) {
			if (!isSameOrDescendantPath(watchPath, path)) {
				continue;
			}
			directoryWatchers.delete(watchPath);
			watcher.closing = true;
			watcher.controller.abort();
		}
	};

	const reconcileRootEntries = async (
		mode: "initial" | "changes",
	): Promise<void> => {
		const currentEntries = new Set<string>();
		for (const entry of await readdir(paths.rootPath)) {
			const livePath = resolve(paths.rootPath, entry);
			if (!options.shouldPersist(livePath)) {
				continue;
			}
			currentEntries.add(livePath);
			if (mode === "changes" && rootEntrySnapshot.has(livePath)) {
				continue;
			}
			try {
				const stats = await lstat(livePath);
				if (stats.isDirectory()) {
					await watchRecursiveContentsSafely(livePath);
					if (mode === "changes") {
						scheduleReconcile(livePath);
					}
				} else if (mode === "changes") {
					scheduleReconcile(paths.rootPath);
				}
			} catch {
				if (mode === "changes") {
					scheduleReconcile(paths.rootPath);
				}
				disposeDirectoryWatchersWithin(livePath);
			}
		}
		for (const livePath of rootEntrySnapshot) {
			if (!currentEntries.has(livePath)) {
				scheduleReconcile(livePath);
				disposeDirectoryWatchersWithin(livePath);
			}
		}
		rootEntrySnapshot = currentEntries;
	};

	const stop = async (): Promise<void> => {
		stopping = true;
		process.off("SIGTERM", handleSigterm);
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (rootReconcileTimer) {
			clearInterval(rootReconcileTimer);
			rootReconcileTimer = undefined;
		}
		if (fullReconcileTimer) {
			clearInterval(fullReconcileTimer);
			fullReconcileTimer = undefined;
		}
		const watchers = [
			...(rootWatcher ? [rootWatcher] : []),
			...directoryWatchers.values(),
		];
		rootWatcher = undefined;
		directoryWatchers.clear();
		for (const watcher of watchers) {
			watcher.closing = true;
			watcher.controller.abort();
		}
		await flush();
		await reconciling;
	};

	const handleSigterm = (): void => {
		stop()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	};

	rootWatcher = watchDirectory(paths.rootPath);
	await reconcileRootEntries("initial");
	await options.repair();
	dirtyScopes.clear();
	if (timer) {
		clearTimeout(timer);
		timer = undefined;
	}
	rootReconcileTimer = setInterval(() => {
		reconcileRootEntries("changes").catch((error: unknown) =>
			options.log(`root reconcile failed: ${String(error)}`),
		);
	}, PERSISTENCE_RECONCILE_INTERVAL_MS);
	rootReconcileTimer.unref();
	fullReconcileTimer = setInterval(() => {
		repairSafely().catch((error: unknown) =>
			options.log(`repair failed: ${String(error)}`),
		);
	}, PERSISTENCE_FULL_RECONCILE_INTERVAL_MS);
	fullReconcileTimer.unref();

	await beat();
	heartbeatTimer = setInterval(() => {
		beat().catch((error: unknown) =>
			options.log(`heartbeat update failed: ${String(error)}`),
		);
	}, PERSISTENCE_HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref();

	process.once("SIGTERM", handleSigterm);

	return {
		stop,
		status: () => lastHeartbeat,
	};
}

function collapseDirtyScopes(scopes: string[]): string[] {
	const collapsed: string[] = [];
	for (const scope of scopes.sort(
		(left, right) => left.length - right.length,
	)) {
		if (collapsed.some((existing) => isSameOrDescendantPath(scope, existing))) {
			continue;
		}
		collapsed.push(scope);
	}
	return collapsed;
}

function isSameOrDescendantPath(path: string, ancestor: string): boolean {
	return (
		path === ancestor ||
		path.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`)
	);
}

async function watchRecursiveContents(
	livePath: string,
	shouldPersist: (livePath: string) => boolean,
	watchDirectory: (livePath: string) => void,
): Promise<void> {
	if (!shouldPersist(livePath)) {
		return;
	}
	let stats;
	try {
		stats = await lstat(livePath);
	} catch {
		return;
	}
	if (!stats.isDirectory()) {
		return;
	}
	watchDirectory(livePath);
	let entries;
	try {
		entries = await readdir(livePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	for (const entry of entries) {
		await watchRecursiveContents(
			join(livePath, entry),
			shouldPersist,
			watchDirectory,
		);
	}
}
