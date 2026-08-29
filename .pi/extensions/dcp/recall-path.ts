import { join, isAbsolute, relative } from "node:path";
import { lstatSync } from "node:fs";

/**
 * Path containment checks for DCP recall.
 *
 * Recall searches provenance dirs outside the project (pi home, task
 * sessions), so every candidate path is validated against symlink
 * escapes and containment violations before it is read. See
 * recall.test.ts for the security matrix.
 */

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

export function hasSymlinkComponent(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  if (!relativePath || relativePath.startsWith("..")) return relativePath.startsWith("..");
  let current = root;
  for (const part of relativePath.split(/[\\/]/)) {
    current = join(current, part);
    if (safeLstat(current)?.isSymbolicLink()) return true;
  }
  return false;
}

interface PathContainmentApi {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

const CURRENT_PATH_API: PathContainmentApi = { relative, isAbsolute };

export function isPathWithin(
  root: string,
  candidate: string,
  pathApi: PathContainmentApi = CURRENT_PATH_API,
): boolean {
  const relativePath = pathApi.relative(root, candidate);
  const firstSegment = relativePath.split(/[\\/]/, 1)[0];
  return relativePath === "" || (firstSegment !== ".." && !pathApi.isAbsolute(relativePath));
}
