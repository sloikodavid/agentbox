import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseConfig, type AgentboxConfig } from "./config.ts";

const CODE_SERVER_BIN = "/usr/local/bin/code-server";
const CODE_SERVER_BIND_ADDRESS = "127.0.0.1:13337";
const CODE_SERVER_WORKSPACE_PATH = "/home/user/Desktop";
const CODE_SERVER_CONFIG_PATH = "/run/code-server/config.yaml";
const DEFAULT_PATH =
	"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface CodeServerLaunchPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly configPath: string;
	readonly configYaml: string;
	readonly authDisabled: boolean;
}

export function codeServerLaunchPlan(
	config: AgentboxConfig,
	parentEnv: NodeJS.ProcessEnv = process.env,
): CodeServerLaunchPlan {
	const args = [
		CODE_SERVER_WORKSPACE_PATH,
		"--config",
		CODE_SERVER_CONFIG_PATH,
		"--bind-addr",
		CODE_SERVER_BIND_ADDRESS,
		"--disable-update-check",
	];
	if (config.publicUrlPath !== "/") {
		args.push("--abs-proxy-base-path", config.publicUrlPath);
	}
	if (config.proxyDomain) {
		args.push("--proxy-domain", config.proxyDomain);
	}

	return {
		command: CODE_SERVER_BIN,
		args,
		env: codeServerChildEnv(config, parentEnv),
		configPath: CODE_SERVER_CONFIG_PATH,
		configYaml: codeServerConfigYaml(config),
		authDisabled: config.authType === "none",
	};
}

export function codeServerConfigYaml(config: AgentboxConfig): string {
	return [
		`bind-addr: ${CODE_SERVER_BIND_ADDRESS}`,
		`auth: ${config.authType === "none" ? "none" : "password"}`,
		"cert: false",
		"",
	].join("\n");
}

function codeServerChildEnv(
	config: AgentboxConfig,
	parentEnv: NodeJS.ProcessEnv,
): Record<string, string> {
	const env: Record<string, string> = {
		HOME: "/home/user",
		USER: "user",
		SHELL: "/bin/bash",
		PATH: parentEnv.PATH ?? DEFAULT_PATH,
		EDITOR: "code --wait",
		VISUAL: "code --wait",
		GIT_EDITOR: "code --wait",
		KUBE_EDITOR: "code --wait",
		VSCODE_PROXY_URI: config.publicProxyUrlTemplate,
	};
	copyIfSet(parentEnv, env, "LANG");
	copyIfSet(parentEnv, env, "LC_ALL");
	copyIfSet(parentEnv, env, "TZ");
	copyIfSet(parentEnv, env, "HTTP_PROXY");
	copyIfSet(parentEnv, env, "HTTPS_PROXY");
	copyIfSet(parentEnv, env, "NO_PROXY");
	copyIfSet(parentEnv, env, "http_proxy");
	copyIfSet(parentEnv, env, "https_proxy");
	copyIfSet(parentEnv, env, "no_proxy");
	if (config.authType === "password") {
		if (config.password) {
			env.PASSWORD = config.password;
		}
		if (config.hashedPassword) {
			env.HASHED_PASSWORD = config.hashedPassword;
		}
	}
	return env;
}

function copyIfSet(
	from: NodeJS.ProcessEnv,
	to: Record<string, string>,
	name: string,
): void {
	const value = from[name];
	if (value !== undefined) {
		to[name] = value;
	}
}

async function startCodeServer(): Promise<void> {
	const config = parseConfig(process.env, { loadTlsFiles: false });
	const plan = codeServerLaunchPlan(config);
	await mkdir(dirname(plan.configPath), { recursive: true });
	await writeFile(plan.configPath, plan.configYaml, { mode: 0o600 });
	if (plan.authDisabled) {
		log(
			"WARNING: AGENTBOX_AUTH=none disables workspace authentication. Only use behind trusted external access control.",
		);
	}

	const child = spawn(plan.command, plan.args, {
		env: plan.env,
		stdio: "inherit",
	});
	const forward = (signal: NodeJS.Signals): void => {
		if (!child.killed) {
			child.kill(signal);
		}
	};
	process.once("SIGTERM", forward);
	process.once("SIGINT", forward);
	await new Promise<void>((resolve) => {
		child.on("exit", (code) => {
			process.off("SIGTERM", forward);
			process.off("SIGINT", forward);
			process.exitCode = code ?? 1;
			resolve();
		});
		child.on("error", (error) => {
			log(`failed to start code-server: ${String(error)}`);
			process.exitCode = 1;
			resolve();
		});
	});
}

function log(message: string): void {
	console.log(`[agentbox-code-server] ${message}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await startCodeServer();
}
