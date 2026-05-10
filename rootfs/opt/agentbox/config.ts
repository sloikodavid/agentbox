import { readFileSync } from "node:fs";

export type AgentboxProtocol = "http" | "https";

export interface AgentboxConfig {
	readonly port: number;
	readonly listenAddress: string;
	readonly volumePath: string;
	readonly basePath: string;
	readonly host: string;
	readonly protocol: AgentboxProtocol;
	readonly url: string;
	readonly portTemplateUrl: string;
	readonly proxyDomain?: string;
	readonly proxyHops: number;
	readonly healthPath: string;
	readonly enableMetrics: boolean;
	readonly sslKeyPath?: string;
	readonly sslCertPath?: string;
	readonly sslKey?: string;
	readonly sslCert?: string;
	readonly timezone?: string;
	readonly buildVersion: string;
	readonly buildRevision: string;
	readonly buildSource: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export function parseConfig(
	env: NodeJS.ProcessEnv = process.env,
): AgentboxConfig {
	const port = parsePort(env.PORT);
	const listenAddress = env.AGENTBOX_LISTEN_ADDRESS?.trim() || "::";
	const volumePath = env.AGENTBOX_VOLUME_PATH?.trim() || "/data";
	const basePath = normalizeUrlPath(
		env.AGENTBOX_BASE_PATH,
		"AGENTBOX_BASE_PATH",
	);
	const host = env.AGENTBOX_HOST?.trim() || "localhost";
	const protocol = parseProtocol(env.AGENTBOX_PROTOCOL);
	const proxyHops = parseNonNegativeInteger(env.AGENTBOX_PROXY_HOPS, 0);
	const healthPath = normalizeUrlPath(
		env.AGENTBOX_HEALTH_PATH || "/healthz",
		"AGENTBOX_HEALTH_PATH",
	);
	const enableMetrics = parseBoolean(env.AGENTBOX_ENABLE_METRICS);
	const sslKeyPath = emptyToUndefined(env.AGENTBOX_SSL_KEY);
	const sslCertPath = emptyToUndefined(env.AGENTBOX_SSL_CERT);
	const timezone = emptyToUndefined(env.TZ);

	if (!volumePath.startsWith("/")) {
		throw new ConfigError(
			"AGENTBOX_VOLUME_PATH must be an absolute filesystem path",
		);
	}
	if (volumePath === "/") {
		throw new ConfigError(
			"AGENTBOX_VOLUME_PATH must not be the filesystem root",
		);
	}

	if (protocol === "https" && (!sslKeyPath || !sslCertPath)) {
		throw new ConfigError(
			"AGENTBOX_PROTOCOL=https requires AGENTBOX_SSL_KEY and AGENTBOX_SSL_CERT",
		);
	}

	const url = env.AGENTBOX_URL?.trim()
		? validateAgentboxUrl(env.AGENTBOX_URL.trim(), basePath)
		: deriveAgentboxUrl({ protocol, host, port, basePath });
	const { portTemplateUrl, proxyDomain } = parsePortTemplateUrl(
		env.AGENTBOX_PORT_TEMPLATE_URL,
	);

	return {
		port,
		listenAddress,
		volumePath,
		basePath,
		host,
		protocol,
		url,
		portTemplateUrl,
		...(proxyDomain ? { proxyDomain } : {}),
		proxyHops,
		healthPath,
		enableMetrics,
		...(sslKeyPath
			? { sslKeyPath, sslKey: readFileSync(sslKeyPath, "utf8") }
			: {}),
		...(sslCertPath
			? { sslCertPath, sslCert: readFileSync(sslCertPath, "utf8") }
			: {}),
		...(timezone ? { timezone } : {}),
		buildVersion: env.AGENTBOX_BUILD_VERSION?.trim() || "unknown",
		buildRevision: env.AGENTBOX_BUILD_REVISION?.trim() || "unknown",
		buildSource:
			env.AGENTBOX_BUILD_SOURCE?.trim() ||
			"https://github.com/sloikodavid/agentbox",
	};
}

export function normalizeUrlPath(
	value: string | undefined,
	name: string,
): string {
	const raw = value?.trim();
	if (!raw || raw === "/") {
		return "/";
	}

	let path = raw.startsWith("/") ? raw : `/${raw}`;
	while (path.length > 1 && path.endsWith("/")) {
		path = path.slice(0, -1);
	}

	if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
		throw new ConfigError(`${name} must be a URL path`);
	}

	return path;
}

function parsePort(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
		? parsed
		: 8080;
}

function parseProtocol(value: string | undefined): AgentboxProtocol {
	return value === "https" ? "https" : "http";
}

function parseNonNegativeInteger(
	value: string | undefined,
	fallback: number,
): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes(
		(value ?? "").trim().toLowerCase(),
	);
}

function emptyToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function deriveAgentboxUrl(input: {
	readonly protocol: AgentboxProtocol;
	readonly host: string;
	readonly port: number;
	readonly basePath: string;
}): string {
	const defaultPort =
		(input.protocol === "http" && input.port === 80) ||
		(input.protocol === "https" && input.port === 443);
	const port = defaultPort ? "" : `:${input.port}`;
	return `${input.protocol}://${input.host}${port}${input.basePath === "/" ? "" : input.basePath}`;
}

function validateAgentboxUrl(value: string, basePath: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError("AGENTBOX_URL must be a valid absolute URL");
	}

	if (normalizeUrlPath(url.pathname, "AGENTBOX_URL pathname") !== basePath) {
		throw new ConfigError(
			"AGENTBOX_URL pathname must equal AGENTBOX_BASE_PATH",
		);
	}

	while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
		url.pathname = url.pathname.slice(0, -1);
	}

	return url.toString().replace(/\/$/, "");
}

function parsePortTemplateUrl(value: string | undefined): {
	readonly portTemplateUrl: string;
	readonly proxyDomain?: string;
} {
	const trimmed = value?.trim();
	if (!trimmed) {
		return { portTemplateUrl: "./proxy/{{port}}" };
	}
	if (!trimmed.includes("{{port}}")) {
		throw new ConfigError("AGENTBOX_PORT_TEMPLATE_URL must include {{port}}");
	}
	if (trimmed.startsWith("./") || trimmed.startsWith("/")) {
		return { portTemplateUrl: trimmed };
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new ConfigError(
			"AGENTBOX_PORT_TEMPLATE_URL must be a valid URL template",
		);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ConfigError("AGENTBOX_PORT_TEMPLATE_URL must use http or https");
	}
	if (!url.hostname.includes("{{port}}")) {
		return { portTemplateUrl: trimmed };
	}
	const proxyDomain = proxyDomainFromHostname(url.hostname);
	return proxyDomain
		? { portTemplateUrl: trimmed, proxyDomain }
		: { portTemplateUrl: trimmed };
}

function proxyDomainFromHostname(hostname: string): string | undefined {
	const prefix = "{{port}}.";
	if (!hostname.startsWith(prefix)) {
		return undefined;
	}
	const domain = hostname.slice(prefix.length);
	return domain ? domain : undefined;
}
