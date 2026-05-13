import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseConfig, type AgentboxConfig } from "./config.ts";
import { CHILD_PROCESS_DEFAULTS, CODE_SERVER_DEFAULTS } from "./defaults.ts";
import { createPublicAddress } from "./gateway/public-address.ts";

export interface CodeServerStartPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly configPath: string;
	readonly configYaml: string;
	readonly authDisabled: boolean;
}

export function codeServerStartPlan(
	config: AgentboxConfig,
	parentEnv: NodeJS.ProcessEnv = process.env,
): CodeServerStartPlan {
	const publicAddress = createPublicAddress(config);
	const args = [
		config.workspacePath,
		"--config",
		CODE_SERVER_DEFAULTS.configPath,
		"--bind-addr",
		CODE_SERVER_DEFAULTS.bindAddress,
	];
	if (CODE_SERVER_DEFAULTS.disableUpdateCheck) {
		args.push("--disable-update-check");
	}
	if (config.disableFileDownloads) {
		args.push("--disable-file-downloads");
	}
	if (config.disableFileUploads) {
		args.push("--disable-file-uploads");
	}
	if (publicAddress.baseUrlPath !== "/") {
		args.push("--abs-proxy-base-path", publicAddress.baseUrlPath);
	}
	if (publicAddress.proxyHostnameTemplate) {
		args.push("--proxy-domain", publicAddress.proxyHostnameTemplate);
	}

	return {
		command: CODE_SERVER_DEFAULTS.binPath,
		args,
		env: codeServerChildEnv(config, parentEnv),
		configPath: CODE_SERVER_DEFAULTS.configPath,
		configYaml: codeServerConfigYaml(config),
		authDisabled: config.authType === "none",
	};
}

export function codeServerConfigYaml(config: AgentboxConfig): string {
	return [
		`bind-addr: ${CODE_SERVER_DEFAULTS.bindAddress}`,
		`auth: ${config.authType === "none" ? "none" : "password"}`,
		...(config.password ? [`password: ${yamlString(config.password)}`] : []),
		...(config.hashedPassword
			? [`hashed-password: ${yamlString(config.hashedPassword)}`]
			: []),
		"cert: false",
		"",
	].join("\n");
}

function codeServerChildEnv(
	config: AgentboxConfig,
	parentEnv: NodeJS.ProcessEnv,
): Record<string, string> {
	const env: Record<string, string> = {
		HOME: CHILD_PROCESS_DEFAULTS.homePath,
		USER: CHILD_PROCESS_DEFAULTS.userName,
		SHELL: CHILD_PROCESS_DEFAULTS.shellPath,
		PATH: parentEnv.PATH ?? CHILD_PROCESS_DEFAULTS.defaultPath,
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

function yamlString(value: string): string {
	return JSON.stringify(value);
}

export async function startCodeServer(): Promise<void> {
	const config = parseConfig(process.env, { loadTlsFiles: false });
	const plan = codeServerStartPlan(config);
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
