import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

function readText(path: string): string {
	return readFileSync(resolve(path), "utf8").replaceAll("\r\n", "\n");
}

function supervisorProgram(name: string): string {
	const supervisor = readText("rootfs/etc/supervisor/conf.d/agentbox.conf");
	const programStart = supervisor.search(
		new RegExp(`^\\[program:${name}\\]$`, "m"),
	);
	expect(programStart).toBeGreaterThanOrEqual(0);

	const programTail = supervisor.slice(programStart + 1);
	const nextProgram = programTail.search(/^\[/m);

	return nextProgram === -1
		? supervisor.slice(programStart)
		: supervisor.slice(programStart, programStart + nextProgram + 1);
}

describe("code-server launcher", () => {
	test("starts code-server without shadowing code-server config", () => {
		const launcher = readText("rootfs/opt/agentbox/code-server.sh");

		expect(launcher).toMatch(/^exec \/usr\/local\/bin\/code-server$/m);
		expect(launcher).not.toMatch(
			/(?:^|\s)--(?:auth|bind-addr|cert|config|hashed-password|password|user-data-dir)(?:\s|=|$)/,
		);
	});
});

describe("Agentbox entrypoint", () => {
	test("only runs restore before supervisor", () => {
		expect(readText("rootfs/opt/agentbox/entrypoint.sh")).toBe(
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				"",
				"/opt/agentbox/bin/persistd restore",
				"exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf",
				"",
			].join("\n"),
		);
	});
});

describe("compose code-server environment", () => {
	test("does not pass code-server config inputs through Compose", () => {
		expect(readText("compose.yml")).toContain('"${PORT:-8080}:8080"');
	});
});

describe("supervisor code-server environment", () => {
	test("does not pass code-server config or auth inputs", () => {
		const program = supervisorProgram("code-server");

		for (const name of [
			"CODE_SERVER_CONFIG",
			"CODE_SERVER_HOST",
			"HASHED_PASSWORD",
			"PASSWORD",
			"PORT",
		]) {
			expect(program).not.toMatch(new RegExp(`(?:^|,)${name}=`));
		}
	});
});

describe("code-server default config patch", () => {
	const patch = readText(
		"vendor/code-server/patches/0004-default-bind-address.patch",
	);

	test("only changes the generated default bind address", () => {
		expect(patch).toContain("diff --git a/out/node/cli.js b/out/node/cli.js");
		expect(patch).toContain("function defaultConfigFile(password) {");
		expect(patch).toContain("-    return `bind-addr: 127.0.0.1:8080");
		expect(patch).toContain("+    return `bind-addr: 0.0.0.0:8080");
		expect(patch).toContain(
			[" auth: password", " password: ${password}", " cert: false"].join("\n"),
		);
	});
});

describe("code-server Agentbox startup URL patch", () => {
	const patch = readText(
		"vendor/code-server/patches/0003-log-agentbox-access-url.patch",
	);

	test("logs the browser URL from code-server's resolved server address", () => {
		expect(patch).toContain(
			'const agentboxAddress = typeof serverAddress === "string" ? undefined : (0, util_2.toBrowserAddress)(serverAddress);',
		);
		expect(patch).toContain(
			"Agentbox is ready at ${agentboxAddress.toString()}",
		);
		expect(patch).toContain("exports.toBrowserAddress");
		expect(patch).toContain('url.hostname === "0.0.0.0"');
		expect(patch).toContain('url.hostname = "localhost"');
	});
});
