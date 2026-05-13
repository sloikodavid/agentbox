import { describe, expect, test } from "vitest";
import { ConfigError, parseConfig } from "../rootfs/opt/agentbox/config.ts";
import { createPublicAddress } from "../rootfs/opt/agentbox/gateway/public-address.ts";

const passwordEnv = { AGENTBOX_PASSWORD: "secret" };

describe("parseConfig", () => {
	test("uses defaults with password auth", () => {
		const config = parseConfig(passwordEnv);
		expect(config.port).toBe(8080);
		expect(config.bindAddress).toBe("::");
		expect(config.volumePath).toBe("/data");
		expect(config.workspacePath).toBe("/home/user/Desktop");
		expect(config.publicUrl).toBe("http://localhost:8080");
		expect(config.publicProxyUrlTemplate).toBe("./proxy/{{port}}");
		expect(config.authType).toBe("password");
		expect(config.password).toBe("secret");
		expect(config.disableMetrics).toBe(true);
		expect(config.disableFileDownloads).toBe(false);
		expect(config.disableFileUploads).toBe(false);
	});

	test("accepts hashed password auth", () => {
		const config = parseConfig({ AGENTBOX_HASHED_PASSWORD: "hashed" });
		expect(config.authType).toBe("password");
		expect(config.password).toBeUndefined();
		expect(config.hashedPassword).toBe("hashed");
	});

	test("rejects invalid auth config", () => {
		expect(() => parseConfig({})).toThrow(ConfigError);
		expect(() => parseConfig({ AGENTBOX_AUTH: "token" })).toThrow(ConfigError);
		expect(() =>
			parseConfig({
				AGENTBOX_PASSWORD: "secret",
				AGENTBOX_HASHED_PASSWORD: "hashed",
			}),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ AGENTBOX_AUTH: "none", AGENTBOX_PASSWORD: "secret" }),
		).toThrow(ConfigError);
	});

	test("accepts explicit auth none", () => {
		const config = parseConfig({ AGENTBOX_AUTH: "none" });
		expect(config.authType).toBe("none");
		expect(config.password).toBeUndefined();
		expect(config.hashedPassword).toBeUndefined();
	});

	test("rejects invalid port", () => {
		expect(() => parseConfig({ ...passwordEnv, PORT: "123abc" })).toThrow(
			ConfigError,
		);
		expect(() => parseConfig({ ...passwordEnv, PORT: "0" })).toThrow(
			ConfigError,
		);
	});

	test("derives public base URL path from public URL", () => {
		const config = parseConfig({
			...passwordEnv,
			AGENTBOX_PUBLIC_URL: "https://example.com/box/",
		});
		expect(config.publicUrl).toBe("https://example.com/box");
		expect(createPublicAddress(config).baseUrlPath).toBe("/box");
	});

	test("defaults public URL to https when TLS files are configured", () => {
		const config = parseConfig(
			{
				...passwordEnv,
				AGENTBOX_TLS_KEY_PATH: "/missing-key.pem",
				AGENTBOX_TLS_CERT_PATH: "/missing-cert.pem",
				PORT: "443",
			},
			{ loadTlsFiles: false },
		);
		expect(config.publicUrl).toBe("https://localhost");
	});

	test("accepts a hostname-based public proxy URL template", () => {
		const config = parseConfig({
			...passwordEnv,
			AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE: "https://{{port}}.box.example.com",
		});
		expect(config.publicProxyUrlTemplate).toBe(
			"https://{{port}}.box.example.com",
		);
		expect(createPublicAddress(config).proxyHostnameTemplate).toBe(
			"{{port}}.box.example.com",
		);
	});

	test("accepts a patterned public proxy hostname template", () => {
		const config = parseConfig({
			...passwordEnv,
			AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE:
				"https://code-{{port}}.box.example.com",
		});
		expect(createPublicAddress(config).proxyHostnameTemplate).toBe(
			"code-{{port}}.box.example.com",
		);
	});

	test("accepts a relative public proxy URL template", () => {
		const config = parseConfig({
			...passwordEnv,
			AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE: "./ports/{{port}}",
		});
		expect(config.publicProxyUrlTemplate).toBe("./ports/{{port}}");
		expect(createPublicAddress(config).proxyHostnameTemplate).toBeUndefined();
	});

	test("rejects ambiguous public proxy URL templates", () => {
		expect(() =>
			parseConfig({
				...passwordEnv,
				AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE: "https://ports.example.com",
			}),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({
				...passwordEnv,
				AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE: "/ports/{{port}}",
			}),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({
				...passwordEnv,
				AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE:
					"https://user@{{port}}.ports.example.com",
			}),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({
				...passwordEnv,
				AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE: "./ports/{{port}}?debug=1",
			}),
		).toThrow(ConfigError);
	});

	test("parses explicit boolean and trusted proxy hop values", () => {
		const config = parseConfig({
			...passwordEnv,
			AGENTBOX_DISABLE_METRICS: "0",
			AGENTBOX_TRUSTED_PROXY_HOPS: "2",
			AGENTBOX_DISABLE_FILE_DOWNLOADS: "true",
			AGENTBOX_DISABLE_FILE_UPLOADS: "yes",
		});
		expect(config.disableMetrics).toBe(false);
		expect(config.trustedProxyHops).toBe(2);
		expect(config.disableFileDownloads).toBe(true);
		expect(config.disableFileUploads).toBe(true);
		expect(
			parseConfig({ ...passwordEnv, AGENTBOX_DISABLE_METRICS: "1" })
				.disableMetrics,
		).toBe(true);
	});

	test("rejects invalid boolean and trusted proxy hop values", () => {
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_DISABLE_METRICS: "maybe" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_TRUSTED_PROXY_HOPS: "1.5" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_DISABLE_FILE_DOWNLOADS: "maybe" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_DISABLE_FILE_UPLOADS: "maybe" }),
		).toThrow(ConfigError);
	});

	test("accepts an explicit workspace path", () => {
		const config = parseConfig({
			...passwordEnv,
			AGENTBOX_WORKSPACE_PATH: "/workspace",
		});
		expect(config.workspacePath).toBe("/workspace");
	});

	test("requires absolute volume path", () => {
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_VOLUME_PATH: "data" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_VOLUME_PATH: "/data\u001F" }),
		).toThrow(ConfigError);
	});

	test("rejects the filesystem root as the volume path", () => {
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_VOLUME_PATH: "/" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_VOLUME_PATH: "/data/.." }),
		).toThrow(ConfigError);
	});

	test("requires a normalized absolute workspace path", () => {
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_WORKSPACE_PATH: "workspace" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_WORKSPACE_PATH: "/" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_WORKSPACE_PATH: "/workspace/.." }),
		).toThrow(ConfigError);
	});

	test("requires TLS files to be configured together", () => {
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_TLS_KEY_PATH: "/key.pem" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_TLS_CERT_PATH: "/cert.pem" }),
		).toThrow(ConfigError);
	});

	test("requires absolute TLS file paths", () => {
		expect(() =>
			parseConfig(
				{
					...passwordEnv,
					AGENTBOX_TLS_KEY_PATH: "key.pem",
					AGENTBOX_TLS_CERT_PATH: "/cert.pem",
				},
				{ loadTlsFiles: false },
			),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig(
				{
					...passwordEnv,
					AGENTBOX_TLS_KEY_PATH: "/key.pem",
					AGENTBOX_TLS_CERT_PATH: "cert.pem",
				},
				{ loadTlsFiles: false },
			),
		).toThrow(ConfigError);
	});

	test("can parse TLS config without reading TLS files", () => {
		const config = parseConfig(
			{
				...passwordEnv,
				AGENTBOX_TLS_KEY_PATH: "/missing-key.pem",
				AGENTBOX_TLS_CERT_PATH: "/missing-cert.pem",
			},
			{ loadTlsFiles: false },
		);
		expect(config.tls).toEqual({
			filePaths: { key: "/missing-key.pem", cert: "/missing-cert.pem" },
		});
	});

	test("requires public URL to be a clean http or https base URL", () => {
		expect(() =>
			parseConfig({ ...passwordEnv, AGENTBOX_PUBLIC_URL: "ftp://example.com" }),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({
				...passwordEnv,
				AGENTBOX_PUBLIC_URL: "https://user@example.com",
			}),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({
				...passwordEnv,
				AGENTBOX_PUBLIC_URL: "https://example.com?debug=1",
			}),
		).toThrow(ConfigError);
		expect(() =>
			parseConfig({
				...passwordEnv,
				AGENTBOX_PUBLIC_URL: "https://example.com/\u001Fagentbox",
			}),
		).toThrow(ConfigError);
	});

	test("rejects control characters in public proxy URL templates", () => {
		expect(() =>
			parseConfig({
				...passwordEnv,
				AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE: "./ports/{{port}}\u001F",
			}),
		).toThrow(ConfigError);
	});
});
