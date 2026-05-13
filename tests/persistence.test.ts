import {
	link,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createPersistence } from "../rootfs/opt/agentbox/persistence/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
	tempDirs.length = 0;
});

describe("persistence policy", () => {
	test("excludes volatile paths, control-plane paths, and volume path", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		tempDirs.push(root, volume);
		const persistence = createPersistence({
			rootPath: root,
			volumePath: volume,
		});

		expect(persistence.shouldPersist(join(root, "proc/cpuinfo"))).toBe(false);
		expect(persistence.shouldPersist(join(root, "etc/supervisor/conf.d"))).toBe(
			false,
		);
		expect(
			persistence.shouldPersist(join(volume, "rootfs/files/etc/passwd")),
		).toBe(false);
		expect(persistence.shouldPersist(join(root, "custom-persist"))).toBe(true);
	});

	test("keeps selected image defaults user-persistable and excludes control-plane desktop entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		tempDirs.push(root, volume);
		const persistence = createPersistence({
			rootPath: root,
			volumePath: volume,
		});

		expect(persistence.shouldPersist(join(root, "etc/sudoers.d/user"))).toBe(
			true,
		);
		expect(persistence.shouldPersist(join(root, "etc/mailcap"))).toBe(true);
		expect(persistence.shouldPersist(join(root, "etc/xdg/mimeapps.list"))).toBe(
			true,
		);
		expect(
			persistence.shouldPersist(
				join(root, "usr/share/applications/agentbox.desktop"),
			),
		).toBe(false);
	});

	test("rejects direct changes outside the configured root", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		const sibling = `${root}-sibling`;
		tempDirs.push(root, volume, sibling);
		await mkdir(sibling, { recursive: true });
		const outsideFile = join(sibling, "file.txt");
		await writeFile(outsideFile, "outside");
		const persistence = createPersistence({
			rootPath: root,
			volumePath: volume,
		});

		await expect(
			persistence.record({ type: "present", livePath: outsideFile }),
		).rejects.toThrow("outside");
	});
});

