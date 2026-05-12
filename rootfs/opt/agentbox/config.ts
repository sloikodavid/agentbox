import { readFileSync } from "node:fs";
import { posix as path } from "node:path";

export type AgentboxProtocol = "http" | "https";
export type AgentboxAuthType = "password" | "none";

export interface AgentboxConfig {
	readonly port: number;
	readonly bindAddress: string;
	readonly volumePath: string;
	readonly publicUrlPath: string;
	readonly publicUrl: string;
	readonly publicProxyUrlTemplate: string;
	readonly proxyDomain?: string;
	readonly trustedProxyHops: number;
	readonly enableMetrics: boolean;
	readonly authType: AgentboxAuthType;
	readonly password?: string;
	readonly hashedPassword?: string;
	readonly tlsKeyPath?: string;
	readonly tlsCertPath?: string;
	readonly tlsKey?: string;
	readonly tlsCert?: string;
	readonly buildVersion: string;
	readonly buildRevision: string;
	readonly buildSource: string;
}

export interface ParseConfigOptions {
	readonly loadTlsFiles?: boolean;
}

const DEFAULT_PORT = 8080;
const DEFAULT_AGENTBOX_BUILD_SOURCE = "https://github.com/sloikodavid/agentbox";
const DEFAULT_AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE = "./proxy/{{port}}";
const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export class ConfigError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ConfigError";
	}
}

export function parseConfig(
	env: NodeJS.ProcessEnv = process.env,
	options: ParseConfigOptions = {},
): AgentboxConfig {
	const port = parsePort(env.PORT);
	const bindAddress = envString(env.AGENTBOX_BIND_ADDRESS) ?? "::";
	const volumePath = envString(env.AGENTBOX_VOLUME_PATH) ?? "/data";
	const tlsKeyPath = envString(env.AGENTBOX_TLS_KEY_PATH);
	const tlsCertPath = envString(env.AGENTBOX_TLS_CERT_PATH);
	const auth = parseAuthConfig(env);

	requireAbsolutePath(volumePath, "AGENTBOX_VOLUME_PATH");
	if (tlsKeyPath) requireAbsolutePath(tlsKeyPath, "AGENTBOX_TLS_KEY_PATH");
	if (tlsCertPath) requireAbsolutePath(tlsCertPath, "AGENTBOX_TLS_CERT_PATH");
	if (Boolean(tlsKeyPath) !== Boolean(tlsCertPath)) {
		throw new ConfigError(
			"AGENTBOX_TLS_KEY_PATH and AGENTBOX_TLS_CERT_PATH must be set together",
		);
	}

	const publicUrl = parsePublicUrl(env.AGENTBOX_PUBLIC_URL, {
		protocol: tlsKeyPath ? "https" : "http",
		port,
	});
	const proxy = parsePublicProxyUrlTemplate(
		env.AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE,
	);
	const loadTlsFiles = options.loadTlsFiles ?? true;

	return {
		port,
		bindAddress,
		volumePath,
		publicUrlPath: normalizePublicUrlPath(
			new URL(publicUrl).pathname,
			"AGENTBOX_PUBLIC_URL pathname",
		),
		publicUrl,
		...proxy,
		trustedProxyHops: parseNonNegativeInteger(
			env.AGENTBOX_TRUSTED_PROXY_HOPS,
			"AGENTBOX_TRUSTED_PROXY_HOPS",
			0,
		),
		enableMetrics: parseBoolean(
			env.AGENTBOX_ENABLE_METRICS,
			"AGENTBOX_ENABLE_METRICS",
		),
		...auth,
		...(tlsKeyPath
			? {
					tlsKeyPath,
					...(loadTlsFiles ? { tlsKey: readFileSync(tlsKeyPath, "utf8") } : {}),
				}
			: {}),
		...(tlsCertPath
			? {
					tlsCertPath,
					...(loadTlsFiles
						? { tlsCert: readFileSync(tlsCertPath, "utf8") }
						: {}),
				}
			: {}),
		buildVersion: envString(env.AGENTBOX_BUILD_VERSION) ?? "unknown",
		buildRevision: envString(env.AGENTBOX_BUILD_REVISION) ?? "unknown",
		buildSource:
			envString(env.AGENTBOX_BUILD_SOURCE) ?? DEFAULT_AGENTBOX_BUILD_SOURCE,
	};
}

function parseAuthConfig(env: NodeJS.ProcessEnv): {
	readonly authType: AgentboxAuthType;
	readonly password?: string;
	readonly hashedPassword?: string;
} {
	const rawAuthType = envString(env.AGENTBOX_AUTH) ?? "password";
	if (rawAuthType !== "password" && rawAuthType !== "none") {
		throw new ConfigError("AGENTBOX_AUTH must be password or none");
	}
	const password = envString(env.AGENTBOX_PASSWORD);
	const hashedPassword = envString(env.AGENTBOX_HASHED_PASSWORD);
	if (password && hashedPassword) {
		throw new ConfigError(
			"AGENTBOX_PASSWORD and AGENTBOX_HASHED_PASSWORD must not both be set",
		);
	}
	if (rawAuthType === "password" && !password && !hashedPassword) {
		throw new ConfigError(
			"AGENTBOX_PASSWORD or AGENTBOX_HASHED_PASSWORD is required when AGENTBOX_AUTH=password",
		);
	}
	if (rawAuthType === "none" && (password || hashedPassword)) {
		throw new ConfigError(
			"AGENTBOX_PASSWORD and AGENTBOX_HASHED_PASSWORD must not be set when AGENTBOX_AUTH=none",
		);
	}
	return {
		authType: rawAuthType,
		...(password ? { password } : {}),
		...(hashedPassword ? { hashedPassword } : {}),
	};
}

