import { describe, expect, test } from "vitest";
import {
	ConfigError,
	normalizeUrlPath,
	parseConfig,
} from "../rootfs/opt/agentbox/config.ts";

describe("normalizeUrlPath", () => {
	test("normalizes empty and root paths", () => {
		expect(normalizeUrlPath(undefined, "TEST")).toBe("/");
		expect(normalizeUrlPath("", "TEST")).toBe("/");
		expect(normalizeUrlPath("/", "TEST")).toBe("/");
	});

	test("adds a leading slash and removes trailing slash", () => {
		expect(normalizeUrlPath("agentbox", "TEST")).toBe("/agentbox");
		expect(normalizeUrlPath("/agentbox/", "TEST")).toBe("/agentbox");
	});
});

describe("parseConfig", () => {
	test("uses defaults", () => {
		const config = parseConfig({});
		expect(config.port).toBe(8080);
		expect(config.listenAddress).toBe("::");
		expect(config.volumePath).toBe("/data");
		expect(config.basePath).toBe("/");
		expect(config.url).toBe("http://localhost:8080");
		expect(config.portTemplateUrl).toBe("./proxy/{{port}}");
	});

	test("falls back for invalid port and protocol", () => {
		const config = parseConfig({ PORT: "wat", AGENTBOX_PROTOCOL: "ftp" });
		expect(config.port).toBe(8080);
		expect(config.protocol).toBe("http");
	});

	test("derives public URL with path and default port omission", () => {
		const config = parseConfig({
			AGENTBOX_PROTOCOL: "https",
			AGENTBOX_SSL_KEY: "tests/fixtures/key.pem",
			AGENTBOX_SSL_CERT: "tests/fixtures/cert.pem",
			AGENTBOX_HOST: "example.com",
			PORT: "443",
			AGENTBOX_BASE_PATH: "box",
		});
		expect(config.url).toBe("https://example.com/box");
	});

	test("accepts a host-based port URL template and derives proxy domain", () => {
		const config = parseConfig({
			AGENTBOX_PORT_TEMPLATE_URL: "https://{{port}}.box.example.com",
		});
		expect(config.portTemplateUrl).toBe("https://{{port}}.box.example.com");
		expect(config.proxyDomain).toBe("box.example.com");
	});

	test("accepts a path-based port URL template", () => {
		const config = parseConfig({
			AGENTBOX_PORT_TEMPLATE_URL: "/ports/{{port}}",
		});
		expect(config.portTemplateUrl).toBe("/ports/{{port}}");
		expect(config.proxyDomain).toBeUndefined();
	});

	test("requires port URL templates to include the port placeholder", () => {
		expect(() =>
			parseConfig({
				AGENTBOX_PORT_TEMPLATE_URL: "https://ports.example.com",
			}),
		).toThrow(ConfigError);
	});

	test("requires absolute volume path", () => {
		expect(() => parseConfig({ AGENTBOX_VOLUME_PATH: "data" })).toThrow(
			ConfigError,
		);
	});

	test("rejects the filesystem root as the persistence path", () => {
		expect(() => parseConfig({ AGENTBOX_VOLUME_PATH: "/" })).toThrow(
			ConfigError,
		);
	});

	test("requires TLS files for https", () => {
		expect(() => parseConfig({ AGENTBOX_PROTOCOL: "https" })).toThrow(
			ConfigError,
		);
	});

	test("validates public URL path against configured path", () => {
		expect(() =>
			parseConfig({
				AGENTBOX_BASE_PATH: "/box",
				AGENTBOX_URL: "https://example.com/other",
			}),
		).toThrow(ConfigError);
	});

	test("requires the public URL root path to match the configured root path", () => {
		expect(() =>
			parseConfig({
				AGENTBOX_BASE_PATH: "/",
				AGENTBOX_URL: "https://example.com/agentbox",
			}),
		).toThrow(ConfigError);
	});
});
