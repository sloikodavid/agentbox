import type { IncomingHttpHeaders } from "node:http";
import type { AgentboxConfig } from "../config.ts";
import { createPublicAddress } from "./public-address.ts";

export interface GatewayProxyTarget {
	readonly path: string;
	readonly headers: Record<string, string | string[]>;
}

export type GatewayRequestPlan =
	| { readonly type: "healthz"; readonly statusCode: 200 }
	| { readonly type: "readiness"; readonly statusCode: 200 | 503 }
	| { readonly type: "metrics" }
	| { readonly type: "notFound" }
	| { readonly type: "startingPage"; readonly readinessUrlPath: string }
	| { readonly type: "startingText" }
	| { readonly type: "proxy"; readonly target: GatewayProxyTarget };

export type GatewayUpgradePlan =
	| { readonly type: "notReady" }
	| { readonly type: "notFound" }
	| { readonly type: "proxy"; readonly target: GatewayProxyTarget };

export function planGatewayRequest(input: {
	readonly config: AgentboxConfig;
	readonly url: URL;
	readonly headers: IncomingHttpHeaders;
	readonly ready: boolean;
	readonly wantsHtml: boolean;
}): GatewayRequestPlan {
	const publicAddress = createPublicAddress(input.config);
	if (input.url.pathname === publicAddress.healthUrlPath) {
		return { type: "healthz", statusCode: 200 };
	}
	if (input.url.pathname === publicAddress.readinessUrlPath) {
		return { type: "readiness", statusCode: input.ready ? 200 : 503 };
	}
	if (input.url.pathname === publicAddress.metricsUrlPath) {
		return input.config.disableMetrics
			? { type: "notFound" }
			: { type: "metrics" };
	}

	const target = proxyTarget(input.config, input.headers, input.url);
	if (!target) {
		return { type: "notFound" };
	}
	if (!input.ready) {
		return input.wantsHtml
			? {
					type: "startingPage",
					readinessUrlPath: publicAddress.readinessUrlPath,
				}
			: { type: "startingText" };
	}
	return { type: "proxy", target };
}

export function planGatewayUpgrade(input: {
	readonly config: AgentboxConfig;
	readonly url: URL;
	readonly headers: IncomingHttpHeaders;
	readonly ready: boolean;
}): GatewayUpgradePlan {
	const target = proxyTarget(input.config, input.headers, input.url);
	if (!target) {
		return { type: "notFound" };
	}
	if (!input.ready) {
		return { type: "notReady" };
	}
	return { type: "proxy", target };
}

function proxyTarget(
	config: AgentboxConfig,
	headers: IncomingHttpHeaders,
	url: URL,
): GatewayProxyTarget | null {
	const publicAddress = createPublicAddress(config);
	const usesProxyHostname = publicAddress.isProxyHostname(headers.host);
	const path = usesProxyHostname
		? url.pathname
		: publicAddress.stripBaseUrlPath(url.pathname);
	if (path === null) return null;

	const targetHeaders = filterHeadersForRequest(headers);
	const forwarded = forwardedHeaders(config, headers);
	targetHeaders.host = forwarded["x-forwarded-host"];
	Object.assign(targetHeaders, forwarded);
	if (publicAddress.baseUrlPath !== "/" && !usesProxyHostname) {
		targetHeaders["x-forwarded-prefix"] = publicAddress.baseUrlPath;
	}
	return { path, headers: targetHeaders };
}

interface ForwardedHeaders {
	readonly "x-forwarded-host": string;
	readonly "x-forwarded-proto": string;
}

function forwardedHeaders(
	config: AgentboxConfig,
	headers: IncomingHttpHeaders,
): ForwardedHeaders {
	const publicUrl = new URL(config.publicUrl);
	const trustedHost =
		getTrustedForwardedHeader(
			headers["x-forwarded-host"],
			config.trustedProxyHops,
		) ??
		headers.host ??
		publicUrl.host;
	const trustedProto =
		getTrustedForwardedHeader(
			headers["x-forwarded-proto"],
			config.trustedProxyHops,
		) ?? publicUrl.protocol.replace(/:$/, "");
	return {
		"x-forwarded-host": trustedHost,
		"x-forwarded-proto": trustedProto,
	};
}

function getTrustedForwardedHeader(
	value: string | readonly string[] | undefined,
	trustedProxyHops: number,
): string | undefined {
	if (trustedProxyHops <= 0 || !value) {
		return undefined;
	}
	const raw = typeof value === "string" ? value : value.join(",");
	const values = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (values.length === 0) {
		return undefined;
	}
	return values[Math.max(values.length - trustedProxyHops, 0)];
}

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

function filterHeadersForRequest(
	headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
	const filtered: Record<string, string | string[]> = {};
	const connectionTokens = connectionHeaderTokens(headers);
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

function connectionHeaderTokens(headers: IncomingHttpHeaders): Set<string> {
	return new Set(
		String(
			Array.isArray(headers.connection)
				? headers.connection.join(",")
				: (headers.connection ?? ""),
		)
			.split(",")
			.map((token) => token.trim().toLowerCase())
			.filter(Boolean),
	);
}
