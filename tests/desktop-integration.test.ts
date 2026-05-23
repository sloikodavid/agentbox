import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const browserHelper =
	"/opt/code-server/current/lib/vscode/bin/helpers/browser.sh";

function readRepoFile(path: string): string {
	return readFileSync(resolve(repoRoot, path), "utf8");
}

function parseDesktopEntry(content: string): Map<string, string> {
	return new Map(
		content
			.split(/\r?\n/)
			.filter((line) => line && !line.startsWith("["))
			.map((line) => {
				const separator = line.indexOf("=");
				return [line.slice(0, separator), line.slice(separator + 1)];
			})
	);
}

function parseMimeDefaults(content: string): Map<string, string> {
	return new Map(
		content
			.split(/\r?\n/)
			.filter((line) => line && !line.startsWith("["))
			.map((line) => {
				const separator = line.indexOf("=");
				return [line.slice(0, separator), line.slice(separator + 1)];
			})
	);
}

describe("desktop URL and text editor integration", () => {
	test("uses a dedicated URL handler for HTTP links", () => {
		const entry = parseDesktopEntry(
			readRepoFile("rootfs/usr/share/applications/agentbox-url-handler.desktop")
		);

		expect(entry.get("GenericName")).toBe("URL Handler");
		expect(entry.get("Exec")).toBe(`${browserHelper} %U`);
		expect(entry.get("NoDisplay")).toBe("true");
		expect(entry.get("MimeType")).toBe(
			"x-scheme-handler/http;x-scheme-handler/https;"
		);
	});

	test("names the editor desktop file consistently", () => {
		const oldPath = resolve(
			repoRoot,
			"rootfs/usr/share/applications/agentbox-editor.desktop"
		);
		const newPath = resolve(
			repoRoot,
			"rootfs/usr/share/applications/agentbox-text-editor.desktop"
		);
		const entry = parseDesktopEntry(
			readRepoFile("rootfs/usr/share/applications/agentbox-text-editor.desktop")
		);

		expect(existsSync(oldPath)).toBe(false);
		expect(existsSync(newPath)).toBe(true);
		expect(entry.get("GenericName")).toBe("Text Editor");
		expect(entry.get("Exec")).toBe("code --reuse-window %F");
	});

	test("keeps MIME defaults split between URLs and text editing", () => {
		const defaults = parseMimeDefaults(
			readRepoFile("rootfs/etc/xdg/mimeapps.list")
		);

		expect(defaults.get("x-scheme-handler/http")).toBe(
			"agentbox-url-handler.desktop"
		);
		expect(defaults.get("x-scheme-handler/https")).toBe(
			"agentbox-url-handler.desktop"
		);

		for (const mime of [
			"inode/directory",
			"text/plain",
			"text/markdown",
			"application/json",
			"text/html",
			"application/x-shellscript"
		]) {
			expect(defaults.get(mime)).toBe("agentbox-text-editor.desktop");
		}

		expect([...defaults.values()]).not.toContain("agentbox-editor.desktop");
	});

	test("exports BROWSER at image scope instead of only interactive bash startup", () => {
		const dockerfile = readRepoFile("Dockerfile");
		const bashrc = readRepoFile("rootfs/home/user/.bashrc");

		expect(dockerfile).toContain(`BROWSER="${browserHelper}"`);
		expect(bashrc).not.toContain("BROWSER=");
	});
});
