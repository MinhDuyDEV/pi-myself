import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
	/** Non-fatal problems: a file that could not be read, or a skill skipped
	 * because pi would not load it either. Surfaced so a malformed skill is not
	 * simply invisible. */
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

/** Parse the invocation-relevant frontmatter fields.
 *
 * Mirrors pi's `parseFrontmatter` in everything that decides whether a skill
 * loads at all:
 * - CRLF/CR is normalized and a leading BOM stripped. A CRLF checkout used to
 *   drop EVERY skill here, because the opening `---\n` never matched.
 * - The block ends at the first `\n---`, and the content must start with `---`.
 * - `>-` / `|` block scalars are folded/literal, not returned as the marker.
 * - `disable-model-invocation` counts only as the boolean true, which is what
 *   pi's YAML parser resolves (`True` included; `yes` is a string in YAML 1.2).
 *
 * Divergence, deliberate: this is a flat field reader, not a YAML parser, so
 * nested mappings, anchors, and flow collections are not interpreted. */
export function parseFrontmatter(content: string): SkillFrontmatter {
	const normalized = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
	if (!normalized.startsWith("---\n")) return { userInvoked: false };
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) return { userInvoked: false };
	const block = normalized.slice(4, end);
	return {
		name: field(block, "name"),
		description: field(block, "description"),
		userInvoked: (field(block, "disable-model-invocation") ?? "").toLowerCase() === "true",
	};
}

function field(block: string, name: string): string | undefined {
	const lines = block.split("\n");
	const prefix = `${name}:`;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		// a top-level key: column 0, exact name, colon
		if (!line.startsWith(prefix)) continue;
		const inline = line.slice(prefix.length).trim();
		if (/^[|>][+-]?$/.test(inline)) return readBlockScalar(lines, index + 1, inline.startsWith("|"));
		return unquote(inline);
	}
	return undefined;
}

/** Fold (`>`) or keep (`|`) the more-indented lines under a block scalar. */
function readBlockScalar(lines: string[], start: number, literal: boolean): string {
	const collected: string[] = [];
	for (let index = start; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.trim() === "") {
			collected.push("");
			continue;
		}
		if (!/^\s/.test(line)) break; // a new top-level key ends the scalar
		collected.push(line.replace(/^\s+/, ""));
	}
	while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
	if (literal) return collected.join("\n");
	return collected.join(" ").replace(/\s+/g, " ").trim();
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1).replace(/\\(["'\\])/g, "$1");
	}
	return value;
}

/** Walk every root (project-local first, vendored after) for skill files.
 * Mirrors pi's loader so the tool's enum matches what pi itself lists:
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
		const frontmatter = parseFrontmatter(content);
		const directory = dirname(file);
		// pi falls back to the containing directory's name and requires a description
		const name = frontmatter.name ?? basename(directory);
		const description = frontmatter.description?.trim() ?? "";
		if (!description) {
			// pi loads nothing without a description; only a declared SKILL.md warns
			if (declared) diagnostics.push(`${file}: no description — pi does not load a skill without one`);
			return;
		}
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
			diagnostics.push(`${file}: name ${JSON.stringify(name)} violates pi's skill-name rules; skipped`);
			return;
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
