/**
 * Safety Rules — Destructive Operations
 *
 * Ported from guardrails.ts + guardian.ts. Covers catastrophic rm,
 * recursive delete of source dirs, pipe-to-shell (incl. eval/process-sub),
 * process kill, find-delete, dd, mkfs.
 */

import { block, confirm, rule, type RuleSet } from "../types.js";

export const destructiveRules: RuleSet = [
  rule({
    id: "no-catastrophic-rm",
    description: "Block rm -rf on root or home directories",
    severity: "critical",
    threat: "data-destruction",
    targets: ["bash"],
    check: (ctx) => {
      const cmd = ctx.command!;
      if (
        !/\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f/.test(cmd) &&
        !/\brm\s+.*-[a-zA-Z]*f[a-zA-Z]*r/.test(cmd)
      ) {
        return null;
      }
      const hitsRoot =
        /\brm\s+.*\s+\/\s*$/.test(cmd) ||
        /\brm\s+.*\s+\/[^a-zA-Z]/.test(cmd) ||
        /\brm\s+.*\s+~\/?\s*$/.test(cmd) ||
        /\brm\s+.*\$HOME/.test(cmd);
      return hitsRoot
        ? block(
            "no-catastrophic-rm",
            "critical",
            "data-destruction",
            "Catastrophic delete detected. This would destroy critical system or user files.",
          )
        : null;
    },
  }),
  rule({
    id: "warn-bulk-delete-src",
    description: "Recursive delete of source directories",
    severity: "high",
    threat: "data-destruction",
    targets: ["bash"],
    check: (ctx) => {
      const cmd = ctx.command!;
      if (!/\brm\s+.*-[a-zA-Z]*r/.test(cmd)) return null;
      const dirMatch = cmd.match(
        /\b(src|lib|app|pages|components|modules|packages|dist|build)\b/,
      );
      return dirMatch
        ? confirm(
            "warn-bulk-delete-src",
            "high",
            "data-destruction",
            `Recursive delete targeting '${dirMatch[1]}/' directory. Consider: git stash or backup before proceeding.`,
          )
        : null;
    },
  }),
  rule({
    id: "no-pipe-to-shell",
    description: "Block remote code download and execution patterns",
    severity: "critical",
    threat: "remote-code-execution",
    targets: ["bash"],
    check: (ctx) => {
      const cmd = ctx.command!;
      const pipeToShell =
        /\b(curl|wget)\b.*\|\s*(bash|sh|zsh|python[23]?|node|ruby|perl|php)\b/.test(
          cmd,
        );
      const evalRemote =
        /\beval\b.*\$\((curl|wget)/.test(cmd) ||
        /\b(bash|sh|zsh)\b.*<\((curl|wget)/.test(cmd);
      return pipeToShell || evalRemote
        ? block(
            "no-pipe-to-shell",
            "critical",
            "remote-code-execution",
            "Remote code execution detected. This downloads and executes untrusted code.",
          )
        : null;
    },
  }),

  rule({
    id: "warn-process-kill",
    description: "Force process termination",
    severity: "high",
    threat: "data-destruction",
    targets: ["bash"],
    check: (ctx) => {
      const cmd = ctx.command!;
      return /\bkill\s+-9\b/.test(cmd) ||
        /\bkillall\b/.test(cmd) ||
        /\bpkill\b/.test(cmd)
        ? confirm(
            "warn-process-kill",
            "high",
            "data-destruction",
            "Force process kill detected. kill -9 does not allow graceful shutdown.",
          )
        : null;
    },
  }),
  rule({
    id: "warn-find-delete",
    description: "find with -delete flag",
    severity: "medium",
    threat: "data-destruction",
    targets: ["bash"],
    check: (ctx) =>
      /\bfind\b.*\s-delete\b/.test(ctx.command!)
        ? confirm(
            "warn-find-delete",
            "medium",
            "data-destruction",
            "`find -delete` permanently removes matched files. Verify the pattern is correct.",
          )
        : null,
  }),
  rule({
    id: "warn-dd",
    description: "Raw disk writes via dd (of= target)",
    severity: "high",
    threat: "data-destruction",
    targets: ["bash"],
    check: (ctx) =>
      /\bdd\s+[^;&|]*\bof=/.test(ctx.command!)
        ? confirm(
            "warn-dd",
            "high",
            "data-destruction",
            "`dd` can overwrite raw disk devices. Verify of= target is correct.",
          )
        : null,
  }),
  rule({
    id: "warn-mkfs",
    description: "Filesystem format operations",
    severity: "high",
    threat: "data-destruction",
    targets: ["bash"],
    check: (ctx) =>
      /\bmkfs\b/.test(ctx.command!)
        ? confirm(
            "warn-mkfs",
            "high",
            "data-destruction",
            "`mkfs` formats a filesystem, destroying all data on the target device.",
          )
        : null,
  }),
];
