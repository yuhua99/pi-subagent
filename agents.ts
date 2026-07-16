/**
 * Agent discovery and configuration.
 *
 * Agents are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools, and a system prompt body.
 *
 * Lookup locations:
 *   - User agents:    ~/.pi/agent/agents/*.md by default, or
 *                     $PI_CODING_AGENT_DIR/agents/*.md when the env var is set
 *   - Project agents: .pi/agents/*.md  (walks up from cwd)
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	role?: "orchestrator";
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	orchestrator: AgentConfig | null;
	projectAgentsDir: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function getUserAgentsDir(): string {
	const configDir = process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(configDir, "agents");
}

/** Walk up from `cwd` looking for a `.pi/agents` directory. */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Parse a single agent markdown file into an AgentConfig. Returns null on skip. */
function parseAgentFile(filePath: string, source: "user" | "project"): AgentConfig | null {
	let content: string;
	try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-subagent] Skipping invalid agent file "${filePath}": ${message}`);
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const body = parsed.body ?? "";

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

	let role: "orchestrator" | undefined;
	if (frontmatter.role !== undefined) {
		if (typeof frontmatter.role === "string" && frontmatter.role.trim() === "orchestrator") {
			role = "orchestrator";
		} else {
			console.warn(`[pi-subagent] Ignoring invalid role field in "${filePath}". Expected "orchestrator".`);
		}
	}

	const isOrchestrator = role === "orchestrator";
	if (isOrchestrator && (frontmatter.model !== undefined || frontmatter.tools !== undefined || frontmatter.thinking !== undefined)) {
		console.warn(`[pi-subagent] Ignoring model/tools/thinking on orchestrator file "${filePath}".`);
	}

	let tools: string[] | undefined;
	if (!isOrchestrator && typeof frontmatter.tools === "string") {
		const parsedTools = frontmatter.tools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (!isOrchestrator && Array.isArray(frontmatter.tools)) {
		const parsedTools = frontmatter.tools
			.filter((t): t is string => typeof t === "string")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (!isOrchestrator && frontmatter.tools !== undefined) {
		console.warn(
			`[pi-subagent] Ignoring invalid tools field in "${filePath}". Expected a comma-separated string or string array.`,
		);
	}

	return {
		name,
		description,
		role,
		tools,
		model: !isOrchestrator && typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: !isOrchestrator && typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Load all agent definitions from a directory. */
function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const agent = parseAgentFile(path.join(dir, entry.name), source);
		if (agent) agents.push(agent);
	}
	return agents;
}

function mergeAgents(...groups: AgentConfig[][]): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();
	for (const group of groups) {
		for (const agent of group) agentMap.set(agent.name, agent);
	}
	return Array.from(agentMap.values());
}

function selectOrchestrator(candidates: AgentConfig[], dir: string): AgentConfig | null {
	if (candidates.length > 1) {
		console.warn(`[pi-subagent] Multiple orchestrator files found in ${dir}; using "${candidates[0].filePath}".`);
	}
	return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all available agents according to the requested scope.
 *
 * Precedence is: user < project.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userAgentsDir = getUserAgentsDir();
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userConfigs = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
	const projectConfigs = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const userOrchestrator = selectOrchestrator(
		userConfigs.filter((agent) => agent.role === "orchestrator"),
		userAgentsDir,
	);
	const projectOrchestrator = projectAgentsDir
		? selectOrchestrator(
			projectConfigs.filter((agent) => agent.role === "orchestrator"),
			projectAgentsDir,
		)
		: null;
	const userAgents = userConfigs.filter((agent) => agent.role === undefined);
	const projectAgents = projectConfigs.filter((agent) => agent.role === undefined);

	if (scope === "user") {
		return { agents: userAgents, orchestrator: userOrchestrator, projectAgentsDir };
	}
	if (scope === "project") {
		return { agents: projectAgents, orchestrator: projectOrchestrator, projectAgentsDir };
	}
	return {
		agents: mergeAgents(userAgents, projectAgents),
		orchestrator: projectOrchestrator ?? userOrchestrator,
		projectAgentsDir,
	};
}
