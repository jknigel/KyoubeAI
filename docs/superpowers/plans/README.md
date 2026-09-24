# KyoubeAI implementation plans

Execute in order; each phase ends with working, tested software and its own exit checklist. All plans implement `../specs/2026-09-05-kyoubeai-architecture-design.md`.

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 0 | [Foundation](2026-09-05-phase-0-foundation.md) | Repo skeleton, `kyoube` bootstrap CLI, terminal-plugin skeleton, Docker overlay image (pi + Hermes), compose with two databases, smoke test, CI | — |
| 1 | [Terminal plugin](2026-09-05-phase-1-terminal-plugin.md) | Admin web terminal: PTY sessions, role gate, audit, resumable xterm page | 0 |
| 2 | [Data layer](2026-09-05-phase-2-data-layer.md) | Per-company organisation database: schema/records services, grants, agent tools, REST routes, managed skill, Data UI | 0 (and the bootstrap's plugin discovery) |
| 3 | [Apps](2026-09-05-phase-3-apps.md) | Sandboxed single-file apps over the data layer: storage, `window.kyoube` SDK, runner, tools, skill | 2 |
| 4 | [Hardening & release](2026-09-05-phase-4-hardening-release.md) | GHCR images, pin lock-step tooling, weekly upstream canary, backups, security/governance docs, 1.0.0 | 0–3 |
| 5 | [White-label](2026-09-13-white-label.md) | Build-time brand transform, home/database rename, KYOUBE_* keys, 0.1.x migration, 0.2.0 | 0–4 |
| 6 | [Core 2026.916.1 and harness bump](2026-09-24-core-916-and-harness-bump.md) | Core and SDK 2026.916.1, Claude Code 2.1.281, pi 0.87.1, Hermes 0.21.4; transforms and Studio re-targeted at the streamlined shell; 1.3.0 | 0–5 |

Plan 5 implements `../specs/2026-09-13-white-label-design.md`.

Conventions shared by every plan: pinned upstream core (image + `@paperclipai/plugin-sdk`: `2026.831.1` for plans 0–5, `2026.916.1` from plan 6), ESM + strict TypeScript, Vitest, Conventional Commits, no patches to Paperclip (the build-time branding transform excepted).

Deliberately deferred from the spec (candidates for a post-1.0 plan): the optional "Apps Builder" managed agent template (§8.3), multi-file app bundles and dashboard-widget surfaces (§8.4), realtime table change streams (§8.4), a WebSocket terminal transport (§7), and the upstream proposal for an operator-configurable bundled-plugin allowlist (§6.4 / Phase 4 Task 7 opens the issue).
