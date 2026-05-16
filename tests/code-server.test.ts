import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("code-server launcher", () => {
	test("uses native code-server config with only a port default", () => {
		const script = readFileSync(
			resolve("rootfs/opt/agentbox/code-server.sh"),
			"utf8",
		);

		expect(script).toContain("/usr/local/bin/code-server");
		expect(script).toContain('--bind-addr "0.0.0.0:${PORT:-8080}"');
		expect(script).toContain(
			"--user-data-dir /home/user/.local/share/code-server",
		);
		expect(script).toContain("--disable-update-check");
		expect(script).not.toContain("AGENTBOX_");
		expect(script).not.toContain("VSCODE_PROXY_URI");
	});
});
