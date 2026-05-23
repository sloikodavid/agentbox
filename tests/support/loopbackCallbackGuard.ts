export const loopbackCallbackParamNames = [
	"callback",
	"callbackto",
	"callbackuri",
	"callbackurl",
	"continue",
	"continueto",
	"continueuri",
	"continueurl",
	"destination",
	"destinationuri",
	"destinationurl",
	"next",
	"nexturi",
	"nexturl",
	"postlogoutredirecturi",
	"postlogoutredirecturl",
	"redirect",
	"redirectto",
	"redirecturi",
	"redirecturl",
	"return",
	"returnto",
	"returnuri",
	"returnurl",
	"targetlinkuri"
] as const;

const loopbackCallbackParamNameSet = new Set(loopbackCallbackParamNames);

export function normalizeLoopbackCallbackParamName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

export function parseHttpUrl(
	value: string | null | undefined
): URL | undefined {
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}

	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

export function isLoopbackHost(hostname: string): boolean {
	const normalized = hostname.trim().toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "localhost." ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".localhost.") ||
		normalized.startsWith("127.") ||
		normalized === "0.0.0.0" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized === "::" ||
		normalized === "[::]" ||
		isIpv4MappedLoopbackHost(normalized)
	);
}

function isIpv4MappedLoopbackHost(normalized: string): boolean {
	const match = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(normalized);
	if (!match) {
		return false;
	}

	const highBits = parseInt(match[1] ?? "", 16);
	return highBits >= 0x7f00 && highBits <= 0x7fff;
}

export function getQueryLikeParams(url: URL): URLSearchParams[] {
	const params = [url.searchParams];
	const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
	if (!hash) {
		return params;
	}

	const hashQueryIndex = hash.indexOf("?");
	if (hashQueryIndex >= 0 && hashQueryIndex < hash.length - 1) {
		params.push(new URLSearchParams(hash.slice(hashQueryIndex + 1)));
		return params;
	}

	if (hash.includes("=")) {
		params.push(new URLSearchParams(hash));
	}

	return params;
}

export function findLoopbackCallbackTarget(
	url: URL,
	depth = 0
): URL | undefined {
	if (depth > 2) {
		return undefined;
	}

	for (const params of getQueryLikeParams(url)) {
		for (const [key, value] of params) {
			if (
				!loopbackCallbackParamNameSet.has(
					normalizeLoopbackCallbackParamName(
						key
					) as (typeof loopbackCallbackParamNames)[number]
				)
			) {
				continue;
			}

			const parsedValue = parseHttpUrl(value);
			if (!parsedValue) {
				continue;
			}

			if (isLoopbackHost(parsedValue.hostname)) {
				return parsedValue;
			}

			const nestedTarget = findLoopbackCallbackTarget(parsedValue, depth + 1);
			if (nestedTarget) {
				return nestedTarget;
			}
		}
	}

	return undefined;
}

export function hasLoopbackCallbackTarget(href: string): boolean {
	const parsed = parseHttpUrl(href);
	if (!parsed || isLoopbackHost(parsed.hostname)) {
		return false;
	}

	return findLoopbackCallbackTarget(parsed) !== undefined;
}
