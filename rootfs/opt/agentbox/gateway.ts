import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { parseConfig, type AgentboxConfig } from "./config.ts";
import {
	ROOTFS_HEARTBEAT_MAX_AGE_MS,
	ROOTFS_HEARTBEAT_PATH,
	type RootfsHeartbeat,
} from "./rootfs.ts";

export interface HealthCheck {
	readonly name: "code_server" | "rootfs";
	readonly status: "pass" | "fail";
	readonly message: string;
}

export interface HealthResponse {
	readonly ready: boolean;
	readonly status: "ok" | "starting";
	readonly checks: readonly HealthCheck[];
	readonly readyAt: string | null;
	readonly version: string;
}

export interface Gateway {
	readonly config: AgentboxConfig;
	readonly server: Server;
	startGateway(): Promise<void>;
	stopGateway(): Promise<void>;
	health(): HealthResponse;
}

const CODE_SERVER_TARGET = new URL("http://127.0.0.1:13337");
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const UPSTREAM_UPGRADE_TIMEOUT_MS = 5_000;

export function createGateway(config = parseConfig()): Gateway {
	let readyAt: Date | null = null;
	let latestChecks: readonly HealthCheck[] = [];
	let healthTimer: NodeJS.Timeout | undefined;
	const sockets = new Set<Socket>();

	const server =
		config.tlsKey && config.tlsCert
			? createHttpsServer(
					{ key: config.tlsKey, cert: config.tlsCert },
					(request, response) => handleRequest(request, response),
				)
			: createHttpServer((request, response) =>
					handleRequest(request, response),
				);

	server.on("connection", (socket) => {
		if (socket instanceof Socket) {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		}
	});

	server.on("upgrade", (request, socket, head) =>
		handleUpgrade(request, socket, head),
	);

	async function updateHealth(): Promise<void> {
		latestChecks = await collectChecks();
		const ready = isReady(latestChecks);
		if (ready && !readyAt) {
			readyAt = new Date();
			logReady(config);
		}
		if (!ready) {
			readyAt = null;
		}
	}

	async function startGateway(): Promise<void> {
		await updateHealth();
		await listen(server, config.port, config.bindAddress);
		healthTimer = setInterval(() => {
			updateHealth().catch((error: unknown) =>
				log(`health update failed: ${String(error)}`),
			);
		}, 1_000);
		log(`listening on ${config.bindAddress}:${config.port}`);
	}

	async function stopGateway(): Promise<void> {
		if (healthTimer) {
			clearInterval(healthTimer);
			healthTimer = undefined;
		}
		if (!server.listening) {
			destroySockets();
			return;
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			destroySockets();
		});
	}

	function health(): HealthResponse {
		const ready = isReady(latestChecks);
		return {
			ready,
			status: ready ? "ok" : "starting",
			checks: latestChecks,
			readyAt: readyAt?.toISOString() ?? null,
			version: config.buildVersion,
		};
	}

	function destroySockets(): void {
		for (const socket of sockets) {
			socket.destroy();
		}
	}

	function handleRequest(
		request: IncomingMessage,
		response: ServerResponse,
	): void {
		try {
			const url = parseRequestUrl(request);
			const healthUrlPath = joinUrlPath(config.publicUrlPath, "/healthz");
			const readinessUrlPath = joinUrlPath(healthUrlPath, "/readiness");
			const metricsUrlPath = joinUrlPath(config.publicUrlPath, "/metrics");
			if (url.pathname === healthUrlPath || url.pathname === readinessUrlPath) {
				sendJson(
					response,
					url.pathname === healthUrlPath ? 200 : health().ready ? 200 : 503,
					health(),
				);
				return;
			}

			if (url.pathname === metricsUrlPath) {
				if (!config.enableMetrics) {
					sendText(response, 404, "not found\n");
					return;
				}
				sendText(response, 200, `agentbox_ready ${health().ready ? 1 : 0}\n`);
				return;
			}

			if (!health().ready) {
				response.setHeader("Retry-After", "1");
				if (acceptsHtml(request)) {
					sendStartingPage(
						response,
						joinUrlPath(config.publicUrlPath, "/healthz/readiness"),
					);
				} else {
					sendText(response, 503, "Agentbox is starting\n");
				}
				return;
			}

			proxyHttp(config, request, response, url);
		} catch (error) {
			log(`request failed: ${String(error)}`);
			sendText(response, 500, "internal server error\n");
		}
	}

	function handleUpgrade(
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	): void {
		if (!health().ready) {
			writeUpgradeError(
				socket,
				503,
				"Service Unavailable",
				"Agentbox is starting\n",
			);
			return;
		}

		const url = parseRequestUrl(request);
		const target = proxyTarget(config, request, url);
		if (!target) {
			writeUpgradeError(socket, 404, "Not Found", "not found\n");
			return;
		}
		const headers = {
			...target.headers,
			connection: "upgrade",
			upgrade: request.headers.upgrade ?? "websocket",
		};
		let settled = false;
		const failUpgrade = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			writeUpgradeError(socket, 502, "Bad Gateway", "bad gateway\n");
		};

		const proxyRequest = httpRequest(
			{
				host: CODE_SERVER_TARGET.hostname,
				port: Number(CODE_SERVER_TARGET.port),
				path: `${target.path}${url.search}`,
				method: request.method,
				headers,
			},
			(proxyResponse) => {
				if (settled) {
					proxyResponse.resume();
					return;
				}
				settled = true;
				writeRawResponseHead(
					socket,
					proxyResponse.httpVersion,
					proxyResponse.statusCode ?? 502,
					proxyResponse.statusMessage ?? "Bad Gateway",
					filterHeaders(proxyResponse.headers),
				);
				proxyResponse.pipe(socket);
			},
		);

		proxyRequest.setTimeout(UPSTREAM_UPGRADE_TIMEOUT_MS, () => {
			failUpgrade();
			proxyRequest.destroy();
		});
		proxyRequest.on("upgrade", (proxyResponse, proxySocket, proxyHead) => {
			if (settled) {
				proxySocket.destroy();
				return;
			}
			settled = true;
			writeRawResponseHead(
				socket,
				proxyResponse.httpVersion,
				proxyResponse.statusCode ?? 101,
				proxyResponse.statusMessage ?? "Switching Protocols",
				proxyResponse.headers,
			);
			if (proxyHead.length > 0) {
				socket.write(proxyHead);
			}
			if (head.length > 0) {
				proxySocket.write(head);
			}
			proxySocket.pipe(socket);
			socket.pipe(proxySocket);
			proxySocket.on("error", () => socket.destroy());
			socket.on("error", () => proxySocket.destroy());
		});

		proxyRequest.on("error", () => {
			failUpgrade();
		});
		proxyRequest.end();
	}

	async function collectChecks(): Promise<readonly HealthCheck[]> {
		const [codeServer, rootfs] = await Promise.all([
			checkCodeServer(),
			checkRootfs(),
		]);
		return [codeServer, rootfs];
	}

	return { config, server, startGateway, stopGateway, health };
}

