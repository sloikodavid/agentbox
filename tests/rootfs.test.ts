import {
	link,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
	isExcludedPath,
	markRemoved,
	removalMarkerForLivePath,
	removeStoredPath,
	restoreRootfs,
	rootfsPaths,
	storeAncestors,
	storePath,
	storedPathForLivePath,
	unmarkRemoved,
} from "../rootfs/opt/agentbox/rootfs.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
	tempDirs.length = 0;
});

describe("rootfs path mapping", () => {
	test("maps live paths into store paths", () => {
		const paths = rootfsPaths({ volumePath: "/data", rootPath: "/" });
		expect(storedPathForLivePath("/etc/hosts", paths)).toBe(
			join("/data/rootfs/files", "etc/hosts"),
		);
		expect(storedPathForLivePath("/..agentbox", paths)).toBe(
			join("/data/rootfs/files", "..agentbox"),
		);
		expect(removalMarkerForLivePath("/etc/hosts", paths)).toBe(
			join("/data/rootfs/removed-files", "etc/hosts.__removed__"),
		);
	});

	test("does not treat sibling paths as custom-root ancestors", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		const sibling = `${root}-sibling`;
		tempDirs.push(root, volume, sibling);
		await mkdir(sibling, { recursive: true });
		await expect(
			storeAncestors(join(sibling, "file.txt"), {
				rootPath: root,
				volumePath: volume,
			}),
		).resolves.toBeUndefined();
	});

	test("excludes volatile paths, control-plane paths, and volume path", () => {
		const paths = rootfsPaths({ volumePath: "/data", rootPath: "/" });
		expect(isExcludedPath("/proc/cpuinfo", paths)).toBe(true);
		expect(isExcludedPath("/etc/supervisor/supervisord.conf", paths)).toBe(
			true,
		);
		expect(isExcludedPath("/etc/supervisor/conf.d/agentbox.conf", paths)).toBe(
			true,
		);
		expect(isExcludedPath("/data/rootfs/files/etc/passwd", paths)).toBe(true);
		expect(isExcludedPath("/custom-persist", paths)).toBe(false);
	});

	test("keeps selected image defaults user-persistable", () => {
		const paths = rootfsPaths({ volumePath: "/data", rootPath: "/" });
		expect(isExcludedPath("/etc/sudoers.d/user", paths)).toBe(false);
		expect(isExcludedPath("/etc/mailcap", paths)).toBe(false);
		expect(isExcludedPath("/etc/xdg/mimeapps.list", paths)).toBe(false);
		expect(
			isExcludedPath("/usr/share/applications/agentbox.desktop", paths),
		).toBe(false);
	});
});

describe("rootfs storage", () => {
	test("stores and unmarks files and symlinks", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		tempDirs.push(root, volume);
		const liveFile = join(root, "etc/config.txt");
		await mkdir(join(root, "etc"), { recursive: true });
		await writeFile(liveFile, "hello");
		await markRemoved(liveFile, { rootPath: root, volumePath: volume });
		await storePath(liveFile, { rootPath: root, volumePath: volume });
		expect(
			await readFile(join(volume, "rootfs/files/etc/config.txt"), "utf8"),
		).toBe("hello");

		const link = join(root, "etc/link.txt");
		await symlink("config.txt", link);
		await storePath(link, { rootPath: root, volumePath: volume });
		expect(await readlink(join(volume, "rootfs/files/etc/link.txt"))).toBe(
			"config.txt",
		);
		const dangling = join(root, "etc/dangling.txt");
		await symlink("missing.txt", dangling);
		await storePath(dangling, { rootPath: root, volumePath: volume });
		expect(await readlink(join(volume, "rootfs/files/etc/dangling.txt"))).toBe(
			"missing.txt",
		);
		await unmarkRemoved(liveFile, { rootPath: root, volumePath: volume });
	});

	test("restore applies removal markers", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		tempDirs.push(root, volume);
		await mkdir(join(volume, "rootfs/files"), { recursive: true });
		await writeFile(join(volume, "rootfs/files/restored.txt"), "restored");
		await markRemoved(join(root, "removed.txt"), {
			rootPath: root,
			volumePath: volume,
		});
		await writeFile(join(root, "removed.txt"), "remove me");
		await restoreRootfs({ rootPath: root, volumePath: volume });
		expect(await readFile(join(root, "restored.txt"), "utf8")).toBe("restored");
		await expect(readFile(join(root, "removed.txt"), "utf8")).rejects.toThrow();
	});

	test("clears ancestor removal markers when descendants return", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		tempDirs.push(root, volume);
		const parent = join(root, "opt/app");
		const child = join(parent, "config.json");
		await markRemoved(join(root, "opt"), {
			rootPath: root,
			volumePath: volume,
		});
		await markRemoved(parent, { rootPath: root, volumePath: volume });
		await mkdir(parent, { recursive: true });
		await writeFile(child, "{}");
		await storePath(child, { rootPath: root, volumePath: volume });
		await expect(
			readFile(
				removalMarkerForLivePath(
					parent,
					rootfsPaths({ rootPath: root, volumePath: volume }),
				),
			),
		).rejects.toThrow();
		await expect(
			readFile(
				removalMarkerForLivePath(
					join(root, "opt"),
					rootfsPaths({ rootPath: root, volumePath: volume }),
				),
			),
		).rejects.toThrow();
	});

	test("falls back when a previous hardlink mirror target was removed", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		tempDirs.push(root, volume);
		const first = join(root, "first.txt");
		const second = join(root, "second.txt");
		await writeFile(first, "linked");
		await link(first, second);
		await storePath(first, { rootPath: root, volumePath: volume });
		await removeStoredPath(first, { rootPath: root, volumePath: volume });
		await storePath(second, { rootPath: root, volumePath: volume });
		expect(
			await readFile(
				storedPathForLivePath(
					second,
					rootfsPaths({ rootPath: root, volumePath: volume }),
				),
				"utf8",
			),
		).toBe("linked");
	});
});
