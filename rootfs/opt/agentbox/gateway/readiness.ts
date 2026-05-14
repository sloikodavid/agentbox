import { request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";

// PersistdHeartbeat mirrors the JSON document written by the Go persistd
// daemon. The shape is part of the contract; only required fields are
// validated here so additive fields don't fail the parse.
type PersistdHeartbeatStatus = "ok" | "degraded" | "disabled";
type PersistdHeartbeatMode = "watch" | "restore" | "starting";
interface PersistdHeartbeat {
	readonly updatedAt: string;
	readonly status: PersistdHeartbeatStatus;
	readonly mode: PersistdHeartbeatMode;
	readonly degradedReasons: readonly string[];
}

export interface GatewayHealthCheck {
	readonly name: "code_server" | "persistence";
	readonly status: "pass" | "fail";
	readonly message: string;
}

export interface GatewayHealth {
	readonly ready: boolean;
	readonly status: "ok" | "starting";
	readonly checks: readonly GatewayHealthCheck[];
	readonly readyAt: string | null;
	readonly version: string;
}

export interface GatewayReadinessTimings {
	readonly readinessPollIntervalMs: number;
	readonly codeServerHealthTimeoutMs: number;
	readonly persistenceHeartbeatMaxAgeMs: number;
}

export interface ReadinessMonitor {
	start(): Promise<void>;
	stop(): void;
	health(): GatewayHealth;
}

export interface ReadinessMonitorOptions {
	readonly version: string;
	readonly codeServerOrigin: URL;
	readonly persistenceHeartbeatPath: string;
	readonly timings: GatewayReadinessTimings;
	readonly now?: () => Date;
	readonly log: (message: string) => void;
	readonly onReady: () => void;
}

export function createReadinessMonitor(
	options: ReadinessMonitorOptions,
): ReadinessMonitor {
	const now = options.now ?? (() => new Date());
	let readyAt: Date | null = null;
	let latestChecks: readonly GatewayHealthCheck[] = [];
	let timer: NodeJS.Timeout | undefined;

	async function update(): Promise<void> {
		latestChecks = await collectChecks({ ...options, now });
		const ready = isReady(latestChecks);
		if (ready && !readyAt) {
			readyAt = now();
			options.onReady();
		}
		if (!ready) {
			readyAt = null;
		}
	}

	return {
		async start(): Promise<void> {
			await update();
			timer = setInterval(() => {
				update().catch((error: unknown) =>
					options.log(`health update failed: ${String(error)}`),
				);
			}, options.timings.readinessPollIntervalMs);
		},
		stop(): void {
			if (timer) {
				clearInterval(timer);
			}
			timer = undefined;
		},
		health(): GatewayHealth {
			const ready = isReady(latestChecks);
			return {
				ready,
				status: ready ? "ok" : "starting",
				checks: latestChecks,
				readyAt: readyAt?.toISOString() ?? null,
				version: options.version,
			};
		},
	};
}

interface CollectChecksOptions {
	readonly codeServerOrigin: URL;
	readonly persistenceHeartbeatPath: string;
	readonly timings: GatewayReadinessTimings;
	readonly now: () => Date;
}

async function collectChecks(
	options: CollectChecksOptions,
): Promise<readonly GatewayHealthCheck[]> {
	const [codeServer, persistence] = await Promise.all([
		checkCodeServer(options),
		checkPersistence(options),
	]);
	return [codeServer, persistence];
}

async function checkCodeServer(
	options: CollectChecksOptions,
): Promise<GatewayHealthCheck> {
	const healthUrl = new URL("/healthz", options.codeServerOrigin);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (check: GatewayHealthCheck): void => {
			if (!settled) {
				settled = true;
				resolve(check);
			}
		};
		const request = httpRequest(
			healthUrl,
			{ method: "GET", timeout: options.timings.codeServerHealthTimeoutMs },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer | string) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				response.on("end", () => {
					if (response.statusCode !== 200) {
						finish({
							name: "code_server",
							status: "fail",
							message: `code-server health check returned ${response.statusCode ?? 502}`,
						});
						return;
					}
					const status = readCodeServerHealthStatus(Buffer.concat(chunks));
					finish({
						name: "code_server",
						status: "pass",
						message: status
							? `code-server is accepting connections (${status})`
							: "code-server is accepting connections",
					});
				});
			},
		);
		request.on("timeout", () => {
			request.destroy();
			finish({
				name: "code_server",
				status: "fail",
				message: "code-server timed out",
			});
		});
		request.on("error", () =>
			finish({
				name: "code_server",
				status: "fail",
				message: "code-server is not accepting connections",
			}),
		);
		request.end();
	});
}

function readCodeServerHealthStatus(body: Buffer): string | null {
	try {
		const parsed: unknown = JSON.parse(body.toString("utf8"));
		return typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { readonly status?: unknown }).status === "string"
			? (parsed as { readonly status: string }).status
			: null;
	} catch {
		return null;
	}
}

async function checkPersistence(
	options: CollectChecksOptions,
): Promise<GatewayHealthCheck> {
	try {
		const stats = await stat(options.persistenceHeartbeatPath);
		const ageMs = options.now().getTime() - stats.mtimeMs;
		if (ageMs > options.timings.persistenceHeartbeatMaxAgeMs) {
			return {
				name: "persistence",
				status: "fail",
				message: "persistence heartbeat is stale",
			};
		}
		const heartbeat = await readPersistdHeartbeat(
			options.persistenceHeartbeatPath,
		);
		if (!heartbeat) {
			return {
				name: "persistence",
				status: "fail",
				message: "persistence heartbeat is invalid",
			};
		}
		if (heartbeat.status === "disabled") {
			const reason = heartbeat.degradedReasons[0] ?? "persistence disabled";
			return {
				name: "persistence",
				status: "fail",
				message: `persistence is disabled: ${reason}`,
			};
		}
		return {
			name: "persistence",
			status: "pass",
			message:
				heartbeat.status === "ok"
					? "persistence is healthy"
					: `persistence is degraded: ${heartbeat.degradedReasons[0] ?? "unknown"}`,
		};
	} catch {
		return {
			name: "persistence",
			status: "fail",
			message: "persistence is not ready",
		};
	}
}

async function readPersistdHeartbeat(
	path: string,
): Promise<PersistdHeartbeat | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as PersistdHeartbeat).updatedAt === "string" &&
			typeof (parsed as PersistdHeartbeat).status === "string" &&
			typeof (parsed as PersistdHeartbeat).mode === "string" &&
			Array.isArray((parsed as PersistdHeartbeat).degradedReasons)
		) {
			return parsed as PersistdHeartbeat;
		}
	} catch {
		return null;
	}
	return null;
}

function isReady(checks: readonly GatewayHealthCheck[]): boolean {
	return checks.length > 0 && checks.every((check) => check.status === "pass");
}