async function checkCodeServer(): Promise<HealthCheck> {
	return new Promise((resolve) => {
		const request = httpRequest(
			"http://127.0.0.1:13337/healthz",
			{ method: "GET", timeout: 1_000 },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer | string) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				response.on("end", () => {
					if (response.statusCode !== 200) {
						resolve({
							name: "code_server",
							status: "fail",
							message: `code-server health check returned ${response.statusCode ?? 502}`,
						});
						return;
					}
					const status = readCodeServerHealthStatus(Buffer.concat(chunks));
					resolve({
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
			resolve({
				name: "code_server",
				status: "fail",
				message: "code-server timed out",
			});
		});
		request.on("error", () =>
			resolve({
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

async function checkRootfs(): Promise<HealthCheck> {
	try {
		const stats = await stat(ROOTFS_HEARTBEAT_PATH);
		const ageMs = Date.now() - stats.mtimeMs;
		if (ageMs > ROOTFS_HEARTBEAT_MAX_AGE_MS) {
			return {
				name: "rootfs",
				status: "fail",
				message: "rootfs store heartbeat is stale",
			};
		}
		const heartbeat = await readRootfsHeartbeat();
		if (!heartbeat) {
			return {
				name: "rootfs",
				status: "fail",
				message: "rootfs store heartbeat is invalid",
			};
		}
		if (heartbeat.watcherCount < 1) {
			return {
				name: "rootfs",
				status: "fail",
				message: "rootfs store watcher is not running",
			};
		}
		const failedWatcher = heartbeat.failedWatchers[0];
		if (failedWatcher) {
			return {
				name: "rootfs",
				status: "fail",
				message: `rootfs store watcher failed for ${failedWatcher.path}`,
			};
		}
		return {
			name: "rootfs",
			status: "pass",
			message: "rootfs store is healthy",
		};
	} catch {
		return {
			name: "rootfs",
			status: "fail",
			message: "rootfs store is not ready",
		};
	}
}

async function readRootfsHeartbeat(): Promise<RootfsHeartbeat | null> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(ROOTFS_HEARTBEAT_PATH, "utf8"),
		);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as RootfsHeartbeat).updatedAt === "string" &&
			typeof (parsed as RootfsHeartbeat).watcherCount === "number" &&
			Array.isArray((parsed as RootfsHeartbeat).failedWatchers)
		) {
			return parsed as RootfsHeartbeat;
		}
	} catch {
		return null;
	}
	return null;
}

function isReady(checks: readonly HealthCheck[]): boolean {
	return checks.length > 0 && checks.every((check) => check.status === "pass");
}

function parseRequestUrl(request: IncomingMessage): URL {
	return new URL(request.url ?? "/", "http://agentbox.internal");
}

function stripPublicUrlPath(
	pathname: string,
	publicUrlPath: string,
): string | null {
	if (publicUrlPath === "/") {
		return pathname;
	}
	if (pathname === publicUrlPath) {
		return "/";
	}
	if (pathname.startsWith(`${publicUrlPath}/`)) {
		return pathname.slice(publicUrlPath.length);
	}
	return null;
}

interface ProxyTarget {
	readonly path: string;
	readonly headers: Record<string, string | string[]>;
}

function proxyTarget(
	config: AgentboxConfig,
	request: IncomingMessage,
	url: URL,
): ProxyTarget | null {
	const portProxyHost = isPortProxyHost(config, request);
	const path = portProxyHost
		? url.pathname
		: stripPublicUrlPath(url.pathname, config.publicUrlPath);
	if (path === null) return null;

	const headers = filterHeaders(request.headers);
	const forwarded = forwardedHeaders(config, request);
	headers.host = forwarded["x-forwarded-host"];
	Object.assign(headers, forwarded);
	if (config.publicUrlPath !== "/" && !portProxyHost) {
		headers["x-forwarded-prefix"] = config.publicUrlPath;
	}
	return { path, headers };
}

function proxyHttp(
	config: AgentboxConfig,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): void {
	const target = proxyTarget(config, request, url);
	if (!target) {
		sendText(response, 404, "not found\n");
		return;
	}

	const proxyRequest = httpRequest(
		{
			host: CODE_SERVER_TARGET.hostname,
			port: Number(CODE_SERVER_TARGET.port),
			path: `${target.path}${url.search}`,
			method: request.method,
			headers: target.headers,
		},
		(proxyResponse) => {
			response.writeHead(
				proxyResponse.statusCode ?? 502,
				filterHeaders(proxyResponse.headers),
			);
			proxyResponse.pipe(response);
		},
	);

	proxyRequest.on("error", (error) => {
		log(`proxy failed: ${String(error)}`);
		if (!response.headersSent) {
			sendText(response, 502, "bad gateway\n");
		} else {
			response.destroy();
		}
	});

	request.pipe(proxyRequest);
}

function filterHeaders(
	headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
	const filtered: Record<string, string | string[]> = {};
	const connectionTokens = new Set(
		String(
			Array.isArray(headers.connection)
				? headers.connection.join(",")
				: (headers.connection ?? ""),
		)
			.split(",")
			.map((token) => token.trim().toLowerCase())
			.filter(Boolean),
	);
	for (const [name, value] of Object.entries(headers)) {
		const lowerName = name.toLowerCase();
		if (
			!HOP_BY_HOP_HEADERS.has(lowerName) &&
			!connectionTokens.has(lowerName) &&
			!lowerName.startsWith("x-forwarded-") &&
			value !== undefined
		) {
			filtered[name] = value;
		}
	}
	return filtered;
}

interface ForwardedHeaders {
	readonly "x-forwarded-host": string;
	readonly "x-forwarded-proto": string;
}

function forwardedHeaders(
	config: AgentboxConfig,
	request: IncomingMessage,
): ForwardedHeaders {
	const publicUrl = new URL(config.publicUrl);
	const trustedHost =
		getTrustedForwardedHeader(
			request.headers["x-forwarded-host"],
			config.trustedProxyHops,
		) ??
		request.headers.host ??
		publicUrl.host;
	const trustedProto =
		getTrustedForwardedHeader(
			request.headers["x-forwarded-proto"],
			config.trustedProxyHops,
		) ?? publicUrl.protocol.replace(/:$/, "");
	return {
		"x-forwarded-host": trustedHost,
		"x-forwarded-proto": trustedProto,
	};
}

function isPortProxyHost(
	config: AgentboxConfig,
	request: IncomingMessage,
): boolean {
	const host = hostWithoutPort(request.headers.host)?.toLowerCase();
	return Boolean(
		host &&
		config.proxyDomain &&
		proxyHostPattern(config.proxyDomain.toLowerCase()).test(host),
	);
}

function getTrustedForwardedHeader(
	value: string | string[] | undefined,
	trustedProxyHops: number,
): string | undefined {
	if (trustedProxyHops <= 0 || !value) {
		return undefined;
	}
	const values = (Array.isArray(value) ? value.join(",") : value)
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (values.length === 0) {
		return undefined;
	}
	return values[Math.max(values.length - trustedProxyHops, 0)];
}

function writeRawResponseHead(
	socket: Duplex,
	httpVersion: string,
	statusCode: number,
	statusMessage: string,
	headers: IncomingMessage["headers"],
): void {
	socket.write(`HTTP/${httpVersion} ${statusCode} ${statusMessage}\r\n`);
	for (const [name, value] of Object.entries(headers)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item !== undefined) {
				socket.write(`${name}: ${sanitizeHeaderValue(item)}\r\n`);
			}
		}
	}
	socket.write("\r\n");
}

function sanitizeHeaderValue(value: string): string {
	return value.replaceAll(/[\r\n]/g, " ");
}

function hostWithoutPort(value: string | string[] | undefined): string | null {
	const host = Array.isArray(value) ? value[0] : value;
	if (!host) return null;
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end === -1 ? host : host.slice(0, end + 1);
	}
	return host.split(":")[0] ?? null;
}

