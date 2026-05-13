import { constants, createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
	chown,
	copyFile,
	lchown,
	link,
	lstat,
	lutimes,
	mkdir,
	readdir,
	readlink,
	rename,
	rm,
	symlink,
	utimes,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export async function copyPersistedRoot(
	persistedRootPath: string,
	rootPath: string,
	shouldCopy: (destination: string) => boolean = () => true,
): Promise<void> {
	const restoredHardlinks = new Map<string, string>();
	await walk(persistedRootPath, async (source) => {
		const relativePath = relative(persistedRootPath, source);
		if (!relativePath) {
			return true;
		}
		const destination = join(rootPath, relativePath);
		if (!shouldCopy(destination)) {
			return false;
		}
		const stats = await lstat(source);
		await mkdir(dirname(destination), { recursive: true });
		if (stats.isSymbolicLink()) {
			await rm(destination, { recursive: true, force: true });
			await symlink(await readlink(source), destination);
			await copyMetadata(source, destination);
			return false;
		}
		if (stats.isDirectory()) {
			await removeIfNotDirectory(destination);
			await mkdir(destination, { recursive: true, mode: stats.mode });
			await copyMetadata(source, destination);
			return true;
		}
		if (stats.isFile()) {
			await rm(destination, { recursive: true, force: true });
			const hardlinkKey = `${stats.dev}:${stats.ino}`;
			const existingHardlink = restoredHardlinks.get(hardlinkKey);
			if (stats.nlink > 1 && existingHardlink) {
				await link(existingHardlink, destination);
			} else {
				await copyFileConsistently(source, destination);
				if (stats.nlink > 1) {
					restoredHardlinks.set(hardlinkKey, destination);
				}
			}
			await copyMetadata(source, destination);
		}
		return false;
	});
}

export async function walk(
	path: string,
	visitor: (path: string) => Promise<boolean | void> | boolean | void,
): Promise<void> {
	let stats;
	try {
		stats = await lstat(path);
	} catch {
		return;
	}
	const shouldDescend = await visitor(path);
	if (!stats.isDirectory() || shouldDescend === false) {
		return;
	}
	for (const entry of await readdir(path)) {
		await walk(join(path, entry), visitor);
	}
}

export async function copyFileConsistently(
	source: string,
	destination: string,
): Promise<void> {
	const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const before = await lstat(source);
			await copyFile(source, temp, constants.COPYFILE_FICLONE_FORCE).catch(
				async () => {
					await streamCopy(source, temp);
				},
			);
			const after = await lstat(source);
			if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
				await rename(temp, destination);
				return;
			}
		}
		await rename(temp, destination);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

async function streamCopy(source: string, destination: string): Promise<void> {
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const input = createReadStream(source);
		const output = createWriteStream(destination);
		input.on("error", rejectPromise);
		output.on("error", rejectPromise);
		output.on("finish", resolvePromise);
		input.pipe(output);
	});
}

export async function copyMetadata(
	source: string,
	destination: string,
): Promise<void> {
	const stats = await lstat(source);
	if (stats.isSymbolicLink()) {
		await lchown(destination, stats.uid, stats.gid).catch(ignoreUnsupported);
		await lutimes(destination, stats.atime, stats.mtime).catch(
			ignoreUnsupported,
		);
		return;
	}
	await chown(destination, stats.uid, stats.gid).catch(ignoreUnsupported);
	await chmod(destination, stats.mode).catch(ignoreUnsupported);
	await utimes(destination, stats.atime, stats.mtime).catch(ignoreUnsupported);
}

export async function isStoredFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

async function removeIfNotDirectory(path: string): Promise<void> {
	try {
		if ((await lstat(path)).isDirectory()) {
			return;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	await rm(path, { recursive: true, force: true });
}

function ignoreUnsupported(error: unknown): void {
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== "EPERM" && code !== "ENOSYS" && code !== "ENOENT") {
		throw error;
	}
}