describe("persistence", () => {
	test("records files and symlinks, then restores them", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const liveFile = join(root, "etc/config.txt");
		await mkdir(join(root, "etc"), { recursive: true });
		await writeFile(liveFile, "hello");
		await persistence.record({ type: "present", livePath: liveFile });

		const linkPath = join(root, "etc/link.txt");
		await symlink("config.txt", linkPath);
		await persistence.record({ type: "present", livePath: linkPath });

		const dangling = join(root, "etc/dangling.txt");
		await symlink("missing.txt", dangling);
		await persistence.record({ type: "present", livePath: dangling });

		await rm(join(root, "etc"), { recursive: true, force: true });
		await persistence.restore();

		expect(await readFile(join(root, "etc/config.txt"), "utf8")).toBe("hello");
		expect(await readlink(join(root, "etc/link.txt"))).toBe("config.txt");
		expect(await readlink(join(root, "etc/dangling.txt"))).toBe("missing.txt");
		expect(
			persistence.shouldPersist(join(volume, "rootfs/files/etc/config.txt")),
		).toBe(false);
	});

	test("migrates legacy rootfs-persistence storage into rootfs storage", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
		const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
		tempDirs.push(root, volume);
		const legacyFile = join(volume, "rootfs-persistence/files/etc/legacy.txt");
		await mkdir(join(volume, "rootfs-persistence/files/etc"), {
			recursive: true,
		});
		await writeFile(legacyFile, "legacy");
		const persistence = createPersistence({
			rootPath: root,
			volumePath: volume,
		});

		await persistence.restore();

		expect(await readFile(join(root, "etc/legacy.txt"), "utf8")).toBe("legacy");
		expect(
			await readFile(join(volume, "rootfs/files/etc/legacy.txt"), "utf8"),
		).toBe("legacy");
	});

	test("records removals, then applies them on restore", async () => {
		const { root, persistence } = await createTempPersistence();
		const liveFile = join(root, "removed.txt");
		await writeFile(liveFile, "persisted");
		await persistence.record({ type: "present", livePath: liveFile });

		await rm(liveFile);
		await persistence.record({ type: "removed", livePath: liveFile });
		await writeFile(liveFile, "stale image content");

		await persistence.restore();

		await expect(readFile(liveFile, "utf8")).rejects.toThrow();
	});

	test("keeps a descendant that returns after an ancestor was removed", async () => {
		const { root, persistence } = await createTempPersistence();
		const parent = join(root, "opt/app");
		const child = join(parent, "config.json");

		await mkdir(parent, { recursive: true });
		await writeFile(child, "old");
		await persistence.record({ type: "present", livePath: child });

		await rm(join(root, "opt"), { recursive: true });
		await persistence.record({
			type: "removed",
			livePath: join(root, "opt"),
		});

		await mkdir(parent, { recursive: true });
		await writeFile(child, "{}\n");
		await persistence.record({ type: "present", livePath: child });

		await rm(join(root, "opt"), { recursive: true });
		await persistence.restore();

		expect(await readFile(child, "utf8")).toBe("{}\n");
	});

	test("preserves hardlinks within one persistence instance", async () => {
		const { root, persistence } = await createTempPersistence();
		const first = join(root, "first.txt");
		const second = join(root, "second.txt");
		await writeFile(first, "linked");
		await link(first, second);

		await persistence.record({ type: "present", livePath: first });
		await persistence.record({ type: "present", livePath: second });
		await rm(first);
		await rm(second);

		await persistence.restore();

		const firstStats = await stat(first);
		const secondStats = await stat(second);
		expect(firstStats.ino).toBe(secondStats.ino);
		expect(await readFile(second, "utf8")).toBe("linked");
	});

	test("reconciles missed updates, creations, and removals", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const mirror = await mkdtemp(join(tmpdir(), "agentbox-mirror-"));
		tempDirs.push(mirror);
		const mirrorPersistence = createPersistence({
			rootPath: mirror,
			volumePath: volume,
		});
		const parent = join(root, "project");
		const changed = join(parent, "changed.txt");
		const created = join(parent, "created.txt");
		const removed = join(parent, "removed.txt");

		await mkdir(parent, { recursive: true });
		await writeFile(changed, "old");
		await writeFile(removed, "old");
		await persistence.record({ type: "present", livePath: changed });
		await persistence.record({ type: "present", livePath: removed });

		await writeFile(changed, "new");
		await writeFile(created, "created");
		await rm(removed);
		await persistence.reconcile(parent);
		await mirrorPersistence.restore();

		expect(await readFile(join(mirror, "project/changed.txt"), "utf8")).toBe(
			"new",
		);
		expect(await readFile(join(mirror, "project/created.txt"), "utf8")).toBe(
			"created",
		);
		await expect(
			readFile(join(mirror, "project/removed.txt"), "utf8"),
		).rejects.toThrow();
	});

	test("reconcile keeps child removals when the parent directory remains", async () => {
		const { root, persistence } = await createTempPersistence();
		const parent = join(root, "settings");
		const child = join(parent, "deleted.json");
		await mkdir(parent, { recursive: true });
		await writeFile(child, "persisted");
		await persistence.record({ type: "present", livePath: child });

		await rm(child);
		await persistence.reconcile(parent);
		await writeFile(child, "stale image content");
		await persistence.restore();

		await expect(readFile(child, "utf8")).rejects.toThrow();
	});

	test("reconcile treats file replacing directory as the final live state", async () => {
		const { root, persistence } = await createTempPersistence();
		const parent = join(root, "replace");
		const target = join(parent, "target");
		const child = join(target, "child.txt");
		await mkdir(target, { recursive: true });
		await writeFile(child, "old child");
		await persistence.record({ type: "present", livePath: child });

		await rm(target, { recursive: true });
		await writeFile(target, "now a file");
		await persistence.reconcile(parent);
		await rm(parent, { recursive: true });
		await persistence.restore();

		expect(await readFile(target, "utf8")).toBe("now a file");
	});

	test("reconcile prunes stale stored entries for excluded paths", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		await mkdir(join(root, "home/user"), { recursive: true });
		const staleExcludedDirectory = join(
			volume,
			"rootfs/files/home/user/.cache",
		);
		const staleExcludedFile = join(staleExcludedDirectory, "stale.txt");
		await mkdir(staleExcludedDirectory, { recursive: true });
		await writeFile(staleExcludedFile, "must not persist");

		await persistence.reconcile(root);

		await expect(readFile(staleExcludedFile, "utf8")).rejects.toThrow();
	});

	test("restore ignores stale stored entries and removal markers for excluded paths", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const excludedLiveFile = join(root, "home/user/.cache/cache.txt");
		const excludedStoredFile = join(
			volume,
			"rootfs/files/home/user/.cache/stale.txt",
		);
		const excludedMarker = join(
			volume,
			"rootfs/removed-files/home/user/.cache/cache.txt.__removed__",
		);
		await mkdir(join(root, "home/user/.cache"), { recursive: true });
		await mkdir(join(volume, "rootfs/files/home/user/.cache"), {
			recursive: true,
		});
		await mkdir(join(volume, "rootfs/removed-files/home/user/.cache"), {
			recursive: true,
		});
		await writeFile(excludedLiveFile, "cache");
		await writeFile(excludedStoredFile, "stale");
		await writeFile(excludedMarker, "");

		await persistence.restore();

		expect(await readFile(excludedLiveFile, "utf8")).toBe("cache");
		await expect(
			readFile(join(root, "home/user/.cache/stale.txt")),
		).rejects.toThrow();
	});

	test("reconcile detects same-size mtime-preserved content changes", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const mirror = await mkdtemp(join(tmpdir(), "agentbox-mirror-"));
		tempDirs.push(mirror);
		const file = join(root, "same-size.txt");
		await writeFile(file, "AAAA");
		await persistence.record({ type: "present", livePath: file });
		const original = await stat(file);

		await writeFile(file, "BBBB");
		await utimes(file, original.atime, original.mtime);
		await persistence.reconcile(root);
		await createPersistence({ rootPath: mirror, volumePath: volume }).restore();

		expect(await readFile(join(mirror, "same-size.txt"), "utf8")).toBe("BBBB");
	});

	test("reconcile repairs a new hardlink to an already persisted file", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const mirror = await mkdtemp(join(tmpdir(), "agentbox-mirror-"));
		tempDirs.push(mirror);
		const first = join(root, "first.txt");
		const second = join(root, "second.txt");
		await writeFile(first, "linked");
		await persistence.record({ type: "present", livePath: first });
		await link(first, second);

		await persistence.reconcile(root);
		await createPersistence({ rootPath: mirror, volumePath: volume }).restore();

		expect((await stat(join(mirror, "first.txt"))).ino).toBe(
			(await stat(join(mirror, "second.txt"))).ino,
		);
	});

	test("serializes concurrent public record and reconcile calls", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const mirror = await mkdtemp(join(tmpdir(), "agentbox-mirror-"));
		tempDirs.push(mirror);
		await mkdir(join(root, "tree/a"), { recursive: true });
		await mkdir(join(root, "tree/b"), { recursive: true });
		for (let index = 0; index < 25; index += 1) {
			await writeFile(join(root, `tree/a/${index}.txt`), `a-${index}`);
			await writeFile(join(root, `tree/b/${index}.txt`), `b-${index}`);
		}

		await Promise.all([
			persistence.reconcile(root),
			persistence.reconcile(join(root, "tree/a")),
			persistence.reconcile(join(root, "tree/b")),
			persistence.record({
				type: "present",
				livePath: join(root, "tree/a/24.txt"),
			}),
		]);
		await createPersistence({ rootPath: mirror, volumePath: volume }).restore();

		expect(await readFile(join(mirror, "tree/a/24.txt"), "utf8")).toBe("a-24");
		expect(await readFile(join(mirror, "tree/b/24.txt"), "utf8")).toBe("b-24");
	});

	test("record through a symlink ancestor cannot persist outside the root", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const outside = await mkdtemp(join(tmpdir(), "agentbox-outside-"));
		tempDirs.push(outside);
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(root, "outside-link"));

		await expect(
			persistence.record({
				type: "present",
				livePath: join(root, "outside-link/secret.txt"),
			}),
		).rejects.toThrow("resolves outside");
		await expect(
			readFile(join(volume, "rootfs/files/outside-link/secret.txt")),
		).rejects.toThrow();
	});

	test("watch startup does not persist an unchanged preexisting tree", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		await mkdir(join(root, "usr/bin"), { recursive: true });
		await writeFile(join(root, "usr/bin/preexisting"), "image baseline");
		const watcher = await persistence.watch();
		try {
			await expect(
				readFile(join(volume, "rootfs/files/usr/bin/preexisting"), "utf8"),
			).rejects.toThrow();
		} finally {
			await watcher.stop();
		}
	});

	test("watch reconciles changed files without persisting unchanged siblings", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		await mkdir(join(root, "usr/bin"), { recursive: true });
		const changed = join(root, "usr/bin/changed");
		const sibling = join(root, "usr/bin/sibling");
		await writeFile(changed, "before");
		await writeFile(sibling, "baseline");
		const watcher = await persistence.watch();
		try {
			await writeFile(changed, "after");
			await waitFor(async () => {
				return (
					(await readFile(
						join(volume, "rootfs/files/usr/bin/changed"),
						"utf8",
					)) === "after"
				);
			});
			await expect(
				readFile(join(volume, "rootfs/files/usr/bin/sibling"), "utf8"),
			).rejects.toThrow();
		} finally {
			await watcher.stop();
		}
	});

	test("watches later changes under user-created root directories", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const mirror = await mkdtemp(join(tmpdir(), "agentbox-mirror-"));
		tempDirs.push(mirror);
		const mirrorPersistence = createPersistence({
			rootPath: mirror,
			volumePath: volume,
		});
		const watcher = await persistence.watch();
		try {
			expect(watcher.status().watcherCount).toBeGreaterThan(0);
			const customDirectory = join(root, "foo123");
			const nestedFile = join(customDirectory, "nested.txt");
			const mirrorFile = join(mirror, "foo123/nested.txt");

			await mkdir(customDirectory);
			await writeFile(nestedFile, "first");
			await waitForRestoredFileContent(mirrorPersistence, mirrorFile, "first");

			await writeFile(nestedFile, "changed");
			await waitForRestoredFileContent(
				mirrorPersistence,
				mirrorFile,
				"changed",
			);

			await rm(nestedFile);
			await waitForRestoredPathRemoval(mirrorPersistence, mirrorFile);
		} finally {
			await watcher.stop();
		}
	});

	test("continues after removing nested watched directories", async () => {
		const { root, persistence, volume } = await createTempPersistence();
		const mirror = await mkdtemp(join(tmpdir(), "agentbox-mirror-"));
		tempDirs.push(mirror);
		const mirrorPersistence = createPersistence({
			rootPath: mirror,
			volumePath: volume,
		});
		const watcher = await persistence.watch();
		try {
			const parent = join(root, "logs");
			const nested = join(parent, "old-session/exthost1/vscode.github");
			const nestedFile = join(nested, "trace.log");
			const mirrorFile = join(
				mirror,
				"logs/old-session/exthost1/vscode.github/trace.log",
			);
			const laterFile = join(parent, "later.log");
			const mirrorLaterFile = join(mirror, "logs/later.log");

			await mkdir(nested, { recursive: true });
			await writeFile(nestedFile, "old");
			await waitForRestoredFileContent(mirrorPersistence, mirrorFile, "old");

			await rm(join(parent, "old-session"), { recursive: true });
			await waitForRestoredPathRemoval(
				mirrorPersistence,
				join(mirror, "logs/old-session"),
			);

			await writeFile(laterFile, "still watching");
			await waitForRestoredFileContent(
				mirrorPersistence,
				mirrorLaterFile,
				"still watching",
			);
		} finally {
			await watcher.stop();
		}
	});
});

async function createTempPersistence(): Promise<{
	readonly root: string;
	readonly volume: string;
	readonly persistence: ReturnType<typeof createPersistence>;
}> {
	const root = await mkdtemp(join(tmpdir(), "agentbox-live-"));
	const volume = await mkdtemp(join(tmpdir(), "agentbox-volume-"));
	tempDirs.push(root, volume);
	return {
		root,
		volume,
		persistence: createPersistence({
			rootPath: root,
			volumePath: volume,
			heartbeatPath: join(volume, "persistence.ready"),
		}),
	};
}

async function waitForRestoredFileContent(
	persistence: ReturnType<typeof createPersistence>,
	path: string,
	expected: string,
): Promise<void> {
	await waitFor(async () => {
		await persistence.restore();
		return (await readFile(path, "utf8")) === expected;
	});
}

async function waitForRestoredPathRemoval(
	persistence: ReturnType<typeof createPersistence>,
	path: string,
): Promise<void> {
	await waitFor(async () => {
		await persistence.restore();
		try {
			await readFile(path);
			return false;
		} catch {
			return true;
		}
	});
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			if (await check()) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		await setTimeout(100);
	}
	throw new Error(`timed out waiting for condition: ${String(lastError)}`);
}
