import { describe, expect, test } from "vitest";
import {
	codeServerConfigYaml,
	codeServerLaunchPlan,
} from "../rootfs/opt/agentbox/code-server.ts";
import type { AgentboxConfig } from "../rootfs/opt/agentbox/config.ts";

describe("code-server launch plan", () => {
	test("maps Agentbox password auth into code-server child env", () => {
		const plan = codeServerLaunchPlan(config({ password: "secret" }), {
			PORT: "8080",
			PASSWORD: "ignored",
			HASHED_PASSWORD: "ignored",
			CODE_SERVER_CONFIG: "ignored",
			CS_DISABLE_PROXY: "ignored",
			PATH: "/bin",
		});
		expect(plan.env.PASSWORD).toBe("secret");
		expect(plan.env.HASHED_PASSWORD).toBeUndefined();
		expect(plan.env.PORT).toBeUndefined();
		expect(plan.env.CODE_SERVER_CONFIG).toBeUndefined();
		expect(plan.env.CS_DISABLE_PROXY).toBeUndefined();
		expect(plan.env.PATH).toBe("/bin");
		expect(plan.configYaml).toContain("auth: password");
	});

	test("maps Agentbox hashed password into code-server child env", () => {
		const plan = codeServerLaunchPlan(config({ hashedPassword: "hashed" }));
		expect(plan.env.PASSWORD).toBeUndefined();
		expect(plan.env.HASHED_PASSWORD).toBe("hashed");
		expect(plan.configYaml).toContain("auth: password");
	});

	test("supports explicit auth none", () => {
		const plan = codeServerLaunchPlan(config({ authType: "none" }));
		expect(plan.authDisabled).toBe(true);
		expect(plan.env.PASSWORD).toBeUndefined();
		expect(plan.env.HASHED_PASSWORD).toBeUndefined();
		expect(plan.configYaml).toContain("auth: none");
	});

	test("adds public URL path and proxy domain arguments", () => {
		const plan = codeServerLaunchPlan(
			config({
				publicUrlPath: "/agentbox",
				proxyDomain: "{{port}}.box.example.com",
				publicProxyUrlTemplate: "https://{{port}}.box.example.com",
			}),
		);
		expect(plan.args).toContain("--abs-proxy-base-path");
		expect(plan.args).toContain("/agentbox");
		expect(plan.args).toContain("--proxy-domain");
		expect(plan.args).toContain("{{port}}.box.example.com");
		expect(plan.env.VSCODE_PROXY_URI).toBe("https://{{port}}.box.example.com");
	});

	test("writes a minimal ephemeral config", () => {
		expect(codeServerConfigYaml(config())).toBe(
			"bind-addr: 127.0.0.1:13337\nauth: password\ncert: false\n",
		);
	});
});

function config(overrides: Partial<AgentboxConfig> = {}): AgentboxConfig {
	const result: AgentboxConfig = {
		port: 8080,
		bindAddress: "127.0.0.1",
		volumePath: "/data",
		publicUrlPath: "/",
		publicUrl: "http://localhost:8080",
		publicProxyUrlTemplate: "./proxy/{{port}}",
		trustedProxyHops: 0,
		enableMetrics: false,
		authType: "password",
		password: "secret",
		buildVersion: "test",
		buildRevision: "test",
		buildSource: "test",
		...overrides,
	};
	if (overrides.hashedPassword || overrides.authType === "none") {
		delete (result as { password?: string }).password;
	}
	return result;
}
