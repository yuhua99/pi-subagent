import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const managedSessionDirs = new Set<string>();
const managedSessionPaths = new Set<string>();

export function createManagedSessionFile(
	agentName: string,
	sessionJsonl?: string,
): { dir: string; filePath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `session-${safeName}.jsonl`);
	managedSessionDirs.add(dir);
	managedSessionPaths.add(filePath);
	if (sessionJsonl !== undefined) {
		fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
	}
	return { dir, filePath };
}

export function createManagedResumeSessionFile(agentName: string, sessionPath: string): string {
	const sessionJsonl = fs.readFileSync(sessionPath, "utf-8");
	return createManagedSessionFile(agentName, sessionJsonl).filePath;
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
