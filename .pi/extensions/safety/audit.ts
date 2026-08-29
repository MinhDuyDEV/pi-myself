/**
 * Safety Module — Audit Log
 *
 * Ring-buffer audit trail. Unified log replacing 3 separate logs.
 */

import type { Severity, ThreatCategory, VerdictKind } from "./types.js";

export interface AuditEntry {
	readonly timestamp: number;
	readonly ruleId: string;
	readonly severity: Severity;
	readonly threat: ThreatCategory;
	readonly kind: VerdictKind;
	readonly tool: string;
	readonly detail: string; // command or path, truncated to 200 chars
	readonly sessionId: string;
}

export class AuditLog {
	private entries: AuditEntry[] = [];
	private readonly maxEntries: number;

	constructor(maxEntries = 500) {
		this.maxEntries = maxEntries;
	}

	append(entry: AuditEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.splice(0, this.entries.length - this.maxEntries);
		}
	}

	query(filter?: {
		severity?: Severity;
		kind?: VerdictKind;
		tool?: string;
	}): AuditEntry[] {
		if (!filter) return [...this.entries];
		return this.entries.filter((e) => {
			if (filter.severity && e.severity !== filter.severity) return false;
			if (filter.kind && e.kind !== filter.kind) return false;
			if (filter.tool && e.tool !== filter.tool) return false;
			return true;
		});
	}

	stats(): { total: number; blocked: number; confirmed: number } {
		let blocked = 0;
		let confirmed = 0;
		for (const e of this.entries) {
			if (e.kind === "block") blocked++;
			else if (e.kind === "confirm") confirmed++;
		}
		return { total: this.entries.length, blocked, confirmed };
	}
}
