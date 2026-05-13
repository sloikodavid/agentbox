export interface PersistenceOptions {
	readonly volumePath?: string;
	readonly rootPath?: string;
	readonly heartbeatPath?: string;
}

export interface PersistenceWatcherFailure {
	readonly path: string;
	readonly message: string;
}

export interface PersistenceHeartbeat {
	readonly updatedAt: string;
	readonly watcherCount: number;
	readonly failedWatchers: readonly PersistenceWatcherFailure[];
}

export type PersistenceChange =
	| { readonly type: "present"; readonly livePath: string }
	| { readonly type: "removed"; readonly livePath: string };

export interface PersistenceWatcher {
	readonly stop: () => Promise<void>;
	readonly status: () => PersistenceHeartbeat;
}

export interface Persistence {
	readonly restore: () => Promise<void>;
	readonly record: (change: PersistenceChange) => Promise<void>;
	readonly reconcile: (livePath?: string) => Promise<void>;
	readonly watch: () => Promise<PersistenceWatcher>;
	readonly shouldPersist: (livePath: string) => boolean;
}
