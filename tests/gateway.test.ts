import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
	createGatewayServer,
	type GatewayServer,
} from "../rootfs/opt/agentbox/gateway/index.ts";
import type { AgentboxConfig } from "../rootfs/opt/agentbox/config.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];
const gateways: GatewayServer[] = [];

afterEach(async () => {
	await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("createGatewayServer", () => {
	test("reports health shape before dependencies are checked", async () => {
		const heartbeatPath = await tempHeartbeatPath();
		const gateway = createGatewayServer(config(), {
			persistenceHeartbeatPath: heartbeatPath,
			log: () => {},
		});
		const health = gateway.health();
		expect(health.ready).toBe(false);
		expect(health.status).toBe("starting");
		expect(health.version).toBe("test");
		expect(health.checks).toEqual([]);
	});

	test("can start and stop a listener", async () => {
		const harness = await startGatewayHarness({ ready: false });
		expect(harness.gateway.server.listening).toBe(true);
		await harness.gateway.stop();
		expect(harness.gateway.server.listening).toBe(false);
	});

	test("can stop before it starts", async () => {
		const heartbeatPath = await tempHeartbeatPath();
		const gateway = createGatewayServer(config({ port: 0 }), {
			persistenceHeartbeatPath: heartbeatPath,
			log: () => {},
		});
		await gateway.stop();
		expect(gateway.server.listening).toBe(false);
	});

	test("serves fixed health endpoint under the public base URL path", async () => {
		const harness = await startGatewayHarness({
			config: { publicUrl: "http://localhost:8080/agentbox" },
		});

		const health = await harness.fetch("/agentbox/healthz");
		expect(health.status).toBe(200);
		const body = (await health.json()) as { readonly ready: boolean };
		expect(body.ready).toBe(true);
		expect((await harness.fetch("/agentbox/healthz/readiness")).status).toBe(
			200,
		);
		expect((await harness.fetch("/healthz")).status).toBe(404);
	});

	test("returns unavailable readiness status while dependencies are starting", async () => {
		const harness = await startGatewayHarness({
			ready: false,
			config: { publicUrl: "http://localhost:8080/agentbox" },
		});

		const response = await harness.fetch("/agentbox/healthz/readiness");
		expect(response.status).toBe(503);
		const body = (await response.json()) as { readonly ready: boolean };
		expect(body.ready).toBe(false);
	});

	test("proxies prefixed requests when ready", async () => {
		const harness = await startGatewayHarness({
			config: { publicUrl: "http://localhost:8080/agentbox" },
			codeServerRequest(request, response) {
				const prefix = request.headers["x-forwarded-prefix"];
				response.end(
					`proxied:${request.url}:${Array.isArray(prefix) ? prefix.join(",") : (prefix ?? "")}`,
				);
			},
		});

		expect(await harness.text("/agentbox/path?q=1")).toContain(
			"proxied:/path?q=1:/agentbox",
		);
		expect((await harness.fetch("/agentbox2/path")).status).toBe(404);
	});

	test("rejects requests outside the public base URL path before readiness gating", async () => {
		const harness = await startGatewayHarness({
			ready: false,
			config: { publicUrl: "http://localhost:8080/agentbox" },
		});

		expect(
			(
				await harness.fetch("/wrong-prefix", {
					headers: { accept: "text/html" },
				})
			).status,
		).toBe(404);
	});

	test("serves an auto-continuing starting page for browsers", async () => {
		const harness = await startGatewayHarness({
			ready: false,
			config: { publicUrl: "http://localhost:8080/agentbox" },
		});

		const response = await harness.fetch("/agentbox/", {
			headers: { accept: "text/html" },
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("content-type")).toContain("text/html");
		const body = await response.text();
		expect(body).toContain("Agentbox is starting");
		expect(body).toContain("/agentbox/healthz/readiness");
		expect(body).toContain("location.reload()");
	});

	test("keeps the starting response plain text for non-browser clients", async () => {
		const harness = await startGatewayHarness({ ready: false });

		const response = await harness.fetch("/", {
			headers: { accept: "application/json" },
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(await response.text()).toBe("Agentbox is starting\n");
	});

	test("serves metrics under the public base URL path when metrics are not disabled", async () => {
		const harness = await startGatewayHarness({
			config: {
				publicUrl: "http://localhost:8080/agentbox",
				disableMetrics: false,
			},
		});

		expect(await harness.text("/agentbox/metrics")).toBe("agentbox_ready 1\n");
		expect((await harness.fetch("/metrics")).status).toBe(404);
	});

	test("does not serve metrics by default", async () => {
		const harness = await startGatewayHarness({
			config: { publicUrl: "http://localhost:8080/agentbox" },
		});

		expect((await harness.fetch("/agentbox/metrics")).status).toBe(404);
	});

	test("preserves websocket upgrade handshakes", async () => {
		let upstreamUrl = "";
		let forwardedPrefix = "";
		const harness = await startGatewayHarness({
			config: { publicUrl: "http://localhost:8080/agentbox" },
			codeServerUpgrade(request, socket) {
				upstreamUrl = request.url ?? "";
				forwardedPrefix = headerValue(request.headers["x-forwarded-prefix"]);
				const key = request.headers["sec-websocket-key"];
				if (typeof key !== "string") {
					socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
					return;
				}
				const accept = createHash("sha1")
					.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
					.digest("base64");
				socket.end(
					"HTTP/1.1 101 Switching Protocols\r\n" +
						"Upgrade: websocket\r\n" +
						"Connection: Upgrade\r\n" +
						`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
				);
			},
		});

		const response = await harness.rawUpgrade("/agentbox/ws?x=1");
		expect(response).toContain("HTTP/1.1 101 Switching Protocols");
		expect(response.toLowerCase()).toContain("upgrade: websocket");
		expect(response.toLowerCase()).toContain("connection: upgrade");
		expect(upstreamUrl).toBe("/ws?x=1");
		expect(forwardedPrefix).toBe("/agentbox");
	});

	test("strips hop-by-hop and untrusted forwarded request headers", async () => {
		const harness = await startGatewayHarness({
			codeServerRequest(request, response) {
				response.end(
					[
						headerValue(request.headers["x-remove"]),
						headerValue(request.headers["x-forwarded-host"]),
						headerValue(request.headers["x-forwarded-proto"]),
					].join(":"),
				);
			},
		});

		expect(
			await harness.requestText("/", "box.example.com", {
				connection: "keep-alive, x-remove",
				"x-remove": "nope",
				"x-forwarded-host": "evil.example",
				"x-forwarded-proto": "https",
			}),
		).toBe(":box.example.com:http");
	});

	test("forwards trusted proxy hop headers", async () => {
		const harness = await startGatewayHarness({
			config: { trustedProxyHops: 1 },
			codeServerRequest(request, response) {
				const forwardedHost = headerValue(request.headers["x-forwarded-host"]);
				const forwardedProto = headerValue(
					request.headers["x-forwarded-proto"],
				);
				response.end(`${forwardedHost}:${forwardedProto}`);
			},
		});

		const response = await harness.fetch("/", {
			headers: {
				"x-forwarded-host": "client.example, proxy.example",
				"x-forwarded-proto": "https, http",
			},
		});
		expect(await response.text()).toBe("proxy.example:http");
	});

	test("preserves the public hostname for code-server proxying", async () => {
		const harness = await startGatewayHarness({
			codeServerRequest(request, response) {
				response.end(headerValue(request.headers.host));
			},
		});

		expect(await harness.requestText("/", "3000.box.example.com")).toBe(
			"3000.box.example.com",
		);
	});

	test("lets public proxy hostnames bypass the public base URL path", async () => {
		const harness = await startGatewayHarness({
			config: {
				publicUrl: "http://localhost:8080/agentbox",
				publicProxyUrlTemplate: "https://{{port}}.box.example.com",
			},
			codeServerRequest(request, response) {
				response.end(
					`${request.url}:${headerValue(request.headers["x-forwarded-prefix"])}`,
				);
			},
		});

		expect(await harness.requestText("/hook", "8787.box.example.com")).toBe(
			"/hook:",
		);
	});

	test("matches patterned port-template hosts", async () => {
		const harness = await startGatewayHarness({
			config: {
				publicUrl: "http://localhost:8080/agentbox",
				publicProxyUrlTemplate: "https://code-{{port}}.box.example.com",
			},
			codeServerRequest(request, response) {
				response.end(
					`${request.url}:${headerValue(request.headers["x-forwarded-prefix"])}`,
				);
			},
		});

		expect(
			await harness.requestText("/hook", "code-8787.box.example.com"),
		).toBe("/hook:");
		expect(await harness.requestText("/agentbox/hook", "box.example.com")).toBe(
			"/hook:/agentbox",
		);
	});

	test("ignores untrusted forwarded headers when proxy hops are disabled", async () => {
		const harness = await startGatewayHarness({
			config: { trustedProxyHops: 0 },
			codeServerRequest(request, response) {
				const forwardedHost = headerValue(request.headers["x-forwarded-host"]);
				const forwardedProto = headerValue(
					request.headers["x-forwarded-proto"],
				);
				response.end(`${forwardedHost}:${forwardedProto}`);
			},
		});

		const response = await harness.fetch("/", {
			headers: {
				"x-forwarded-host": "evil.example",
				"x-forwarded-proto": "https",
			},
		});
		const body = await response.text();
		expect(body).toContain(`127.0.0.1:${harness.port}`);
		expect(body).toContain(":http");
		expect(body).not.toContain("evil.example");
	});

	test("rejects websocket upgrades outside the public base URL path before readiness gating", async () => {
		const harness = await startGatewayHarness({
			ready: false,
			config: { publicUrl: "http://localhost:8080/agentbox" },
		});

		const response = await harness.rawUpgrade("/outside/ws");
		expect(response).toContain("HTTP/1.1 404 Not Found");
	});

	test("returns upstream non-upgrade responses for rejected websocket handshakes", async () => {
		const harness = await startGatewayHarness({
			codeServerUpgrade(_request, socket) {
				socket.end(
					"HTTP/1.1 403 Forbidden\r\n" +
						"Connection: close\r\n" +
						"X-Blocked: yes\r\n" +
						"Content-Length: 8\r\n\r\n" +
						"rejected",
				);
			},
		});

		const response = await harness.rawUpgrade("/ws");
		expect(response).toContain("HTTP/1.1 403 Forbidden");
		expect(response.toLowerCase()).toContain("x-blocked: yes");
	});

	test("allows readiness when code-server is idle but accepting connections", async () => {
		const harness = await startGatewayHarness({ healthStatus: "expired" });

		expect(harness.gateway.health().ready).toBe(true);
		expect(harness.gateway.health().checks).toContainEqual({
			name: "code_server",
			status: "pass",
			message: "code-server is accepting connections (expired)",
		});
	});

	test("fails readiness when the persistence heartbeat is stale", async () => {
		const heartbeatPath = await tempHeartbeatPath();
		await writePersistenceHeartbeat(heartbeatPath);
		const stale = new Date(Date.now() - 60_000);
		await utimes(heartbeatPath, stale, stale);
		const harness = await startGatewayHarness({
			ready: false,
			heartbeatPath,
		});

		const health = harness.gateway.health();
		expect(health.ready).toBe(false);
		expect(health.checks).toContainEqual({
			name: "persistence",
			status: "fail",
			message: "persistence heartbeat is stale",
		});
	});

	test("fails readiness when persistence reports status=disabled", async () => {
		const heartbeatPath = await tempHeartbeatPath();
		await writePersistenceHeartbeat(heartbeatPath, {
			status: "disabled",
			degradedReasons: ["restore failed"],
		});
		const harness = await startGatewayHarness({
			ready: false,
			heartbeatPath,
		});

		expect(harness.gateway.health().ready).toBe(false);
		expect(harness.gateway.health().checks).toContainEqual({
			name: "persistence",
			status: "fail",
			message: "persistence is disabled: restore failed",
		});
	});

	test("passes readiness when persistence is degraded (audit backlog is not readiness fail)", async () => {
		const heartbeatPath = await tempHeartbeatPath();
		await writePersistenceHeartbeat(heartbeatPath, {
			status: "degraded",
			degradedReasons: ["audit backlog growing"],
		});
		const harness = await startGatewayHarness({
			ready: true,
			heartbeatPath,
		});

		expect(harness.gateway.health().ready).toBe(true);
	});
});

interface GatewayHarness {
	readonly gateway: GatewayServer;
	readonly port: number;
	fetch(path: string, init?: RequestInit): Promise<Response>;
	text(path: string, init?: RequestInit): Promise<string>;
	requestText(
		path: string,
		host: string,
		headers?: Record<string, string>,
	): Promise<string>;
	rawUpgrade(path: string): Promise<string>;
}

interface GatewayHarnessOptions {
	readonly ready?: boolean;
	readonly heartbeatPath?: string;
	readonly healthStatus?: string;
	readonly config?: Partial<AgentboxConfig>;
	readonly codeServerRequest?: (
		request: IncomingMessage,
		response: ServerResponse,
	) => void;
	readonly codeServerUpgrade?: (
		request: IncomingMessage,
		socket: Socket,
		head: Buffer,
	) => void;
}

async function startGatewayHarness(
	options: GatewayHarnessOptions = {},
): Promise<GatewayHarness> {
	const heartbeatPath = options.heartbeatPath ?? (await tempHeartbeatPath());
	if (options.ready ?? true) {
		await writePersistenceHeartbeat(heartbeatPath);
	}
	const codeServer = createServer((request, response) => {
		if (
			sendCodeServerHealth(request, response, options.healthStatus ?? "alive")
		) {
			return;
		}
		if (options.codeServerRequest) {
			options.codeServerRequest(request, response);
			return;
		}
		response.end("ok");
	});
	if (options.codeServerUpgrade) {
		codeServer.on("upgrade", options.codeServerUpgrade);
	}
	await listen(codeServer);
	servers.push(codeServer);
	const codeServerAddress = codeServer.address();
	if (!codeServerAddress || typeof codeServerAddress === "string") {
		throw new Error("expected code-server TCP address");
	}

	const gateway = createGatewayServer(config({ port: 0, ...options.config }), {
		codeServerOrigin: new URL(`http://127.0.0.1:${codeServerAddress.port}`),
		persistenceHeartbeatPath: heartbeatPath,
		log: () => {},
	});
	await gateway.start();
	gateways.push(gateway);
	const gatewayAddress = gateway.server.address();
	if (!gatewayAddress || typeof gatewayAddress === "string") {
		throw new Error("expected gateway TCP address");
	}
	const port = gatewayAddress.port;
	const fetchGateway = (path: string, init?: RequestInit): Promise<Response> =>
		fetch(`http://127.0.0.1:${port}${path}`, init);
	return {
		gateway,
		port,
		fetch: fetchGateway,
		async text(path: string, init?: RequestInit): Promise<string> {
			return await (await fetchGateway(path, init)).text();
		},
		requestText(
			path: string,
			host: string,
			headers: Record<string, string> = {},
		): Promise<string> {
			return requestText(port, path, host, headers);
		},
		rawUpgrade(path: string): Promise<string> {
			return rawUpgrade(port, path);
		},
	};
}

async function listen(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function tempHeartbeatPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "agentbox-gateway-"));
	tempDirs.push(dir);
	return join(dir, "persistence.ready");
}

async function writePersistenceHeartbeat(
	path: string,
	overrides: {
		readonly status?: "ok" | "degraded" | "disabled";
		readonly mode?: "watch" | "restore" | "starting";
		readonly degradedReasons?: readonly string[];
	} = {},
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({
			updatedAt: new Date().toISOString(),
			status: overrides.status ?? "ok",
			mode: overrides.mode ?? "watch",
			watcherCount: 1,
			degradedReasons: overrides.degradedReasons ?? [],
			dirtyBacklog: 0,
			auditCursorCount: 0,
			lastError: null,
		})}\n`,
	);
}

async function rawUpgrade(port: number, path: string): Promise<string> {
	const client = new Socket();
	client.setEncoding("latin1");
	let response = "";
	const connected = new Promise<void>((resolve, reject) => {
		client.on("connect", resolve);
		client.on("error", reject);
	});
	client.connect(port, "127.0.0.1");
	await connected;
	const headersReceived = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			client.destroy();
			reject(new Error(`timed out waiting for upgrade response: ${response}`));
		}, 1_000);
		client.on("data", (chunk: string) => {
			response += chunk;
			if (response.includes("\r\n\r\n")) {
				clearTimeout(timer);
				client.destroy();
				resolve();
			}
		});
		client.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
	client.write(
		`GET ${path} HTTP/1.1\r\n` +
			"Host: localhost\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
			"Sec-WebSocket-Version: 13\r\n\r\n",
	);
	await headersReceived;
	return response;
}

async function requestText(
	port: number,
	path: string,
	host: string,
	headers: Record<string, string> = {},
): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				headers: { host, ...headers },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer | string) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				response.on("end", () => resolve(Buffer.concat(chunks).toString()));
			},
		);
		request.on("error", reject);
		request.end();
	});
}

function headerValue(value: string | string[] | undefined): string {
	return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function sendCodeServerHealth(
	request: IncomingMessage,
	response: ServerResponse,
	status = "alive",
): boolean {
	if (request.url !== "/healthz") {
		return false;
	}
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(`${JSON.stringify({ status, lastHeartbeat: Date.now() })}\n`);
	return true;
}

function config(overrides: Partial<AgentboxConfig> = {}): AgentboxConfig {
	return {
		port: 8080,
		bindAddress: "127.0.0.1",
		volumePath: "/data",
		workspacePath: "/home/user/Desktop",
		publicUrl: "http://localhost:8080",
		publicProxyUrlTemplate: "./proxy/{{port}}",
		trustedProxyHops: 0,
		disableMetrics: true,
		disableFileDownloads: false,
		disableFileUploads: false,
		authType: "password",
		password: "test",
		buildVersion: "test",
		buildRevision: "test",
		buildSource: "test",
		...overrides,
	};
}
