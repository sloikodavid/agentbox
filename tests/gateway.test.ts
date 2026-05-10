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
import { createGateway } from "../rootfs/opt/agentbox/gateway.ts";
import type { AgentboxConfig } from "../rootfs/opt/agentbox/config.ts";
import { rootfsHeartbeatPath } from "../rootfs/opt/agentbox/rootfs.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	await rm(rootfsHeartbeatPath, { force: true });
	await Promise.all(
		tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
	tempDirs.length = 0;
});

describe("createGateway", () => {
	test("reports health shape before dependencies are ready", () => {
		const gateway = createGateway(config());
		const health = gateway.health();
		expect(health.ready).toBe(false);
		expect(health.status).toBe("starting");
		expect(health.version).toBe("test");
		expect(health.checks).toEqual([]);
	});

	test("can start and stop a listener", async () => {
		const gateway = createGateway(config({ port: 0 }));
		await gateway.startGateway();
		expect(gateway.server.listening).toBe(true);
		await gateway.stopGateway();
		expect(gateway.server.listening).toBe(false);
	});

	test("uses configured health endpoint under the base path", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				response.end("proxied");
			}),
		);
		await writeRootfsHeartbeat();
		const gateway = createGateway(
			config({ port: 0, basePath: "/agentbox", healthPath: "/status" }),
		);
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}
		const health = await fetch(
			`http://127.0.0.1:${address.port}/agentbox/status`,
		);
		expect(health.status).toBe(200);
		const body = (await health.json()) as { readonly ready: boolean };
		expect(body.ready).toBe(true);
		const readiness = await fetch(
			`http://127.0.0.1:${address.port}/agentbox/status/readiness`,
		);
		expect(readiness.status).toBe(200);
		const defaultHealth = await fetch(
			`http://127.0.0.1:${address.port}/healthz`,
		);
		expect(defaultHealth.status).toBe(404);
		const unprefixedHealth = await fetch(
			`http://127.0.0.1:${address.port}/status`,
		);
		expect(unprefixedHealth.status).toBe(404);
		await gateway.stopGateway();
	});

	test("proxies prefixed requests when ready", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				const prefix = request.headers["x-forwarded-prefix"];
				response.end(
					`proxied:${request.url}:${Array.isArray(prefix) ? prefix.join(",") : (prefix ?? "")}`,
				);
			}),
		);
		const dir = await mkdtemp(join(tmpdir(), "agentbox-gateway-"));
		tempDirs.push(dir);
		await writeRootfsHeartbeat();

		const gateway = createGateway(config({ port: 0, basePath: "/agentbox" }));
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}
		const response = await fetch(
			`http://127.0.0.1:${address.port}/agentbox/path?q=1`,
		);
		expect(await response.text()).toContain("proxied:/path?q=1:/agentbox");
		await gateway.stopGateway();
	});

	test("serves metrics under the base path when enabled", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				response.end("ok");
			}),
		);
		await writeRootfsHeartbeat();

		const gateway = createGateway(
			config({ port: 0, basePath: "/agentbox", enableMetrics: true }),
		);
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}
		const metrics = await fetch(
			`http://127.0.0.1:${address.port}/agentbox/metrics`,
		);
		expect(await metrics.text()).toBe("agentbox_ready 1\n");
		const unprefixedMetrics = await fetch(
			`http://127.0.0.1:${address.port}/metrics`,
		);
		expect(unprefixedMetrics.status).toBe(404);
		await gateway.stopGateway();
	});

	test("preserves websocket upgrade handshakes", async () => {
		let upstreamUrl = "";
		let forwardedPrefix = "";
		const codeServer = createServer((request, response) => {
			if (sendCodeServerHealth(request, response)) {
				return;
			}
			response.end("ok");
		});
		codeServer.on("upgrade", (request, socket) => {
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
		});
		await listenCodeServer(codeServer);
		await writeRootfsHeartbeat();

		const gateway = createGateway(config({ port: 0, basePath: "/agentbox" }));
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}

		const response = await rawUpgrade(address.port, "/agentbox/ws?x=1");
		expect(response).toContain("HTTP/1.1 101 Switching Protocols");
		expect(response.toLowerCase()).toContain("upgrade: websocket");
		expect(response.toLowerCase()).toContain("connection: upgrade");
		expect(upstreamUrl).toBe("/ws?x=1");
		expect(forwardedPrefix).toBe("/agentbox");
		await gateway.stopGateway();
	});

	test("forwards trusted proxy hop headers", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				const forwardedHost = headerValue(request.headers["x-forwarded-host"]);
				const forwardedProto = headerValue(
					request.headers["x-forwarded-proto"],
				);
				response.end(`${forwardedHost}:${forwardedProto}`);
			}),
		);
		await writeRootfsHeartbeat();

		const gateway = createGateway(config({ port: 0, proxyHops: 1 }));
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}
		const response = await fetch(`http://127.0.0.1:${address.port}/`, {
			headers: {
				"x-forwarded-host": "client.example, proxy.example",
				"x-forwarded-proto": "https, http",
			},
		});
		expect(await response.text()).toBe("proxy.example:http");
		await gateway.stopGateway();
	});

	test("preserves the public host for code-server port proxying", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				response.end(headerValue(request.headers.host));
			}),
		);
		await writeRootfsHeartbeat();

		const gateway = createGateway(config({ port: 0 }));
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}
		expect(await requestText(address.port, "/", "3000.box.example.com")).toBe(
			"3000.box.example.com",
		);
		await gateway.stopGateway();
	});

	test("lets port-template hosts bypass the base path", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				response.end(
					`${request.url}:${headerValue(request.headers["x-forwarded-prefix"])}`,
				);
			}),
		);
		await writeRootfsHeartbeat();

		const gateway = createGateway(
			config({
				port: 0,
				basePath: "/agentbox",
				proxyDomain: "box.example.com",
			}),
		);
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}
		expect(
			await requestText(address.port, "/hook", "8787.box.example.com"),
		).toBe("/hook:");
		await gateway.stopGateway();
	});

	test("ignores untrusted forwarded headers when proxy hops are disabled", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				const forwardedHost = headerValue(request.headers["x-forwarded-host"]);
				const forwardedProto = headerValue(
					request.headers["x-forwarded-proto"],
				);
				response.end(`${forwardedHost}:${forwardedProto}`);
			}),
		);
		await writeRootfsHeartbeat();

		const gateway = createGateway(config({ port: 0, proxyHops: 0 }));
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}
		const response = await fetch(`http://127.0.0.1:${address.port}/`, {
			headers: {
				"x-forwarded-host": "evil.example",
				"x-forwarded-proto": "https",
			},
		});
		const body = await response.text();
		expect(body).toContain(`127.0.0.1:${address.port}`);
		expect(body).toContain(":http");
		expect(body).not.toContain("evil.example");
		await gateway.stopGateway();
	});

	test("returns upstream non-upgrade responses for rejected websocket handshakes", async () => {
		const codeServer = createServer((request, response) => {
			if (sendCodeServerHealth(request, response)) {
				return;
			}
			response.end("ok");
		});
		codeServer.on("upgrade", (_request, socket) => {
			socket.end(
				"HTTP/1.1 403 Forbidden\r\n" +
					"Connection: close\r\n" +
					"X-Blocked: yes\r\n" +
					"Content-Length: 8\r\n\r\n" +
					"rejected",
			);
		});
		await listenCodeServer(codeServer);
		await writeRootfsHeartbeat();

		const gateway = createGateway(config({ port: 0 }));
		await gateway.startGateway();
		const address = gateway.server.address();
		if (!address || typeof address === "string") {
			throw new Error("expected TCP address");
		}
		const response = await rawUpgrade(address.port, "/ws");
		expect(response).toContain("HTTP/1.1 403 Forbidden");
		expect(response.toLowerCase()).toContain("x-blocked: yes");
		await gateway.stopGateway();
	});

	test("allows readiness when code-server is idle but accepting connections", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response, "expired")) {
					return;
				}
				response.end("ok");
			}),
		);
		await writeRootfsHeartbeat();

		const gateway = createGateway(config({ port: 0 }));
		await gateway.startGateway();
		expect(gateway.health().ready).toBe(true);
		expect(gateway.health().checks).toContainEqual({
			name: "code_server",
			status: "pass",
			message: "code-server is accepting connections (expired)",
		});
		await gateway.stopGateway();
	});

	test("fails readiness when the rootfs heartbeat is stale", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				response.end("ok");
			}),
		);
		await writeRootfsHeartbeat();
		const stale = new Date(Date.now() - 60_000);
		await utimes(rootfsHeartbeatPath, stale, stale);

		const gateway = createGateway(config({ port: 0 }));
		await gateway.startGateway();
		const health = gateway.health();
		expect(health.ready).toBe(false);
		expect(health.checks).toContainEqual({
			name: "rootfs",
			status: "fail",
			message: "rootfs store heartbeat is stale",
		});
		await gateway.stopGateway();
	});

	test("fails readiness when the rootfs heartbeat has no active watchers", async () => {
		await listenCodeServer(
			createServer((request, response) => {
				if (sendCodeServerHealth(request, response)) {
					return;
				}
				response.end("ok");
			}),
		);
		await writeRootfsHeartbeat({ watcherCount: 0 });

		const gateway = createGateway(config({ port: 0 }));
		await gateway.startGateway();
		expect(gateway.health().ready).toBe(false);
		expect(gateway.health().checks).toContainEqual({
			name: "rootfs",
			status: "fail",
			message: "rootfs store watcher is not running",
		});
		await gateway.stopGateway();
	});
});

async function listenCodeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve) =>
		server.listen(13337, "127.0.0.1", resolve),
	);
	servers.push(server);
}

async function writeRootfsHeartbeat(
	overrides: { readonly watcherCount?: number } = {},
): Promise<void> {
	await mkdir(dirname(rootfsHeartbeatPath), { recursive: true });
	await writeFile(
		rootfsHeartbeatPath,
		`${JSON.stringify({
			updatedAt: new Date().toISOString(),
			watcherCount: overrides.watcherCount ?? 1,
			failedWatchers: [],
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
): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				headers: { host },
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
		listenAddress: "127.0.0.1",
		volumePath: "/data",
		basePath: "/",
		host: "localhost",
		protocol: "http",
		url: "http://localhost:8080",
		portTemplateUrl: "./proxy/{{port}}",
		proxyHops: 0,
		healthPath: "/healthz",
		enableMetrics: false,
		buildVersion: "test",
		buildRevision: "test",
		buildSource: "test",
		...overrides,
	};
}
