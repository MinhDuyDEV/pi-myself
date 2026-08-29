/**
 * DCP Extension — Recall-only entry point.
 *
 * Pi owns context compaction. This extension exposes historical session search
 * through `recall` without registering lifecycle or compaction handlers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerRecallTool } from "./recall.js";

export default function dcpExtension(pi: ExtensionAPI): void {
  registerRecallTool(pi);
}
