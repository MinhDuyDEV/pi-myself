# .pi/cli

Local Node.js helper scripts. Run with `node .pi/cli/<script>.mjs ...` from the project root.

## Conventions

These scripts are **evidence producers**, not artifact authors. The output they produce is captured by the slash command that invokes them and embedded as a `####` subsection in the work session block (typically in `PROGRESS.md`). The scripts themselves default to writing only to `.pi/browser-artifacts/` (screenshots, HTML snapshots, etc.) and printing a markdown report to stdout.

If you need a one-off report file, use `--artifact <path>` (or `--report <path>`) to write it to a specific location.

## Scripts

| Script | Use for | Output |
| --- | --- | --- |
| `browser-devtools.mjs` | Connect to a Chromium DevTools endpoint, run JS evaluations, capture console + network | `.pi/browser-artifacts/screenshots/`, optional report to `--artifact <path>` |
| `playwright-flow.mjs` | Drive a browser through a sequence of steps (open URL, snapshot, screenshot, eval) | Same as above |
| `browser-screenshot.mjs` | Take a screenshot at a URL with optional viewport / wait | `.pi/browser-artifacts/screenshots/`, optional report to `--report <path>` |

## How a slash command uses these

A typical `/ship` or `/verify` flow:

1. The slash command reads the plan and finds the step that needs browser evidence
2. It invokes one of these scripts (e.g. `node .pi/cli/browser-screenshot.mjs --url ...`)
3. The script writes evidence to `.pi/browser-artifacts/` and prints a markdown report to stdout
4. The slash command captures the markdown report and embeds it under `#### Run Report` or `#### Verification` in the work session block in `PROGRESS.md`

## Why no `--work-id` flag

Earlier versions of these scripts took a `--work-id` flag and wrote to `.pi/artifacts/<id>/...`. That pattern is gone: the artifact directory is now flat (`.pi/artifacts/{TODO,PLAN,PROGRESS,DECISIONS}.md`), and work session content lives as `### ` blocks within those files. Pass an explicit `--artifact` or `--report` path if you need a standalone file.
