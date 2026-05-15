import { describe, expect, test } from "vitest";
import {
	codeServerConfigYaml,
	codeServerLaunchScript,
	codeServerStartPlan,
} from "../rootfs/opt/agentbox/code-server.ts";
import type { AgentboxConfig } from "../rootfs/opt/agentbox/config.ts";

describe("code-server start plan", () => {
	test("maps Agentbox password auth into code-server config", () => {
		const plan = codeServerStartPlan(config({ password: "secret" }), {
			PORT: "8080",
			PASSWORD: "ignored",
			HASHED_PASSWORD: "ignored",
			CODE_SERVER_CONFIG: "ignored",
			CS_DISABLE_PROXY: "ignored",
			PATH: "/bin",
		});
		expect(plan.env.PASSWORD).toBeUndefined();
		expect(plan.env.HASHED_PASSWORD).toBeUndefined();
		expect(plan.env.PORT).toBeUndefined();
		expect(plan.env.CODE_SERVER_CONFIG).toBeUndefined();
		expect(plan.env.CS_DISABLE_PROXY).toBeUndefined();
		expect(plan.env.PATH).toBe("/bin");
		expect(plan.configYaml).toContain("auth: password");
		expect(plan.configYaml).toContain('password: "secret"');
	});

	test("maps Agentbox hashed password into code-server config", () => {
		const plan = codeServerStartPlan(config({ hashedPassword: "hashed" }));
		expect(plan.env.PASSWORD).toBeUndefined();
		expect(plan.env.HASHED_PASSWORD).toBeUndefined();
		expect(plan.configYaml).toContain("auth: password");
		expect(plan.configYaml).toContain('hashed-password: "hashed"');
	});

	test("supports explicit auth none", () => {
		const plan = codeServerStartPlan(config({ authType: "none" }));
		expect(plan.authDisabled).toBe(true);
		expect(plan.env.PASSWORD).toBeUndefined();
		expect(plan.env.HASHED_PASSWORD).toBeUndefined();
		expect(plan.configYaml).toContain("auth: none");
	});

	test("uses the configured workspace path", () => {
		const plan = codeServerStartPlan(config({ workspacePath: "/workspace" }));
		expect(plan.args[0]).toBe("/workspace");
	});

	test("maps Agentbox code-server policy toggles into code-server flags", () => {
		const plan = codeServerStartPlan(
			config({
				disableFileDownloads: true,
				disableFileUploads: true,
			}),
		);
		expect(plan.args).toContain("--disable-file-downloads");
		expect(plan.args).toContain("--disable-file-uploads");
	});

	test("omits disabled code-server policy flags", () => {
		const plan = codeServerStartPlan(
			config({
				disableFileDownloads: false,
				disableFileUploads: false,
			}),
		);
		expect(plan.args).not.toContain("--disable-file-downloads");
		expect(plan.args).not.toContain("--disable-file-uploads");
		expect(plan.args).not.toContain("--disable-telemetry");
		expect(plan.args).not.toContain("--disable-workspace-trust");
	});

	test("adds public base URL path and public proxy hostname template arguments", () => {
		const plan = codeServerStartPlan(
			config({
				publicUrl: "http://localhost:8080/agentbox",
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
			'bind-addr: 127.0.0.1:13337\nauth: password\npassword: "secret"\ncert: false\n',
		);
	});

	test("renders an exec launch script so supervisor owns code-server directly", () => {
		const plan = codeServerStartPlan(config({ workspacePath: "/work'space" }), {
			PATH: "/bin:/usr/bin",
		});

		const script = codeServerLaunchScript(plan);
		expect(script).toContain("set -euo pipefail");
		expect(script).toContain("exec env -i");
		expect(script).toContain("'PATH=/bin:/usr/bin'");
		expect(script).toContain("'\"'\"'");
		expect(script).toContain("'/usr/local/bin/code-server'");
		expect(script).toContain("'--config' '/run/code-server/config.yaml'");
	});
});

function config(overrides: Partial<AgentboxConfig> = {}): AgentboxConfig {
	const result: AgentboxConfig = {
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
