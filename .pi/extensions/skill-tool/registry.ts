import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter as parsePiFrontmatter } from "@earendil-works/pi-coding-agent";

/** One discovered skill, as a `skill` tool option plus loader. */
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
	/** Non-fatal problems: a file that could not be read, a skill skipped
	 * because pi would not load it either, or a name pi warns about but loads.
	 * Surfaced so a malformed skill is not simply invisible. */
	diagnostics: string[];
}

/** Frontmatter fields that decide whether and how a skill loads. */
export interface SkillFrontmatter {
	name?: string | undefined;
	description?: string | undefined;
	userInvoked: boolean;
}

/** Recursion bound. pi has none (it relies on SKILL.md stopping the walk and on
 * ignore files); a cap keeps a pathological tree from walking forever. */
const MAX_DEPTH = 8;

/** Parse the invocation-relevant frontmatter fields with pi's own YAML
 * frontmatter parser, and apply the rules pi's skill loader applies
 * (`core/skills.js`): `name` and `description` count only as strings, and
 * `disable-model-invocation` only as the YAML boolean `true`. Throws on
 * malformed YAML, as pi's parser does; the caller turns that into a skip.
 * A hand-rolled reader here disagreed with pi on comments, quoted booleans,
 * and descriptions pi's YAML rejects. */
export function parseFrontmatter(content: string): SkillFrontmatter {
	const { frontmatter } = parsePiFrontmatter<Record<string, unknown>>(content);
	const parsed: SkillFrontmatter = { userInvoked: frontmatter["disable-model-invocation"] === true };
	if (typeof frontmatter.name === "string") parsed.name = frontmatter.name;
	if (typeof frontmatter.description === "string") parsed.description = frontmatter.description;
	return parsed;
}

/** Walk every root (project-local first, vendored after) for skill files.
 * Mirrors pi's loader so the tool's skill set matches what pi itself lists:
 * - a directory holding `SKILL.md` is a skill root and is NOT descended into;
 * - hidden entries and `node_modules` are skipped;
 * - a loose `.md` file counts only directly inside a root that was passed in.
 * The first occurrence of a name wins, so project-local skills shadow a
 * vendored one by name. */
export function buildRegistry(roots: string[], read: (path: string) => string = (path) => readFileSync(path, "utf8")): Registry {
	const skills: SkillEntry[] = [];
	const duplicates: string[] = [];
	const diagnostics: string[] = [];
	const seen = new Map<string, string>();

	const load = (file: string, declared: boolean): void => {
		let content: string;
		try {
			content = read(file);
		} catch (error) {
			diagnostics.push(`${file}: could not be read (${error instanceof Error ? error.message : String(error)})`);
			return;
		}
		let frontmatter: SkillFrontmatter;
		try {
			frontmatter = parseFrontmatter(content);
		} catch (error) {
			// pi skips a file whose frontmatter does not parse; only a declared SKILL.md warns
			if (declared)
				diagnostics.push(`${file}: frontmatter does not parse (${error instanceof Error ? error.message : String(error)}); skipped`);
			return;
		}
		const directory = dirname(file);
		// pi falls back to the containing directory's name (an empty name too) and requires a description
		const name = frontmatter.name || basename(directory);
		const description = frontmatter.description?.trim() ?? "";
		if (!description) {
			// pi loads nothing without a description; only a declared SKILL.md warns
			if (declared) diagnostics.push(`${file}: no description — pi does not load a skill without one`);
			return;
		}
		// pi warns about a bad name but still loads the skill
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
			diagnostics.push(`${file}: name ${JSON.stringify(name)} violates pi's skill-name rules; loaded anyway, as pi does`);
		}
		const existing = seen.get(name);
		if (existing !== undefined) {
			duplicates.push(name);
			diagnostics.push(`${name}: duplicate — ${existing} wins, ${file} skipped`);
			return;
		}
		seen.set(name, file);
		skills.push({ name, description, directory, skillFile: file, userInvoked: frontmatter.userInvoked });
	};

	const walk = (dir: string, includeRootFiles: boolean, depth: number): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const declared = entries.find((entry) => entry.name === "SKILL.md");
		if (declared !== undefined) {
			const file = join(dir, "SKILL.md");
			if (entryKind(file, declared) === "file") {
				load(file, true);
				return; // pi stops here: SKILL.md makes this directory a skill root
			}
		}
		if (depth >= MAX_DEPTH) return;
		for (const entry of entries) {
			// pi skips both outright
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const path = join(dir, entry.name);
			const kind = entryKind(path, entry);
			if (kind === "directory") {
				walk(path, false, depth + 1);
				continue;
			}
			if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) continue;
			load(path, false);
		}
	};

	for (const root of roots) walk(resolve(root), true, 0);
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return {
		skills,
		modelInvoked: skills.filter((skill) => !skill.userInvoked),
		userInvoked: skills.filter((skill) => skill.userInvoked),
		duplicates,
		diagnostics,
	};
}

/** "file" / "directory" / "other", following a symlink the way pi does. */
function entryKind(path: string, entry: Dirent): "file" | "directory" | "other" {
	if (!entry.isSymbolicLink()) {
		if (entry.isFile()) return "file";
		if (entry.isDirectory()) return "directory";
		return "other";
	}
	try {
		const stat = statSync(path);
		if (stat.isFile()) return "file";
		if (stat.isDirectory()) return "directory";
		return "other";
	} catch {
		return "other"; // broken symlink
	}
}
