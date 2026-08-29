import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";

/** One discovered skill, as a `skill` tool enum option plus loader. */
export interface SkillEntry {
	name: string;
	description: string;
	/** Absolute path of the directory holding SKILL.md. */
	directory: string;
	/** Absolute path to SKILL.md. */
	skillFile: string;
	/** True when only the human may invoke it (disable-model-invocation: true). */
	userInvoked: boolean;
}

export interface Registry {
	skills: SkillEntry[];
	modelInvoked: SkillEntry[];
	userInvoked: SkillEntry[];
	/** Names found more than once; the first source (in root order) wins. */
	duplicates: string[];
}

/** Parse the invocation-relevant fields out of SKILL.md frontmatter. */
export function parseFrontmatter(content: string): {
	name?: string;
	description?: string;
	userInvoked: boolean;
} {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { userInvoked: false };
	const field = (name: string): string | undefined => {
		const m = match[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
		if (!m) return undefined;
		let value = m[1].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1).replace(/\\(["'])/g, "$1");
		}
		return value;
	};
	return {
		name: field("name"),
		description: field("description"),
		userInvoked: field("disable-model-invocation") === "true",
	};
}

/** Walk every root (project-local first, vendored after) for SKILL.md files.
 * The first occurrence of a name wins; later duplicates are recorded by name
 * and skipped, so project-local skills can shadow a vendored one by name. */
export function buildRegistry(
	roots: string[],
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Registry {
	const skills: SkillEntry[] = [];
	const duplicates: string[] = [];
	const seen = new Map<string, string>();

	const walk = (dir: string, depth: number): void => {
		if (depth > 4) return;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of entries) {
			const path = join(dir, name);
			let stat;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				walk(path, depth + 1);
				continue;
			}
			if (!stat.isFile() || name !== "SKILL.md") continue;
			let content: string;
			try {
				content = read(path);
			} catch {
				continue;
			}
			const fm = parseFrontmatter(content);
			if (!fm.name || !fm.description || !/^[a-z0-9][a-z0-9-]*$/.test(fm.name)) continue;
			const entry: SkillEntry = {
				name: fm.name,
				description: fm.description,
				directory: dir,
				skillFile: path,
				userInvoked: fm.userInvoked,
			};
			if (seen.has(entry.name)) {
				duplicates.push(entry.name);
				continue;
			}
			seen.set(entry.name, path);
			skills.push(entry);
		}
	};

	for (const root of roots) walk(resolve(root), 0);
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return {
		skills,
		modelInvoked: skills.filter((s) => !s.userInvoked),
		userInvoked: skills.filter((s) => s.userInvoked),
		duplicates,
	};
}