#!/usr/bin/env node
/**
 * install-git-hooks.mjs
 *
 * Installs .githooks/ hooks into the local .git/hooks/ directory
 * using `git config core.hooksPath`.
 *
 * Usage:
 *   node scripts/install-git-hooks.mjs        # install
 *   node scripts/install-git-hooks.mjs --list  # show current hooks path
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".githooks");

const args = process.argv.slice(2);

if (args.includes("--list") || args.includes("-l")) {
  try {
    const current = execSync(
      "git config --get core.hooksPath || echo '(default .git/hooks/)'",
      { encoding: "utf8", cwd: REPO_ROOT },
    ).trim();
    console.log(`Current hooks path: ${current}`);
  } catch {
    console.log("Not a git repository or no hooks configured.");
  }
  process.exit(0);
}

if (!existsSync(path.join(HOOKS_DIR, "pre-push"))) {
  console.log("No hooks found in .githooks/. Nothing to install.");
  process.exit(0);
}

try {
  execSync(
    `git config core.hooksPath "${HOOKS_DIR}"`,
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  console.log(`✅ Git hooks installed: ${HOOKS_DIR}`);
  console.log("   Hooks active:", execSync(
    `ls ${HOOKS_DIR}`,
    { encoding: "utf8", cwd: REPO_ROOT },
  ).trim().split("\n").join(", "));
} catch (err) {
  console.error("Failed to install hooks:", err.message);
  process.exit(1);
}
