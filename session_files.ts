import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const managedSessionDirs = new Set<string>();
const managedSessionPaths = new Set<string>();

export function allocateManagedSessionDir(agentName: string): string {
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagent-${safeName}-`));
	managedSessionDirs.add(dir);
	return dir;
}

export function registerManagedSessionPath(sessionPath: string): string {
	managedSessionPaths.add(sessionPath);
	return sessionPath;
}

export function hasManagedSessionPath(sessionPath: string): boolean {
	return fs.existsSync(sessionPath);
}

function cleanupManagedSessionDir(dir: string | null): void {
	if (!dir) return;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

export function cleanupManagedSessions(retainedSessionPaths: Iterable<string> = []): void {
	const retained = new Set(retainedSessionPaths);
	for (const dir of managedSessionDirs) {
		const keep = [...managedSessionPaths].some(
			(sessionPath) => path.dirname(sessionPath) === dir && retained.has(sessionPath),
		);
		if (!keep) cleanupManagedSessionDir(dir);
	}
	for (const sessionPath of managedSessionPaths) {
		if (!retained.has(sessionPath)) managedSessionPaths.delete(sessionPath);
	}
	for (const dir of managedSessionDirs) {
		if (![...managedSessionPaths].some((sessionPath) => path.dirname(sessionPath) === dir)) {
			managedSessionDirs.delete(dir);
		}
	}
}
