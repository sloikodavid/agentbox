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
	rootfsHeartbeatMaxAgeMs,
	rootfsHeartbeatPath,
	type RootfsHeartbeat,
} from "./rootfs.ts";

export interface HealthCheck {
	readonly name: "agentbox" | "code_server" | "rootfs";
	readonly status: "pass" | "fail";
	readonly message: string;
}

export interface HealthResponse {
	readonly ready: boolean;
	readonly status: "ok" | "starting" | "error";
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

const codeServerTarget = new URL("http://127.0.0.1:13337");
const hopByHopHeaders = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const upstreamUpgradeTimeoutMs = 5_000;

export function createGateway(config = parseConfig()): Gateway {
	let readyAt: Date | null = null;
	let latestChecks: readonly HealthCheck[] = [];
	let healthTimer: NodeJS.Timeout | undefined;
	const sockets = new Set<Socket>();

	const server =
		config.protocol === "https"
			? createHttpsServer(
					{ key: config.sslKey, cert: config.sslCert },
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
		healthTimer = setInterval(() => {
			updateHealth().catch((error: unknown) =>
				log(`health update failed: ${String(error)}`),
			);
		}, 1_000);
		await new Promise<void>((resolve) => {
			server.listen(config.port, config.listenAddress, resolve);
		});
		log(`listening on ${config.listenAddress}:${config.port}`);
	}

	async function stopGateway(): Promise<void> {
		if (healthTimer) {
			clearInterval(healthTimer);
			healthTimer = undefined;
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			for (const socket of sockets) {
				socket.destroy();
			}
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

	function handleRequest(
		request: IncomingMessage,
		response: ServerResponse,
	): void {
		try {
			const url = parseRequestUrl(request);
			const healthPath = joinUrlPath(config.basePath, config.healthPath);
			const metricsPath = joinUrlPath(config.basePath, "/metrics");
			if (
				url.pathname === healthPath ||
				url.pathname === `${healthPath}/readiness`
			) {
				sendJson(
					response,
					url.pathname === healthPath ? 200 : health().ready ? 200 : 503,
					health(),
				);
				return;
			}

			if (url.pathname === metricsPath) {
				if (!config.enableMetrics) {
					sendText(response, 404, "not found\n");
					return;
				}
				sendText(response, 200, `agentbox_ready ${health().ready ? 1 : 0}\n`);
				return;
			}

			if (!health().ready) {
				response.setHeader("Retry-After", "1");
				sendText(response, 503, "Agentbox is starting\n");
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
		const portProxyHost = isPortProxyHost(config, request);
		const proxiedPath = portProxyHost
			? url.pathname
			: stripPrefix(url.pathname, config.basePath);
		if (proxiedPath === null) {
			writeUpgradeError(socket, 404, "Not Found", "not found\n");
			return;
		}

		const headers = filterHeaders(request.headers);
		const forwarded = forwardedHeaders(config, request);
		headers.host = String(forwarded["x-forwarded-host"]);
		Object.assign(headers, forwarded);
		headers.connection = "upgrade";
		headers.upgrade = request.headers.upgrade ?? "websocket";
		if (config.basePath !== "/" && !portProxyHost) {
			headers["x-forwarded-prefix"] = config.basePath;
		}
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
				host: codeServerTarget.hostname,
				port: Number(codeServerTarget.port),
				path: `${proxiedPath}${url.search}`,
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

		proxyRequest.setTimeout(upstreamUpgradeTimeoutMs, () => {
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
		return [
			{
				name: "agentbox",
				status: "pass",
				message: "Agentbox is accepting connections",
			},
			codeServer,
			rootfs,
		];
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
		const stats = await stat(rootfsHeartbeatPath);
		const ageMs = Date.now() - stats.mtimeMs;
		if (ageMs > rootfsHeartbeatMaxAgeMs) {
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
			await readFile(rootfsHeartbeatPath, "utf8"),
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

function stripPrefix(pathname: string, prefix: string): string | null {
	if (prefix === "/") {
		return pathname;
	}
	if (pathname === prefix) {
		return "/";
	}
	if (pathname.startsWith(`${prefix}/`)) {
		return pathname.slice(prefix.length);
	}
	return null;
}

function proxyHttp(
	config: AgentboxConfig,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): void {
	const portProxyHost = isPortProxyHost(config, request);
	const proxiedPath = portProxyHost
		? url.pathname
		: stripPrefix(url.pathname, config.basePath);
	if (proxiedPath === null) {
		sendText(response, 404, "not found\n");
		return;
	}

	const headers = filterHeaders(request.headers);
	const forwarded = forwardedHeaders(config, request);
	headers.host = String(forwarded["x-forwarded-host"]);
	Object.assign(headers, forwarded);
	if (config.basePath !== "/" && !portProxyHost) {
		headers["x-forwarded-prefix"] = config.basePath;
	}

	const proxyRequest = httpRequest(
		{
			host: codeServerTarget.hostname,
			port: Number(codeServerTarget.port),
			path: `${proxiedPath}${url.search}`,
			method: request.method,
			headers,
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
			!hopByHopHeaders.has(lowerName) &&
			!connectionTokens.has(lowerName) &&
			!lowerName.startsWith("x-forwarded-") &&
			value !== undefined
		) {
			filtered[name] = value;
		}
	}
	return filtered;
}

function forwardedHeaders(
	config: AgentboxConfig,
	request: IncomingMessage,
): Record<string, string | string[]> {
	const trustedHost =
		getTrustedForwardedHeader(
			request.headers["x-forwarded-host"],
			config.proxyHops,
		) ??
		request.headers.host ??
		config.host;
	const trustedProto =
		getTrustedForwardedHeader(
			request.headers["x-forwarded-proto"],
			config.proxyHops,
		) ?? config.protocol;
	return {
		"x-forwarded-host": trustedHost,
		"x-forwarded-proto": trustedProto,
	};
}

function isPortProxyHost(
	config: AgentboxConfig,
	request: IncomingMessage,
): boolean {
	if (!config.proxyDomain) {
		return false;
	}
	const host = String(request.headers.host ?? "")
		.split(":")[0]
		?.toLowerCase();
	const domain = config.proxyDomain.toLowerCase();
	if (!host?.endsWith(`.${domain}`)) {
		return false;
	}
	const portLabel = host.slice(0, -domain.length - 1);
	return /^\d+$/.test(portLabel);
}

function getTrustedForwardedHeader(
	value: string | string[] | undefined,
	proxyHops: number,
): string | undefined {
	if (proxyHops <= 0 || !value) {
		return undefined;
	}
	const values = (Array.isArray(value) ? value.join(",") : value)
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (values.length === 0) {
		return undefined;
	}
	return values[Math.max(values.length - proxyHops, 0)];
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

function logReady(config: AgentboxConfig): void {
	log(`Agentbox is ready.\nOpen Agentbox at:\n${config.url}`);
}

function log(message: string): void {
	console.log(`[agentbox-gateway] ${message}`);
}

function joinUrlPath(basePath: string, path: string): string {
	if (basePath === "/") {
		return path;
	}
	return `${basePath}${path}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const gateway = createGateway();
	process.on("SIGTERM", () => {
		gateway
			.stopGateway()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	});
	await gateway.startGateway();
}
