import { describe, expect, test } from "vitest";

import {
	findLoopbackCallbackTarget,
	hasLoopbackCallbackTarget,
	isLoopbackHost,
	normalizeLoopbackCallbackParamName,
	parseHttpUrl
} from "./support/loopbackCallbackGuard.ts";

describe("loopback callback guard", () => {
	test("normalizes callback parameter names across common spellings", () => {
		expect(normalizeLoopbackCallbackParamName(" redirect_uri ")).toBe(
			"redirecturi"
		);
		expect(normalizeLoopbackCallbackParamName("RETURN-URL")).toBe("returnurl");
		expect(normalizeLoopbackCallbackParamName("target.link.uri")).toBe(
			"targetlinkuri"
		);
	});

	test("detects explicit loopback callback targets in query parameters", () => {
		expect(
			hasLoopbackCallbackTarget(
				"https://github.com/login/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcallback"
			)
		).toBe(true);

		const parsed = parseHttpUrl(
			"https://example.com/start?return-to=http%3A%2F%2Flocalhost.%2Fdone"
		);

		expect(parsed).toBeDefined();
		expect(findLoopbackCallbackTarget(parsed!)?.origin).toBe(
			"http://localhost."
		);
	});

	test("detects loopback callback targets in hash query shapes", () => {
		expect(
			hasLoopbackCallbackTarget(
				"https://identity.example/#/login?continue=http%3A%2F%2Fservice.localhost.%2Fdone"
			)
		).toBe(true);

		expect(
			hasLoopbackCallbackTarget(
				"https://identity.example/#next=http%3A%2F%2F%5B%3A%3A1%5D%3A4444%2Fdone"
			)
		).toBe(true);
	});

	test("detects nested callback targets with a bounded recursion depth", () => {
		const nestedOnce =
			"https://one.example/cb?redirect_uri=" +
			encodeURIComponent(
				"https://two.example/cb?next=" +
					encodeURIComponent("http://127.0.0.1:5173/callback")
			);

		expect(hasLoopbackCallbackTarget(nestedOnce)).toBe(true);

		const tooDeep =
			"https://one.example/cb?redirect_uri=" +
			encodeURIComponent(
				"https://two.example/cb?redirect_uri=" +
					encodeURIComponent(
						"https://three.example/cb?redirect_uri=" +
							encodeURIComponent(
								"https://four.example/cb?redirect_uri=" +
									encodeURIComponent("http://127.0.0.1:5173/callback")
							)
					)
			);

		expect(hasLoopbackCallbackTarget(tooDeep)).toBe(false);
	});

	test("does not warn for ordinary external links or top-level loopback links", () => {
		expect(hasLoopbackCallbackTarget("https://example.com/docs")).toBe(false);
		expect(
			hasLoopbackCallbackTarget(
				"https://example.com/cb?redirect_uri=https%3A%2F%2Fapp.example%2Fdone"
			)
		).toBe(false);
		expect(hasLoopbackCallbackTarget("http://127.0.0.1:3000/signin")).toBe(
			false
		);
		expect(
			hasLoopbackCallbackTarget(
				"https://example.com/cb?redirect_uri=vscode%3A%2F%2Fauth"
			)
		).toBe(false);
	});

	test("recognizes loopback host variants that URL parsing normalizes", () => {
		expect(isLoopbackHost(new URL("http://0177.0.0.1/").hostname)).toBe(true);
		expect(isLoopbackHost(new URL("http://2130706433/").hostname)).toBe(true);
		expect(isLoopbackHost(new URL("http://foo.localhost./").hostname)).toBe(
			true
		);
		expect(isLoopbackHost(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe(
			true
		);
		expect(isLoopbackHost("example.com")).toBe(false);
	});
});
