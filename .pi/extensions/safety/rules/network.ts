/**
 * Safety Rules — Network Access Controls
 *
 * Blocks dangerous network targets such as localhost, private subnets,
 * cloud metadata endpoints, and unsafe URL schemes.
 */

import { isIP } from "node:net";
import { block, rule, type RuleSet } from "../types.js";

const URL_PATTERN = /https?:\/\/[^\s'"`<>]+/gi;
const NUMERIC_PART_PATTERNS: Array<[RegExp, number]> = [
	[/^0x([0-9a-f]+)$/i, 16],
	[/^0([0-7]+)$/, 8],
	[/^(\d+)$/, 10],
];
const PRIVATE_IPV4_PREFIXES = new Set([0, 10, 127]);
const PRIVATE_IPV4_SECOND_OCTET_RANGES: Array<[number, number, number]> = [
	[100, 64, 127],
	[169, 254, 254],
	[172, 16, 31],
	[192, 168, 168],
];
const PRIVATE_IPV6_PREFIXES = ["fc", "fd", "fe80:"];
const BLOCKED_SCHEMES = new Set(["file:", "data:", "javascript:"]);
const BLOCKED_HOSTS = new Set([
	"0.0.0.0",
	"127.0.0.1",
	"169.254.169.254",
	"169.254.170.2",
	"100.100.100.200",
	"::1",
	"localhost",
	"metadata.google.internal",
	"metadata.google.internal.",
]);

function parseBlockedHostPatterns(): string[] {
	const raw = process.env.PI_SAFETY_URL_BLOCKLIST ?? "";
	return raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

function parseNumericPart(part: string): number | null {
	for (const [pattern, radix] of NUMERIC_PART_PATTERNS) {
		const match = part.match(pattern);
		if (match) return Number.parseInt(match[1], radix);
	}
	return null;
}

function numberToIpv4(value: number): number[] | null {
	if (value < 0 || value > 0xffffffff) return null;
	return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function parseDottedIpv4(hostname: string): number[] | null {
	const parts = hostname.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map(parseNumericPart);
	return octets.every((part) => part !== null && part <= 255) ? octets as number[] : null;
}

function parseIpv4(hostname: string): number[] | null {
	const singleNumber = !hostname.includes(".") ? parseNumericPart(hostname) : null;
	return singleNumber === null ? parseDottedIpv4(hostname) : numberToIpv4(singleNumber);
}

function isPrivateIpv4Parts(parts: number[]): boolean {
	const [a, b] = parts;
	return PRIVATE_IPV4_PREFIXES.has(a) ||
		PRIVATE_IPV4_SECOND_OCTET_RANGES.some(([prefix, min, max]) => a === prefix && b >= min && b <= max);
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = parseIpv4(hostname);
	return parts ? isPrivateIpv4Parts(parts) : false;
}

function decodeHexMappedIpv4(hostname: string): string | null {
	const match = hostname.match(/(?:::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (!match) return null;
	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);
	return `${(high >>> 8) & 255}.${high & 255}.${(low >>> 8) & 255}.${low & 255}`;
}

function mappedIpv4Host(hostname: string): string | null {
	const dotted = hostname.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
	return dotted?.[1] ?? decodeHexMappedIpv4(hostname);
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	const mapped = mappedIpv4Host(normalized);
	return mapped ? isPrivateIpv4(mapped) : normalized === "::1" ||
		PRIVATE_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isPrivateHostname(hostname: string): boolean {
	const stripped = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[/, "").replace(/\]$/, "");
	if (!stripped) return false;
	if (BLOCKED_HOSTS.has(stripped)) return true;
	if (stripped.endsWith(".internal") || stripped.endsWith(".local")) return true;
	return isIP(stripped) === 6 ? isPrivateIpv6(stripped) : isPrivateIpv4(stripped);
}

function classifyDangerousUrl(urlValue: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(urlValue);
	} catch {
		return null;
	}

	if (BLOCKED_SCHEMES.has(parsed.protocol)) {
		return `unsafe scheme ${parsed.protocol}`;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `unsupported scheme ${parsed.protocol}`;
	}

	if (isPrivateHostname(parsed.hostname)) {
		return `private or local host ${parsed.hostname}`;
	}

	const blockedPatterns = parseBlockedHostPatterns();
	const hostname = parsed.hostname.toLowerCase();
	for (const pattern of blockedPatterns) {
		if (hostname === pattern || hostname.endsWith(`.${pattern}`)) {
			return `blocked host ${parsed.hostname}`;
		}
	}

	return null;
}

function extractUrls(ctx: { command?: string; url?: string; urls?: readonly string[] }): string[] {
	const values = new Set<string>();
	if (ctx.url) values.add(ctx.url);
	for (const value of ctx.urls ?? []) {
		if (value) values.add(value);
	}
	for (const match of ctx.command?.match(URL_PATTERN) ?? []) {
		values.add(match);
	}
	return [...values];
}

export const networkRules: RuleSet = [
	rule({
		id: "block-dangerous-network-target",
		description: "Block internal metadata, localhost, and dangerous URL targets",
		severity: "critical",
		threat: "network-exfiltration",
		targets: ["*"],
		check: (ctx) => {
			for (const url of extractUrls(ctx)) {
				const reason = classifyDangerousUrl(url);
				if (!reason) continue;
				return block(
					"block-dangerous-network-target",
					"critical",
					"network-exfiltration",
					`Blocked network target (${reason}).\n\nURL: ${url}`,
				);
			}
			return null;
		},
	}),
];