function normalizePublicUrlPath(
	value: string | undefined,
	name: string,
): string {
	let result = envString(value) ?? "/";
	if (
		hasControlCharacter(result) ||
		result.includes("?") ||
		result.includes("#")
	) {
		throw new ConfigError(`${name} must be a URL path`);
	}
	result = result.startsWith("/") ? result : `/${result}`;
	while (result.length > 1 && result.endsWith("/"))
		result = result.slice(0, -1);
	return result;
}

function parsePort(value: string | undefined): number {
	return parseInteger(value, "PORT", {
		fallback: DEFAULT_PORT,
		min: 1,
		max: 65535,
	});
}

function parseNonNegativeInteger(
	value: string | undefined,
	name: string,
	fallback: number,
): number {
	return parseInteger(value, name, { fallback, min: 0 });
}

function parseInteger(
	value: string | undefined,
	name: string,
	options: {
		readonly fallback: number;
		readonly min: number;
		readonly max?: number;
	},
): number {
	const raw = envString(value);
	if (!raw) return options.fallback;
	const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < options.min ||
		(options.max !== undefined && parsed > options.max)
	) {
		throw new ConfigError(
			options.min === 0 && options.max === undefined
				? `${name} must be a non-negative integer`
				: `${name} must be an integer between ${options.min} and ${options.max}`,
		);
	}
	return parsed;
}

function parseBoolean(value: string | undefined, name: string): boolean {
	const raw = envString(value)?.toLowerCase();
	if (!raw || BOOLEAN_FALSE_VALUES.has(raw)) return false;
	if (BOOLEAN_TRUE_VALUES.has(raw)) return true;
	throw new ConfigError(
		`${name} must be a boolean (1/0, true/false, yes/no, on/off)`,
	);
}

function envString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parsePublicUrl(
	value: string | undefined,
	fallback: { readonly protocol: AgentboxProtocol; readonly port: number },
): string {
	const raw = envString(value);
	if (!raw) return deriveLocalPublicUrl(fallback);
	const url = parseHttpUrl(raw, "AGENTBOX_PUBLIC_URL");
	if (url.search || url.hash) {
		throw new ConfigError(
			"AGENTBOX_PUBLIC_URL must not include query or fragment",
		);
	}
	while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
		url.pathname = url.pathname.slice(0, -1);
	}
	return url.toString().replace(/\/$/, "");
}

function deriveLocalPublicUrl(input: {
	readonly protocol: AgentboxProtocol;
	readonly port: number;
}): string {
	const defaultPort =
		(input.protocol === "http" && input.port === 80) ||
		(input.protocol === "https" && input.port === 443);
	return `${input.protocol}://localhost${defaultPort ? "" : `:${input.port}`}`;
}

function parsePublicProxyUrlTemplate(value: string | undefined): {
	readonly publicProxyUrlTemplate: string;
	readonly proxyDomain?: string;
} {
	const raw = envString(value);
	if (!raw)
		return {
			publicProxyUrlTemplate: DEFAULT_AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE,
		};
	if (hasControlCharacter(raw) || raw.includes("?") || raw.includes("#")) {
		throw new ConfigError(
			"AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE must not include query or fragment",
		);
	}
	if (!raw.includes("{{port}}")) {
		throw new ConfigError(
			"AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE must include {{port}}",
		);
	}
	if (raw.startsWith("./")) return { publicProxyUrlTemplate: raw };
	if (raw.startsWith("/")) {
		throw new ConfigError(
			"AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE must be relative or an absolute http/https URL",
		);
	}
	const url = parseHttpUrl(raw, "AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE");
	return {
		publicProxyUrlTemplate: raw,
		...(url.hostname.includes("{{port}}") ? { proxyDomain: url.hostname } : {}),
	};
}

function parseHttpUrl(value: string, name: string): URL {
	if (hasControlCharacter(value)) {
		throw new ConfigError(`${name} must not include control characters`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`${name} must be a valid absolute URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ConfigError(`${name} must use http or https`);
	}
	if (url.username || url.password) {
		throw new ConfigError(`${name} must not include credentials`);
	}
	return url;
}

function requireAbsolutePath(value: string, name: string): void {
	if (
		!value.startsWith("/") ||
		hasControlCharacter(value) ||
		path.normalize(value) !== value ||
		value === "/"
	) {
		throw new ConfigError(
			`${name} must be a normalized absolute filesystem path`,
		);
	}
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) return true;
	}
	return false;
}