function proxyHostPattern(proxyDomain: string): RegExp {
	const escaped = proxyDomain.split("{{port}}").map(escapeRegex).join("\\d+");
	return new RegExp(`^${escaped}$`);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeUpgradeError(
	socket: Duplex,
	statusCode: number,
	statusMessage: string,
	body: string,
): void {
	if (socket.destroyed || socket.writableEnded) {
		return;
	}
	socket.write(
		`HTTP/1.1 ${statusCode} ${statusMessage}\r\n` +
			"Connection: close\r\n" +
			"Content-Type: text/plain; charset=utf-8\r\n" +
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
			body,
	);
	socket.end();
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	body: unknown,
): void {
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
	});
	response.end(`${JSON.stringify(body)}\n`);
}

function sendText(
	response: ServerResponse,
	statusCode: number,
	body: string,
): void {
	response.writeHead(statusCode, {
		"content-type": "text/plain; charset=utf-8",
	});
	response.end(body);
}

function acceptsHtml(request: IncomingMessage): boolean {
	const accept = request.headers.accept;
	return (Array.isArray(accept) ? accept.join(",") : (accept ?? ""))
		.toLowerCase()
		.includes("text/html");
}

function sendStartingPage(
	response: ServerResponse,
	readinessPath: string,
): void {
	const body = `<style>body{font-family:monospace;white-space:pre}</style>Agentbox is starting
<script>
const readinessPath = ${JSON.stringify(readinessPath)};
async function waitUntilReady() {
	try {
		if ((await fetch(readinessPath, { cache: "no-store" })).ok) {
			location.reload();
			return;
		}
	} catch {}
	setTimeout(waitUntilReady, 1000);
}
waitUntilReady();
</script>
`;
	response.writeHead(503, {
		"cache-control": "no-store",
		"content-type": "text/html; charset=utf-8",
	});
	response.end(body);
}

function logReady(config: AgentboxConfig): void {
	log(`Agentbox is ready.\nURL:\n${config.publicUrl}`);
}

function log(message: string): void {
	console.log(`[agentbox-gateway] ${message}`);
}

function joinUrlPath(publicUrlPath: string, path: string): string {
	if (publicUrlPath === "/") {
		return path;
	}
	return `${publicUrlPath}${path}`;
}

async function listen(
	server: Server,
	port: number,
	bindAddress: string,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			server.off("error", onError);
			server.off("listening", onListening);
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onListening = (): void => {
			cleanup();
			resolve();
		};
		server.once("error", onError);
		server.listen(port, bindAddress, onListening);
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const gateway = createGateway();
	process.on("SIGTERM", () => {
		gateway
			.stopGateway()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	});
	await gateway.startGateway().catch((error: unknown) => {
		log(`startup failed: ${String(error)}`);
		process.exit(1);
	});
}
