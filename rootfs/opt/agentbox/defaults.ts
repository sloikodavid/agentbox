export const CONFIG_DEFAULTS = {
	port: 8080,
	bindAddress: "::",
	volumePath: "/data",
	authType: "password",
	publicProxyUrlTemplate: "./proxy/{{port}}",
	workspacePath: "/home/user/Desktop",
	trustedProxyHops: 0,
	disableMetrics: true,
	disableFileDownloads: false,
	disableFileUploads: false,
	buildVersion: "unknown",
	buildRevision: "unknown",
	buildSource: "https://github.com/sloikodavid/agentbox",
} as const;

export const CODE_SERVER_DEFAULTS = {
	origin: "http://127.0.0.1:13337",
	binPath: "/usr/local/bin/code-server",
	bindAddress: "127.0.0.1:13337",
	configPath: "/run/code-server/config.yaml",
	disableUpdateCheck: true,
} as const;

export const GATEWAY_DEFAULTS = {
	readinessPollIntervalMs: 1_000,
	codeServerHealthTimeoutMs: 1_000,
	proxyToCodeServerTimeoutMs: 5_000,
} as const;

export const CHILD_PROCESS_DEFAULTS = {
	userName: "user",
	homePath: "/home/user",
	shellPath: "/bin/bash",
	defaultPath: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
} as const;

export const PERSISTENCE_DEFAULTS = {
	heartbeatPath: "/run/agentbox/persistd.ready",
	heartbeatMaxAgeMs: 15_000,
} as const;
