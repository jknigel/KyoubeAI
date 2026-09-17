# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh clone of KyoubeAI builds one Docker image on top of the pinned upstream Paperclip image, starts with `docker compose up`, lets the first user sign up and claim admin, installs Kyoube plugins automatically once a board key exists, and has `claude`, `pi`, and `hermes` runnable inside the container.

**Architecture:** A thin overlay image (`FROM ghcr.io/paperclipai/paperclip:<pin>`) adds two CLIs, a dependency-free Node bootstrap program (`kyoube`) that talks only to Paperclip's HTTP API, and prebuilt plugin bundles under `/opt/kyoube/plugins`. Compose runs the image next to Postgres 17 with two databases (`paperclip`, `kyoube`). The terminal plugin is created here as a build-pipeline skeleton (manifest + health-only worker) and completed in Phase 1.

**Tech Stack:** Node 24, pnpm 9.15.4, TypeScript 7, esbuild, Vitest 5, Docker Compose v2, Postgres 17, `@paperclipai/plugin-sdk@2026.831.1`, bash + curl + jq for smoke tests.

**Spec:** `docs/superpowers/specs/2026-09-05-kyoubeai-architecture-design.md` (sections 5, 6, 9, 11, 13 Phase 0)

> **Post-execution notes (2026-09-06).** Phase 0 is implemented; where the code differs from the snippets below, the code and the rulings in `.superpowers/sdd/2026-09-05-phase-0-foundation/progress.md` (R1–R20) are authoritative. The substantive deviations: secrets are `openssl rand -hex 32` (base64 breaks Postgres URIs, R9); Hermes is installed as root in the FHS layout *without* `--dir` (R9/R10 → R16); build steps never write under `/paperclip` and the image asserts it is empty (R16); a plugin version bump goes through `POST /api/plugins/:pluginId/upgrade`, with a soft-uninstall + reinstall fallback when the new manifest adds capabilities (R15); manifests need at least one capability (R14); `BETTER_AUTH_TRUSTED_ORIGINS` is passed through for non-default ports (R13); the Hermes installer is pinned by commit + sha256 (R18); `minimumHostVersion` is deferred to Phase 1 (R20).

## Global Constraints

- Upstream pin: `PAPERCLIP_VERSION=2026.831.1`; every `@paperclipai/plugin-sdk` dependency is the exact version `2026.831.1`. They are bumped together, never separately.
- Never copy Paperclip source into this repo and never patch the upstream image; all Kyoube code lives in `docker/`, `plugins/`, `packages/`, `scripts/`.
- Node `>=24.11.0`; `packageManager` is `pnpm@9.15.4` (same as upstream); all packages are ESM (`"type": "module"`), TypeScript `strict`, NodeNext module resolution (relative imports end in `.js`).
- Plugin identity: npm `@kyoube/plugin-terminal` ↔ manifest id `kyoube.terminal`; npm `@kyoube/plugin-apps` ↔ manifest id `kyoube.apps` (Phase 2).
- Runtime paths inside the container: plugins `/opt/kyoube/plugins/<name>`, bootstrap `/opt/kyoube/bootstrap/dist/kyoube.mjs`, wrapper `/usr/local/bin/kyoube`, config `/paperclip/kyoube/config.json`, board key `/paperclip/kyoube/board-key.json`, Hermes data `/paperclip/.hermes`.
- Environment variables: `KYOUBE_DATABASE_URL` (required), `KYOUBE_BOARD_API_KEY` (optional), `KYOUBE_PLUGIN_ROOT` (default `/opt/kyoube/plugins`), `KYOUBE_CONFIG_PATH` (default `/paperclip/kyoube/config.json`), `PAPERCLIP_API_URL` (default `http://127.0.0.1:3100`), `PAPERCLIP_PUBLIC_URL`.
- The repository never contains runtime data: `.env`, `data/`, `dist/`, `node_modules/` are git-ignored; compose uses named volumes only.
- Commits are small and use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Every step that runs a command states the expected outcome; do not proceed on an unexpected result.

---

## File structure

```
KyoubeAI/
├─ .editorconfig · .gitignore · .dockerignore · .nvmrc · LICENSE · README.md
├─ package.json · pnpm-workspace.yaml · pnpm-lock.yaml · tsconfig.base.json
├─ .env.example · docker-compose.yml
├─ docker/
│  ├─ Dockerfile                      # kyoube-build stage + runtime overlay on upstream image
│  ├─ entrypoint.sh                   # writes config, starts bootstrap watcher, execs upstream entrypoint
│  ├─ kyoube                          # /usr/local/bin/kyoube wrapper (drops to `node` user)
│  ├─ postgres-init/01-kyoube.sh      # creates role + database `kyoube` on first DB init
│  └─ bootstrap/                      # @kyoube/bootstrap — the `kyoube` CLI (no runtime deps)
│     ├─ package.json · tsconfig.json · build.mjs · vitest.config.ts
│     ├─ src/config.ts                # KyoubeConfig: render from env, read/write file
│     ├─ src/paperclip-api.ts         # HTTP client: health, plugins, cli-auth challenge, whoami
│     ├─ src/plugins.ts               # scan plugin root, plan install/upgrade/skip
│     ├─ src/key-store.ts             # board-key.json read/write, env override
│     ├─ src/commands/write-config.ts
│     ├─ src/commands/ensure-plugins.ts
│     ├─ src/commands/setup.ts
│     ├─ src/commands/doctor.ts
│     ├─ src/cli.ts                   # argv parsing + dispatch (entry point)
│     └─ tests/*.spec.ts
├─ plugins/kyoube-terminal/           # @kyoube/plugin-terminal skeleton (completed in Phase 1)
│  ├─ package.json · tsconfig.json · build.mjs · vitest.config.ts
│  ├─ src/manifest.ts · src/worker.ts
│  └─ tests/plugin.spec.ts
├─ scripts/smoke.sh · scripts/smoke.env
└─ .github/workflows/ci.yml
```

---

### Task 1: Repository skeleton and toolchain

**Files:**
- Create: `.gitignore`, `.dockerignore`, `.editorconfig`, `.nvmrc`, `LICENSE`, `README.md`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`

**Interfaces:**
- Produces: root `pnpm` workspace containing `docker/bootstrap`, `plugins/*`, `packages/*`; shared `tsconfig.base.json` every package extends.

- [ ] **Step 1: Initialise git and write the ignore files**

Run: `cd C:\Users\user\KyoubeAI && git init -b main`
Expected: `Initialized empty Git repository`

`.gitignore`:
```
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
data/
*.log
.DS_Store
```

`.dockerignore`:
```
.git
**/node_modules
**/dist
**/coverage
data
.env
.env.*
docs
.github
scripts
*.md
!README.md
```

`.editorconfig`:
```
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`.nvmrc`:
```
24
```

- [ ] **Step 2: Write LICENSE (MIT) with the upstream notice**

`LICENSE`:
```
MIT License

Copyright (c) 2026 KyoubeAI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

KyoubeAI builds on Paperclip (https://github.com/paperclipai/paperclip),
Copyright (c) 2025 Paperclip AI, distributed under the MIT License. The
Paperclip image and packages are consumed as published artifacts and are not
modified by this project.
```

- [ ] **Step 3: Write the workspace manifests**

`package.json`:
```json
{
  "name": "kyoubeai",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Multi-user AI operating system for organisations, built on Paperclip",
  "license": "MIT",
  "packageManager": "pnpm@9.15.4",
  "engines": {
    "node": ">=24.11.0"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "smoke": "bash scripts/smoke.sh"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "^0.28.2",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "docker/bootstrap"
  - "plugins/*"
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  }
}
```

`README.md` (stub; replaced in Task 9):
```markdown
# KyoubeAI

Multi-user AI operating system for organisations, built on [Paperclip](https://github.com/paperclipai/paperclip).

Work in progress — see `docs/superpowers/specs/` for the design.
```

- [ ] **Step 4: Install and verify the toolchain**

Run: `corepack enable && pnpm install`
Expected: `pnpm-lock.yaml` is created; no errors. (`pnpm -v` prints `9.15.4`.)

- [ ] **Step 5: Commit**

```bash
git add .gitignore .dockerignore .editorconfig .nvmrc LICENSE README.md package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json
git commit -m "chore: repository skeleton and toolchain"
```

---

### Task 2: Bootstrap package and config module

**Files:**
- Create: `docker/bootstrap/package.json`, `docker/bootstrap/tsconfig.json`, `docker/bootstrap/vitest.config.ts`, `docker/bootstrap/build.mjs`, `docker/bootstrap/src/config.ts`
- Test: `docker/bootstrap/tests/config.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KyoubeConfig { version: 1; dataDatabaseUrl: string; home: string; hermesHome: string; pluginRoot: string; paperclipApiUrl: string; publicUrl: string; imageVersion: string }
  export const DEFAULT_CONFIG_PATH = "/paperclip/kyoube/config.json";
  export function resolveConfigPath(env: NodeJS.ProcessEnv): string;
  export function renderConfigFromEnv(env: NodeJS.ProcessEnv): KyoubeConfig;   // throws Error("KYOUBE_DATABASE_URL is required") when missing
  export async function writeConfig(filePath: string, config: KyoubeConfig): Promise<void>; // mkdir -p, mode 0600
  export async function readConfig(filePath: string): Promise<KyoubeConfig>;   // throws if missing/invalid
  ```

- [ ] **Step 1: Create the package files**

`docker/bootstrap/package.json`:
```json
{
  "name": "@kyoube/bootstrap",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "The `kyoube` CLI: writes runtime config, installs Kyoube plugins into Paperclip, and runs diagnostics",
  "files": ["dist", "package.json"],
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "^0.28.2",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

`docker/bootstrap/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "tests"]
}
```

`docker/bootstrap/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
```

`docker/bootstrap/build.mjs`:
```js
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/kyoube.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node24"],
  sourcemap: false,
  logLevel: "info",
});
```

- [ ] **Step 2: Write the failing config tests**

`docker/bootstrap/tests/config.spec.ts`:
```ts
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG_PATH,
  readConfig,
  renderConfigFromEnv,
  resolveConfigPath,
  writeConfig,
} from "../src/config.js";

describe("renderConfigFromEnv", () => {
  it("builds a config from the required and defaulted variables", () => {
    const config = renderConfigFromEnv({
      KYOUBE_DATABASE_URL: "postgres://kyoube:pw@db:5432/kyoube",
      PAPERCLIP_PUBLIC_URL: "http://localhost:3100",
      KYOUBE_VERSION: "1.2.3",
    });
    expect(config).toEqual({
      version: 1,
      dataDatabaseUrl: "postgres://kyoube:pw@db:5432/kyoube",
      home: "/paperclip",
      hermesHome: "/paperclip/.hermes",
      pluginRoot: "/opt/kyoube/plugins",
      paperclipApiUrl: "http://127.0.0.1:3100",
      publicUrl: "http://localhost:3100",
      imageVersion: "1.2.3",
    });
  });

  it("honours overrides for home, plugin root, api url, and hermes home", () => {
    const config = renderConfigFromEnv({
      KYOUBE_DATABASE_URL: "postgres://x",
      PAPERCLIP_HOME: "/data/pc",
      KYOUBE_PLUGIN_ROOT: "/plugins",
      PAPERCLIP_API_URL: "http://app:3100/",
      HERMES_HOME: "/data/pc/hermes",
    });
    expect(config.home).toBe("/data/pc");
    expect(config.pluginRoot).toBe("/plugins");
    expect(config.paperclipApiUrl).toBe("http://app:3100");
    expect(config.hermesHome).toBe("/data/pc/hermes");
    expect(config.publicUrl).toBe("http://127.0.0.1:3100");
    expect(config.imageVersion).toBe("dev");
  });

  it("throws when KYOUBE_DATABASE_URL is missing", () => {
    expect(() => renderConfigFromEnv({})).toThrow("KYOUBE_DATABASE_URL is required");
  });
});

describe("resolveConfigPath", () => {
  it("defaults to the container path and honours KYOUBE_CONFIG_PATH", () => {
    expect(resolveConfigPath({})).toBe(DEFAULT_CONFIG_PATH);
    expect(resolveConfigPath({ KYOUBE_CONFIG_PATH: "/tmp/k.json" })).toBe("/tmp/k.json");
  });
});

describe("writeConfig / readConfig", () => {
  it("round-trips through disk, creating parent directories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-config-"));
    const filePath = path.join(dir, "nested", "config.json");
    const config = renderConfigFromEnv({ KYOUBE_DATABASE_URL: "postgres://x" });
    await writeConfig(filePath, config);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(config);
    expect(await readConfig(filePath)).toEqual(config);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects a file that is not a version-1 config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-config-"));
    const filePath = path.join(dir, "bad.json");
    await writeConfig(filePath, { version: 1, dataDatabaseUrl: "" } as never);
    await expect(readConfig(filePath)).rejects.toThrow("dataDatabaseUrl");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/bootstrap install && pnpm --filter @kyoube/bootstrap test`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 4: Implement config.ts**

`docker/bootstrap/src/config.ts`:
```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface KyoubeConfig {
  version: 1;
  dataDatabaseUrl: string;
  home: string;
  hermesHome: string;
  pluginRoot: string;
  paperclipApiUrl: string;
  publicUrl: string;
  imageVersion: string;
}

export const DEFAULT_CONFIG_PATH = "/paperclip/kyoube/config.json";
export const DEFAULT_API_URL = "http://127.0.0.1:3100";

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.KYOUBE_CONFIG_PATH) ?? DEFAULT_CONFIG_PATH;
}

export function renderConfigFromEnv(env: NodeJS.ProcessEnv): KyoubeConfig {
  const dataDatabaseUrl = nonEmpty(env.KYOUBE_DATABASE_URL);
  if (!dataDatabaseUrl) {
    throw new Error("KYOUBE_DATABASE_URL is required");
  }
  const home = nonEmpty(env.PAPERCLIP_HOME) ?? "/paperclip";
  const paperclipApiUrl = trimSlash(nonEmpty(env.PAPERCLIP_API_URL) ?? DEFAULT_API_URL);
  return {
    version: 1,
    dataDatabaseUrl,
    home,
    hermesHome: nonEmpty(env.HERMES_HOME) ?? path.posix.join(home, ".hermes"),
    pluginRoot: nonEmpty(env.KYOUBE_PLUGIN_ROOT) ?? "/opt/kyoube/plugins",
    paperclipApiUrl,
    publicUrl: trimSlash(nonEmpty(env.PAPERCLIP_PUBLIC_URL) ?? paperclipApiUrl),
    imageVersion: nonEmpty(env.KYOUBE_VERSION) ?? "dev",
  };
}

export async function writeConfig(filePath: string, config: KyoubeConfig): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

const REQUIRED_STRING_FIELDS: Array<keyof KyoubeConfig> = [
  "dataDatabaseUrl",
  "home",
  "hermesHome",
  "pluginRoot",
  "paperclipApiUrl",
  "publicUrl",
  "imageVersion",
];

export async function readConfig(filePath: string): Promise<KyoubeConfig> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<KyoubeConfig>;
  if (raw.version !== 1) {
    throw new Error(`Unsupported kyoube config version in ${filePath}`);
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`kyoube config ${filePath} is missing ${field}`);
    }
  }
  return raw as KyoubeConfig;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kyoube/bootstrap test`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add docker/bootstrap pnpm-lock.yaml
git commit -m "feat(bootstrap): package skeleton and runtime config module"
```

---

### Task 3: Paperclip API client

**Files:**
- Create: `docker/bootstrap/src/paperclip-api.ts`
- Test: `docker/bootstrap/tests/paperclip-api.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HealthInfo { status: string; version?: string; deploymentMode?: string; deploymentExposure?: string; bootstrapStatus?: string }
  export interface InstalledPlugin { id: string; pluginKey: string; version: string; status: string; packagePath: string | null }
  export interface CliAuthChallenge { id: string; token: string; boardApiToken: string; approvalPath: string; approvalUrl: string | null; pollPath: string; expiresAt: string; suggestedPollIntervalMs: number }
  export type CliAuthStatus = "pending" | "approved" | "cancelled" | "expired";
  export interface PaperclipClient {
    apiBase: string;
    getHealth(): Promise<HealthInfo>;
    waitForHealth(opts?: { timeoutMs?: number; intervalMs?: number }): Promise<HealthInfo>;
    listPlugins(): Promise<InstalledPlugin[]>;
    installLocalPlugin(localPath: string): Promise<InstalledPlugin>;
    createCliAuthChallenge(input: { command: string; clientName: string }): Promise<CliAuthChallenge>;
    getCliAuthChallengeStatus(pollPath: string, token: string): Promise<CliAuthStatus>;
    whoAmI(token: string): Promise<{ userId: string | null }>;
  }
  export function createPaperclipClient(opts: { apiBase: string; apiKey?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): PaperclipClient;
  export class PaperclipApiError extends Error { status: number; body: unknown }
  ```
- Upstream contract used (verified against Paperclip `2026.831.1` sources): `GET /api/health`; `GET /api/plugins` → `PluginRecord[]`; `POST /api/plugins/install` body `{ packageName: <absolute path>, isLocalPath: true }` (instance admin only; HTTP 400 `Plugin already installed: <id>` for any live row); `POST /api/plugins/:pluginId/upgrade` (re-reads the stored `packagePath`; HTTP 400 when the new manifest adds capabilities); `DELETE /api/plugins/:pluginId` (soft uninstall keeps plugin state, `?purge=true` hard-deletes); `POST /api/cli-auth/challenges` body `{ command, clientName, requestedAccess: "instance_admin_required", requestedCompanyId: null }`; `GET /api${pollPath}?token=…` → `{ status }`; `GET /api/cli-auth/me` with `Authorization: Bearer <boardApiToken>` → `{ userId }`.

- [ ] **Step 1: Write the failing tests**

`docker/bootstrap/tests/paperclip-api.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createPaperclipClient, PaperclipApiError } from "../src/paperclip-api.js";

interface RecordedRequest { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(responder: (req: RecordedRequest) => { status: number; body?: unknown }) {
  const requests: RecordedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => { headers[key] = value; });
    const record: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(record);
    const result = responder(record);
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, requests };
}

describe("createPaperclipClient", () => {
  it("sends the bearer token and parses plugin lists", async () => {
    const { impl, requests } = fakeFetch(() => ({
      status: 200,
      body: [{ id: "p1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "ready", packagePath: "/opt/x", extra: 1 }],
    }));
    const client = createPaperclipClient({ apiBase: "http://app:3100/", apiKey: "k", fetchImpl: impl });
    const plugins = await client.listPlugins();
    expect(plugins).toEqual([{ id: "p1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "ready", packagePath: "/opt/x" }]);
    expect(requests[0]?.url).toBe("http://app:3100/api/plugins");
    expect(requests[0]?.headers.authorization).toBe("Bearer k");
  });

  it("installs a local plugin with the upstream body shape", async () => {
    const { impl, requests } = fakeFetch(() => ({
      status: 200,
      body: { id: "p2", pluginKey: "kyoube.apps", version: "0.1.0", status: "ready", packagePath: "/opt/kyoube/plugins/apps" },
    }));
    const client = createPaperclipClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    const installed = await client.installLocalPlugin("/opt/kyoube/plugins/apps");
    expect(installed.pluginKey).toBe("kyoube.apps");
    expect(requests[0]).toMatchObject({
      url: "http://app:3100/api/plugins/install",
      method: "POST",
      body: { packageName: "/opt/kyoube/plugins/apps", isLocalPath: true },
    });
  });

  it("throws PaperclipApiError with status and body on non-2xx", async () => {
    const { impl } = fakeFetch(() => ({ status: 403, body: { error: "instance admin required" } }));
    const client = createPaperclipClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    await expect(client.listPlugins()).rejects.toMatchObject({ status: 403, message: "instance admin required" });
    await expect(client.listPlugins()).rejects.toBeInstanceOf(PaperclipApiError);
  });

  it("waitForHealth retries until the server answers", async () => {
    let calls = 0;
    const { impl } = fakeFetch(() => {
      calls += 1;
      return calls < 3 ? { status: 503 } : { status: 200, body: { status: "ok", version: "2026.831.1", deploymentMode: "authenticated" } };
    });
    const sleeps: number[] = [];
    const client = createPaperclipClient({ apiBase: "http://app:3100", fetchImpl: impl, sleep: async (ms) => { sleeps.push(ms); } });
    const health = await client.waitForHealth({ timeoutMs: 10_000, intervalMs: 250 });
    expect(health.version).toBe("2026.831.1");
    expect(sleeps).toEqual([250, 250]);
  });

  it("waitForHealth gives up after the timeout", async () => {
    const { impl } = fakeFetch(() => { throw new Error("connect ECONNREFUSED"); });
    let now = 0;
    const client = createPaperclipClient({
      apiBase: "http://app:3100",
      fetchImpl: impl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    await expect(client.waitForHealth({ timeoutMs: 1000, intervalMs: 400 })).rejects.toThrow("did not become healthy");
  });

  it("drives the CLI auth challenge endpoints", async () => {
    const { impl, requests } = fakeFetch((req) => {
      if (req.url.endsWith("/api/cli-auth/challenges")) {
        return { status: 201, body: { id: "c1", token: "t", boardApiToken: "board-token", approvalPath: "/cli-auth/approve/c1", approvalUrl: null, pollPath: "/cli-auth/challenges/c1", expiresAt: "2030-01-01T00:00:00.000Z", suggestedPollIntervalMs: 1000 } };
      }
      if (req.url.includes("/api/cli-auth/challenges/c1?token=t")) return { status: 200, body: { status: "approved" } };
      if (req.url.endsWith("/api/cli-auth/me")) return { status: 200, body: { userId: "u1" } };
      return { status: 404 };
    });
    const client = createPaperclipClient({ apiBase: "http://app:3100", fetchImpl: impl });
    const challenge = await client.createCliAuthChallenge({ command: "kyoube setup", clientName: "kyoube" });
    expect(challenge.boardApiToken).toBe("board-token");
    expect(requests[0]?.body).toEqual({ command: "kyoube setup", clientName: "kyoube", requestedAccess: "instance_admin_required", requestedCompanyId: null });
    expect(await client.getCliAuthChallengeStatus(challenge.pollPath, challenge.token)).toBe("approved");
    expect(await client.whoAmI("board-token")).toEqual({ userId: "u1" });
    expect(requests[2]?.headers.authorization).toBe("Bearer board-token");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/bootstrap test`
Expected: FAIL — `Cannot find module '../src/paperclip-api.js'`

- [ ] **Step 3: Implement paperclip-api.ts**

`docker/bootstrap/src/paperclip-api.ts`:
```ts
export interface HealthInfo {
  status: string;
  version?: string;
  deploymentMode?: string;
  deploymentExposure?: string;
  bootstrapStatus?: string;
}

export interface InstalledPlugin {
  id: string;
  pluginKey: string;
  version: string;
  status: string;
  packagePath: string | null;
}

export interface CliAuthChallenge {
  id: string;
  token: string;
  boardApiToken: string;
  approvalPath: string;
  approvalUrl: string | null;
  pollPath: string;
  expiresAt: string;
  suggestedPollIntervalMs: number;
}

export type CliAuthStatus = "pending" | "approved" | "cancelled" | "expired";

export interface PaperclipClient {
  apiBase: string;
  getHealth(): Promise<HealthInfo>;
  waitForHealth(opts?: { timeoutMs?: number; intervalMs?: number }): Promise<HealthInfo>;
  listPlugins(): Promise<InstalledPlugin[]>;
  installLocalPlugin(localPath: string): Promise<InstalledPlugin>;
  createCliAuthChallenge(input: { command: string; clientName: string }): Promise<CliAuthChallenge>;
  getCliAuthChallengeStatus(pollPath: string, token: string): Promise<CliAuthStatus>;
  whoAmI(token: string): Promise<{ userId: string | null }>;
}

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "PaperclipApiError";
    this.status = status;
    this.body = body;
  }
}

export interface PaperclipClientOptions {
  apiBase: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toInstalledPlugin(raw: unknown): InstalledPlugin {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(record.id ?? ""),
    pluginKey: String(record.pluginKey ?? ""),
    version: String(record.version ?? ""),
    status: String(record.status ?? ""),
    packagePath: typeof record.packagePath === "string" ? record.packagePath : null,
  };
}

export function createPaperclipClient(opts: PaperclipClientOptions): PaperclipClient {
  const apiBase = opts.apiBase.trim().replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  async function request<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = init.token ?? opts.apiKey;
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${apiBase}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const body: unknown = text ? safeJson(text) : null;
    if (!response.ok) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Paperclip request failed: ${response.status} ${init.method ?? "GET"} ${path}`;
      throw new PaperclipApiError(response.status, body, message);
    }
    return body as T;
  }

  return {
    apiBase,
    getHealth: () => request<HealthInfo>("/api/health"),
    async waitForHealth({ timeoutMs = 180_000, intervalMs = 1000 } = {}) {
      const deadline = now() + timeoutMs;
      let lastError: unknown = null;
      while (now() < deadline) {
        try {
          return await request<HealthInfo>("/api/health");
        } catch (error) {
          lastError = error;
          await sleep(intervalMs);
        }
      }
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Paperclip at ${apiBase} did not become healthy within ${timeoutMs}ms (${reason})`);
    },
    async listPlugins() {
      const rows = await request<unknown[]>("/api/plugins");
      return rows.map(toInstalledPlugin);
    },
    async installLocalPlugin(localPath) {
      const raw = await request<unknown>("/api/plugins/install", {
        method: "POST",
        body: { packageName: localPath, isLocalPath: true },
      });
      return toInstalledPlugin(raw);
    },
    createCliAuthChallenge: (input) =>
      request<CliAuthChallenge>("/api/cli-auth/challenges", {
        method: "POST",
        body: { command: input.command, clientName: input.clientName, requestedAccess: "instance_admin_required", requestedCompanyId: null },
      }),
    async getCliAuthChallengeStatus(pollPath, token) {
      const result = await request<{ status: CliAuthStatus }>(`/api${pollPath}?token=${encodeURIComponent(token)}`);
      return result.status;
    },
    async whoAmI(token) {
      const me = await request<{ userId?: string; user?: { id?: string } | null }>("/api/cli-auth/me", { token });
      return { userId: me.userId ?? me.user?.id ?? null };
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kyoube/bootstrap test`
Expected: PASS (all config + api tests)

- [ ] **Step 5: Commit**

```bash
git add docker/bootstrap/src/paperclip-api.ts docker/bootstrap/tests/paperclip-api.spec.ts
git commit -m "feat(bootstrap): Paperclip API client for health, plugins, and CLI auth"
```

---

### Task 4: Plugin discovery and install planning

**Files:**
- Create: `docker/bootstrap/src/plugins.ts`
- Test: `docker/bootstrap/tests/plugins.spec.ts`

**Interfaces:**
- Consumes: `InstalledPlugin` from Task 3.
- Produces:
  ```ts
  export interface LocalPluginBundle { dir: string; name: string; pluginKey: string; version: string }
  export async function scanPluginRoot(root: string): Promise<LocalPluginBundle[]>; // subdirs containing dist/manifest.js; sorted by name
  export type PluginAction = "install" | "upgrade" | "skip";
  export interface PluginPlan { bundle: LocalPluginBundle; action: PluginAction; reason: string; installed: InstalledPlugin | null }
  export function planPluginInstalls(local: LocalPluginBundle[], installed: InstalledPlugin[]): PluginPlan[];
  ```
- Rules: not installed, or installed with status `uninstalled` → `install`; installed with a different `version` → `upgrade` (executed through `POST /api/plugins/:pluginId/upgrade`; if upstream rejects it because the new manifest adds capabilities, ensure-plugins soft-uninstalls and re-installs from the same path so the row is reactivated with the new manifest and plugin state is kept — ruling R15); same version → `skip`. Status `disabled` is left alone (`skip`, reason mentions operator-disabled).

- [ ] **Step 1: Write the failing tests**

`docker/bootstrap/tests/plugins.spec.ts`:
```ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planPluginInstalls, scanPluginRoot, type LocalPluginBundle } from "../src/plugins.js";

async function makeBundle(root: string, name: string, id: string, version: string) {
  await mkdir(path.join(root, name, "dist"), { recursive: true });
  await writeFile(
    path.join(root, name, "dist", "manifest.js"),
    `export default { id: ${JSON.stringify(id)}, apiVersion: 1, version: ${JSON.stringify(version)} };\n`,
  );
}

describe("scanPluginRoot", () => {
  it("returns one bundle per directory that has dist/manifest.js, sorted by name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kyoube-plugins-"));
    await makeBundle(root, "terminal", "kyoube.terminal", "0.1.0");
    await makeBundle(root, "apps", "kyoube.apps", "0.2.0");
    await mkdir(path.join(root, "not-a-plugin"));
    const bundles = await scanPluginRoot(root);
    expect(bundles).toEqual([
      { dir: path.join(root, "apps"), name: "apps", pluginKey: "kyoube.apps", version: "0.2.0" },
      { dir: path.join(root, "terminal"), name: "terminal", pluginKey: "kyoube.terminal", version: "0.1.0" },
    ]);
  });

  it("returns an empty list for a missing root", async () => {
    expect(await scanPluginRoot(path.join(os.tmpdir(), "does-not-exist-kyoube"))).toEqual([]);
  });
});

describe("planPluginInstalls", () => {
  const terminal: LocalPluginBundle = { dir: "/opt/kyoube/plugins/terminal", name: "terminal", pluginKey: "kyoube.terminal", version: "0.2.0" };

  it("installs when the plugin is absent", () => {
    const [plan] = planPluginInstalls([terminal], []);
    expect(plan).toMatchObject({ action: "install", installed: null });
  });

  it("reinstalls when the plugin was uninstalled", () => {
    const installed = { id: "1", pluginKey: "kyoube.terminal", version: "0.2.0", status: "uninstalled", packagePath: null };
    expect(planPluginInstalls([terminal], [installed])[0]).toMatchObject({ action: "install" });
  });

  it("upgrades when versions differ", () => {
    const installed = { id: "1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "ready", packagePath: "/opt/kyoube/plugins/terminal" };
    expect(planPluginInstalls([terminal], [installed])[0]).toMatchObject({ action: "upgrade", reason: expect.stringContaining("0.1.0 -> 0.2.0") });
  });

  it("skips when versions match and leaves disabled plugins alone", () => {
    const ready = { id: "1", pluginKey: "kyoube.terminal", version: "0.2.0", status: "ready", packagePath: null };
    expect(planPluginInstalls([terminal], [ready])[0]).toMatchObject({ action: "skip" });
    const disabled = { ...ready, version: "0.1.0", status: "disabled" };
    expect(planPluginInstalls([terminal], [disabled])[0]).toMatchObject({ action: "skip", reason: expect.stringContaining("disabled") });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/bootstrap test`
Expected: FAIL — `Cannot find module '../src/plugins.js'`

- [ ] **Step 3: Implement plugins.ts**

`docker/bootstrap/src/plugins.ts`:
```ts
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { InstalledPlugin } from "./paperclip-api.js";

export interface LocalPluginBundle {
  dir: string;
  name: string;
  pluginKey: string;
  version: string;
}

export type PluginAction = "install" | "upgrade" | "skip";

export interface PluginPlan {
  bundle: LocalPluginBundle;
  action: PluginAction;
  reason: string;
  installed: InstalledPlugin | null;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(manifestPath: string): Promise<{ id: string; version: string }> {
  const mod = (await import(pathToFileURL(manifestPath).href)) as { default?: { id?: unknown; version?: unknown } };
  const manifest = mod.default ?? {};
  if (typeof manifest.id !== "string" || typeof manifest.version !== "string") {
    throw new Error(`Invalid plugin manifest at ${manifestPath}: expected default export with id and version`);
  }
  return { id: manifest.id, version: manifest.version };
}

export async function scanPluginRoot(root: string): Promise<LocalPluginBundle[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const bundles: LocalPluginBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, "dist", "manifest.js");
    if (!(await exists(manifestPath))) continue;
    const manifest = await readManifest(manifestPath);
    bundles.push({ dir, name: entry.name, pluginKey: manifest.id, version: manifest.version });
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name));
}

export function planPluginInstalls(local: LocalPluginBundle[], installed: InstalledPlugin[]): PluginPlan[] {
  return local.map((bundle) => {
    const current = installed.find((plugin) => plugin.pluginKey === bundle.pluginKey) ?? null;
    if (!current || current.status === "uninstalled") {
      return { bundle, action: "install", reason: current ? "previously uninstalled" : "not installed", installed: current };
    }
    if (current.status === "disabled") {
      return { bundle, action: "skip", reason: "operator-disabled; leaving as-is", installed: current };
    }
    if (current.version !== bundle.version) {
      return { bundle, action: "upgrade", reason: `version ${current.version} -> ${bundle.version}`, installed: current };
    }
    return { bundle, action: "skip", reason: `already at ${bundle.version} (${current.status})`, installed: current };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kyoube/bootstrap test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docker/bootstrap/src/plugins.ts docker/bootstrap/tests/plugins.spec.ts
git commit -m "feat(bootstrap): discover plugin bundles and plan installs"
```

---

### Task 5: Bootstrap commands and CLI entry point

**Files:**
- Create: `docker/bootstrap/src/key-store.ts`, `docker/bootstrap/src/commands/write-config.ts`, `docker/bootstrap/src/commands/ensure-plugins.ts`, `docker/bootstrap/src/commands/setup.ts`, `docker/bootstrap/src/commands/doctor.ts`, `docker/bootstrap/src/cli.ts`
- Test: `docker/bootstrap/tests/key-store.spec.ts`, `docker/bootstrap/tests/ensure-plugins.spec.ts`, `docker/bootstrap/tests/cli.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  ```ts
  // key-store.ts
  export interface BoardKeyRecord { token: string; userId: string | null; createdAt: string }
  export function resolveBoardKeyPath(config: KyoubeConfig): string;           // `${config.home}/kyoube/board-key.json`
  export async function readBoardKey(filePath: string): Promise<BoardKeyRecord | null>;
  export async function writeBoardKey(filePath: string, record: BoardKeyRecord): Promise<void>; // mode 0600
  export async function resolveBoardApiKey(env: NodeJS.ProcessEnv, filePath: string, explicit?: string): Promise<string | null>; // explicit > env KYOUBE_BOARD_API_KEY > file
  // commands/ensure-plugins.ts
  export interface EnsurePluginsDeps { client: PaperclipClient; scan: () => Promise<LocalPluginBundle[]>; log: (line: string) => void }
  export async function ensurePlugins(deps: EnsurePluginsDeps): Promise<{ installed: string[]; upgraded: string[]; skipped: string[] }>;
  export async function runEnsurePlugins(args: string[], env: NodeJS.ProcessEnv): Promise<number>; // exit code: 0 ok, 2 no key, 1 error
  // cli.ts
  export function parseArgs(argv: string[]): { command: string | null; flags: Record<string, string | true>; positionals: string[] };
  export async function main(argv: string[], env?: NodeJS.ProcessEnv): Promise<number>;
  ```
- Exit-code contract used by the entrypoint and smoke test: `ensure-plugins` returns `2` when no board key is available (prints the `kyoube setup` instruction), `0` on success, `1` on any API failure.

- [ ] **Step 1: Write the failing key-store tests**

`docker/bootstrap/tests/key-store.spec.ts`:
```ts
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBoardKey, resolveBoardApiKey, resolveBoardKeyPath, writeBoardKey } from "../src/key-store.js";
import { renderConfigFromEnv } from "../src/config.js";

describe("key-store", () => {
  it("derives the key path from the config home", () => {
    const config = renderConfigFromEnv({ KYOUBE_DATABASE_URL: "postgres://x", PAPERCLIP_HOME: "/data" });
    expect(resolveBoardKeyPath(config)).toBe("/data/kyoube/board-key.json");
  });

  it("round-trips a key record and returns null when absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    expect(await readBoardKey(filePath)).toBeNull();
    await writeBoardKey(filePath, { token: "pcp_x", userId: "u1", createdAt: "2026-09-05T00:00:00.000Z" });
    expect(await readBoardKey(filePath)).toEqual({ token: "pcp_x", userId: "u1", createdAt: "2026-09-05T00:00:00.000Z" });
  });

  it("prefers explicit, then env, then file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    await writeBoardKey(filePath, { token: "from-file", userId: null, createdAt: "2026-09-05T00:00:00.000Z" });
    expect(await resolveBoardApiKey({ KYOUBE_BOARD_API_KEY: "from-env" }, filePath, "explicit")).toBe("explicit");
    expect(await resolveBoardApiKey({ KYOUBE_BOARD_API_KEY: "from-env" }, filePath)).toBe("from-env");
    expect(await resolveBoardApiKey({}, filePath)).toBe("from-file");
    expect(await resolveBoardApiKey({}, path.join(dir, "missing.json"))).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing ensure-plugins tests**

`docker/bootstrap/tests/ensure-plugins.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ensurePlugins } from "../src/commands/ensure-plugins.js";
import type { InstalledPlugin, PaperclipClient } from "../src/paperclip-api.js";

function fakeClient(installed: InstalledPlugin[]) {
  const installs: string[] = [];
  const client = {
    apiBase: "http://app:3100",
    async getHealth() { return { status: "ok" }; },
    async waitForHealth() { return { status: "ok" }; },
    async listPlugins() { return installed; },
    async installLocalPlugin(localPath: string) {
      installs.push(localPath);
      return { id: "new", pluginKey: "kyoube.terminal", version: "0.2.0", status: "ready", packagePath: localPath };
    },
    async createCliAuthChallenge() { throw new Error("not used"); },
    async getCliAuthChallengeStatus() { throw new Error("not used"); },
    async whoAmI() { throw new Error("not used"); },
  } satisfies PaperclipClient;
  return { client, installs };
}

describe("ensurePlugins", () => {
  it("installs missing bundles, upgrades outdated ones, skips current ones", async () => {
    const { client, installs } = fakeClient([
      { id: "1", pluginKey: "kyoube.apps", version: "0.1.0", status: "ready", packagePath: "/opt/kyoube/plugins/apps" },
      { id: "2", pluginKey: "kyoube.other", version: "0.1.0", status: "ready", packagePath: "/opt/kyoube/plugins/other" },
    ]);
    const lines: string[] = [];
    const result = await ensurePlugins({
      client,
      log: (line) => lines.push(line),
      scan: async () => [
        { dir: "/opt/kyoube/plugins/apps", name: "apps", pluginKey: "kyoube.apps", version: "0.2.0" },
        { dir: "/opt/kyoube/plugins/other", name: "other", pluginKey: "kyoube.other", version: "0.1.0" },
        { dir: "/opt/kyoube/plugins/terminal", name: "terminal", pluginKey: "kyoube.terminal", version: "0.2.0" },
      ],
    });
    expect(installs).toEqual(["/opt/kyoube/plugins/apps", "/opt/kyoube/plugins/terminal"]);
    expect(result).toEqual({ installed: ["kyoube.terminal"], upgraded: ["kyoube.apps"], skipped: ["kyoube.other"] });
    expect(lines.some((line) => line.includes("kyoube.terminal"))).toBe(true);
  });

  it("fails when a plugin is installed but reports an error status", async () => {
    const { client } = fakeClient([]);
    client.installLocalPlugin = async (localPath) => ({ id: "x", pluginKey: "kyoube.terminal", version: "0.2.0", status: "error", packagePath: localPath });
    await expect(ensurePlugins({
      client,
      log: () => {},
      scan: async () => [{ dir: "/opt/kyoube/plugins/terminal", name: "terminal", pluginKey: "kyoube.terminal", version: "0.2.0" }],
    })).rejects.toThrow("kyoube.terminal installed with status error");
  });
});
```

- [ ] **Step 3: Write the failing CLI parsing tests**

`docker/bootstrap/tests/cli.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("splits command, flags, and positionals", () => {
    expect(parseArgs(["ensure-plugins", "--watch", "--api-key", "k", "extra"])).toEqual({
      command: "ensure-plugins",
      flags: { watch: true, "api-key": "k" },
      positionals: ["extra"],
    });
    expect(parseArgs(["--help"])).toEqual({ command: null, flags: { help: true }, positionals: [] });
    expect(parseArgs(["setup", "--api-base=http://x:1"])).toEqual({ command: "setup", flags: { "api-base": "http://x:1" }, positionals: [] });
  });
});

describe("main", () => {
  it("prints usage and returns 0 for --help, 1 for unknown commands", async () => {
    const out: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => { out.push(String(line)); };
    try {
      expect(await main(["--help"])).toBe(0);
      expect(out.join("\n")).toContain("ensure-plugins");
      expect(await main(["nope"])).toBe(1);
    } finally {
      console.log = original;
    }
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/bootstrap test`
Expected: FAIL — modules `../src/key-store.js`, `../src/commands/ensure-plugins.js`, `../src/cli.js` not found

- [ ] **Step 5: Implement key-store.ts**

`docker/bootstrap/src/key-store.ts`:
```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KyoubeConfig } from "./config.js";

export interface BoardKeyRecord {
  token: string;
  userId: string | null;
  createdAt: string;
}

export function resolveBoardKeyPath(config: KyoubeConfig): string {
  return path.posix.join(config.home, "kyoube", "board-key.json");
}

export async function readBoardKey(filePath: string): Promise<BoardKeyRecord | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<BoardKeyRecord>;
  if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
  return {
    token: parsed.token,
    userId: typeof parsed.userId === "string" ? parsed.userId : null,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
  };
}

export async function writeBoardKey(filePath: string, record: BoardKeyRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function resolveBoardApiKey(
  env: NodeJS.ProcessEnv,
  filePath: string,
  explicit?: string,
): Promise<string | null> {
  const fromExplicit = explicit?.trim();
  if (fromExplicit) return fromExplicit;
  const fromEnv = env.KYOUBE_BOARD_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const stored = await readBoardKey(filePath);
  return stored?.token ?? null;
}
```

- [ ] **Step 6: Implement the write-config command**

`docker/bootstrap/src/commands/write-config.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { renderConfigFromEnv, resolveConfigPath, writeConfig } from "../config.js";

/** Renders /paperclip/kyoube/config.json from the container environment. Runs as the `node` user from the entrypoint. */
export async function runWriteConfig(env: NodeJS.ProcessEnv): Promise<number> {
  const config = renderConfigFromEnv(env);
  const filePath = resolveConfigPath(env);
  await mkdir(config.hermesHome, { recursive: true });
  await writeConfig(filePath, config);
  console.log(`kyoube: wrote ${filePath} (plugins at ${config.pluginRoot}, api ${config.paperclipApiUrl})`);
  return 0;
}
```

- [ ] **Step 7: Implement the ensure-plugins command**

`docker/bootstrap/src/commands/ensure-plugins.ts`:
```ts
import { readConfig, resolveConfigPath } from "../config.js";
import { resolveBoardApiKey, resolveBoardKeyPath } from "../key-store.js";
import { createPaperclipClient, type PaperclipClient } from "../paperclip-api.js";
import { planPluginInstalls, scanPluginRoot, type LocalPluginBundle } from "../plugins.js";

export interface EnsurePluginsDeps {
  client: PaperclipClient;
  scan: () => Promise<LocalPluginBundle[]>;
  log: (line: string) => void;
}

export interface EnsurePluginsResult {
  installed: string[];
  upgraded: string[];
  skipped: string[];
}

export async function ensurePlugins(deps: EnsurePluginsDeps): Promise<EnsurePluginsResult> {
  const local = await deps.scan();
  const installed = await deps.client.listPlugins();
  const result: EnsurePluginsResult = { installed: [], upgraded: [], skipped: [] };
  for (const plan of planPluginInstalls(local, installed)) {
    const key = plan.bundle.pluginKey;
    if (plan.action === "skip") {
      deps.log(`kyoube: ${key} skip (${plan.reason})`);
      result.skipped.push(key);
      continue;
    }
    deps.log(`kyoube: ${key} ${plan.action} from ${plan.bundle.dir} (${plan.reason})`);
    const record = await deps.client.installLocalPlugin(plan.bundle.dir);
    if (record.status !== "ready" && record.status !== "installed") {
      throw new Error(`${key} installed with status ${record.status}`);
    }
    deps.log(`kyoube: ${key} now ${record.status} at version ${record.version}`);
    (plan.action === "install" ? result.installed : result.upgraded).push(key);
  }
  return result;
}

export const NO_KEY_EXIT_CODE = 2;

export async function runEnsurePlugins(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const config = await readConfig(resolveConfigPath(env));
  const apiBase = typeof flags["api-base"] === "string" ? flags["api-base"] : config.paperclipApiUrl;
  const watch = flags.watch === true;
  const explicitKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  const keyPath = resolveBoardKeyPath(config);

  while (true) {
    const probe = createPaperclipClient({ apiBase });
    await probe.waitForHealth({ timeoutMs: 15 * 60_000, intervalMs: 2000 });
    const apiKey = await resolveBoardApiKey(env, keyPath, explicitKey);
    if (!apiKey) {
      console.log(
        "kyoube: no board API key yet. Sign up as the first admin in the browser, then run:\n" +
          "  docker compose exec app kyoube setup\n" +
          "(or set KYOUBE_BOARD_API_KEY in .env). Kyoube plugins are not installed until then.",
      );
      if (!watch) return NO_KEY_EXIT_CODE;
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      continue;
    }
    try {
      const client = createPaperclipClient({ apiBase, apiKey });
      const result = await ensurePlugins({
        client,
        scan: () => scanPluginRoot(config.pluginRoot),
        log: (line) => console.log(line),
      });
      console.log(
        `kyoube: plugins ok (installed ${result.installed.length}, upgraded ${result.upgraded.length}, skipped ${result.skipped.length})`,
      );
      return 0;
    } catch (error) {
      console.error(`kyoube: ensure-plugins failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!watch) return 1;
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}
```

- [ ] **Step 8: Implement the setup command**

`docker/bootstrap/src/commands/setup.ts`:
```ts
import { readConfig, resolveConfigPath } from "../config.js";
import { resolveBoardKeyPath, writeBoardKey } from "../key-store.js";
import { createPaperclipClient } from "../paperclip-api.js";
import { runEnsurePlugins } from "./ensure-plugins.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One-time interactive bootstrap: obtains an instance-admin board API key via
 * Paperclip's CLI auth challenge (approved in the browser), stores it, and
 * installs the Kyoube plugins.
 */
export async function runSetup(flags: Record<string, string | true>, env: NodeJS.ProcessEnv): Promise<number> {
  const config = await readConfig(resolveConfigPath(env));
  const apiBase = typeof flags["api-base"] === "string" ? flags["api-base"] : config.paperclipApiUrl;
  const client = createPaperclipClient({ apiBase });
  const health = await client.waitForHealth({ timeoutMs: 60_000, intervalMs: 1000 });
  if (health.bootstrapStatus === "bootstrap_pending") {
    console.log(
      `kyoube: no instance admin exists yet. Open ${config.publicUrl}, sign up, and claim the instance, then re-run kyoube setup.`,
    );
    return 1;
  }

  const challenge = await client.createCliAuthChallenge({ command: "kyoube setup", clientName: "kyoube" });
  const approvalUrl = `${config.publicUrl}${challenge.approvalPath}`;
  console.log("kyoube: approve this CLI login as an instance admin in your browser:");
  console.log(`  ${approvalUrl}`);
  console.log(`  (expires ${challenge.expiresAt})`);

  const deadline = Date.parse(challenge.expiresAt);
  while (Number.isNaN(deadline) || Date.now() < deadline) {
    const status = await client.getCliAuthChallengeStatus(challenge.pollPath, challenge.token);
    if (status === "approved") {
      const me = await client.whoAmI(challenge.boardApiToken);
      const keyPath = resolveBoardKeyPath(config);
      await writeBoardKey(keyPath, { token: challenge.boardApiToken, userId: me.userId, createdAt: new Date().toISOString() });
      console.log(`kyoube: stored board API key at ${keyPath}`);
      return runEnsurePlugins({ "api-base": apiBase }, env);
    }
    if (status === "cancelled") {
      console.error("kyoube: the login was cancelled in the browser");
      return 1;
    }
    if (status === "expired") break;
    await sleep(Math.max(500, challenge.suggestedPollIntervalMs));
  }
  console.error("kyoube: the login request expired before it was approved; run kyoube setup again");
  return 1;
}
```

- [ ] **Step 9: Implement the doctor command**

`docker/bootstrap/src/commands/doctor.ts`:
```ts
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { readConfig, resolveConfigPath } from "../config.js";
import { readBoardKey, resolveBoardKeyPath } from "../key-store.js";
import { createPaperclipClient } from "../paperclip-api.js";

interface Check { name: string; ok: boolean; detail: string }

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim() }); });
  });
}

function tcpReachable(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let host = "";
    let port = 5432;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = Number(parsed.port || 5432);
    } catch {
      resolve({ ok: false, detail: "invalid URL" });
      return;
    }
    const socket = net.connect({ host, port, timeout: 5000 });
    socket.once("connect", () => { socket.destroy(); resolve({ ok: true, detail: `${host}:${port} reachable` }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ ok: false, detail: `${host}:${port} timed out` }); });
    socket.once("error", (error) => { resolve({ ok: false, detail: `${host}:${port} ${error.message}` }); });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(env: NodeJS.ProcessEnv): Promise<number> {
  const checks: Check[] = [];
  const configPath = resolveConfigPath(env);
  let config;
  try {
    config = await readConfig(configPath);
    checks.push({ name: "config", ok: true, detail: configPath });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return report(checks);
  }

  const client = createPaperclipClient({ apiBase: config.paperclipApiUrl });
  try {
    const health = await client.getHealth();
    checks.push({ name: "paperclip", ok: health.status === "ok", detail: `version ${health.version ?? "?"} mode ${health.deploymentMode ?? "?"} bootstrap ${health.bootstrapStatus ?? "?"}` });
  } catch (error) {
    checks.push({ name: "paperclip", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  const db = await tcpReachable(config.dataDatabaseUrl);
  checks.push({ name: "kyoube database", ok: db.ok, detail: db.detail });

  const key = await readBoardKey(resolveBoardKeyPath(config));
  checks.push({ name: "board key", ok: Boolean(key) || Boolean(env.KYOUBE_BOARD_API_KEY), detail: key ? `stored (user ${key.userId ?? "?"})` : env.KYOUBE_BOARD_API_KEY ? "from environment" : "missing — run kyoube setup" });

  if (key || env.KYOUBE_BOARD_API_KEY) {
    try {
      const authed = createPaperclipClient({ apiBase: config.paperclipApiUrl, apiKey: key?.token ?? env.KYOUBE_BOARD_API_KEY });
      const plugins = await authed.listPlugins();
      const ours = plugins.filter((plugin) => plugin.pluginKey.startsWith("kyoube."));
      const bad = ours.filter((plugin) => plugin.status !== "ready");
      checks.push({ name: "plugins", ok: ours.length > 0 && bad.length === 0, detail: ours.map((plugin) => `${plugin.pluginKey}@${plugin.version}=${plugin.status}`).join(", ") || "none installed" });
    } catch (error) {
      checks.push({ name: "plugins", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const harnessEnv = { ...env, HOME: config.home, HERMES_HOME: config.hermesHome };
  for (const [name, args] of [["claude", ["--version"]], ["pi", ["--version"]], ["hermes", ["--version"]]] as const) {
    const result = await runCommand(name, [...args], harnessEnv);
    checks.push({ name: `${name} cli`, ok: result.ok, detail: result.output.split("\n")[0] ?? "" });
  }

  const credentialHints: Array<[string, string]> = [
    ["claude credentials", path.posix.join(config.home, ".claude", ".credentials.json")],
    ["pi config dir", path.posix.join(config.home, ".pi")],
    ["hermes config", path.posix.join(config.hermesHome, "config.yaml")],
  ];
  for (const [name, filePath] of credentialHints) {
    const present = await fileExists(filePath);
    checks.push({ name, ok: true, detail: present ? `present (${filePath})` : `not found (${filePath}) — authenticate from the Terminal page or set provider API keys` });
  }

  return report(checks);
}

function report(checks: Check[]): number {
  for (const check of checks) {
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(20)} ${check.detail}`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}
```

- [ ] **Step 10: Implement cli.ts**

`docker/bootstrap/src/cli.ts`:
```ts
import { runDoctor } from "./commands/doctor.js";
import { runEnsurePlugins } from "./commands/ensure-plugins.js";
import { runSetup } from "./commands/setup.js";
import { runWriteConfig } from "./commands/write-config.js";

export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | true>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: null, flags: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        result.flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && ["api-key", "api-base"].includes(body)) {
        result.flags[body] = next;
        i += 1;
      } else {
        result.flags[body] = true;
      }
      continue;
    }
    if (result.command === null) result.command = arg;
    else result.positionals.push(arg);
  }
  return result;
}

const USAGE = `kyoube — KyoubeAI bootstrap and diagnostics

Usage: kyoube <command> [flags]

Commands:
  setup                 One-time: log in as instance admin (browser approval), store a board key, install plugins
  ensure-plugins        Install/upgrade Kyoube plugins into Paperclip (flags: --watch, --api-key <key>, --api-base <url>)
  doctor                Check config, databases, plugins, and the claude/pi/hermes CLIs
  write-config          (internal) Render /paperclip/kyoube/config.json from the environment
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.help === true || parsed.command === null) {
    console.log(USAGE);
    return parsed.command === null && parsed.flags.help !== true ? 1 : 0;
  }
  switch (parsed.command) {
    case "setup":
      return runSetup(parsed.flags, env);
    case "ensure-plugins":
      return runEnsurePlugins(parsed.flags, env);
    case "doctor":
      return runDoctor(env);
    case "write-config":
      return runWriteConfig(env);
    default:
      console.log(`Unknown command: ${parsed.command}\n\n${USAGE}`);
      return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined && /kyoube(\.mjs|\.js)?$/.test(process.argv[1]) && !process.env.VITEST;
if (isEntrypoint) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`kyoube: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 11: Run the tests, typecheck, and build**

Run: `pnpm --filter @kyoube/bootstrap test && pnpm --filter @kyoube/bootstrap typecheck && pnpm --filter @kyoube/bootstrap build`
Expected: all tests PASS; typecheck clean; `docker/bootstrap/dist/kyoube.mjs` exists.

Run: `node docker/bootstrap/dist/kyoube.mjs --help`
Expected: prints the usage block; exit code 0.

- [ ] **Step 12: Commit**

```bash
git add docker/bootstrap
git commit -m "feat(bootstrap): kyoube CLI with setup, ensure-plugins, doctor, write-config"
```

---

### Task 6: Terminal plugin skeleton (build pipeline proof)

**Files:**
- Create: `plugins/kyoube-terminal/package.json`, `plugins/kyoube-terminal/tsconfig.json`, `plugins/kyoube-terminal/build.mjs`, `plugins/kyoube-terminal/vitest.config.ts`, `plugins/kyoube-terminal/src/manifest.ts`, `plugins/kyoube-terminal/src/worker.ts`
- Test: `plugins/kyoube-terminal/tests/plugin.spec.ts`

**Interfaces:**
- Produces: a buildable Paperclip plugin whose `dist/manifest.js` default-exports `{ id: "kyoube.terminal", version: "0.1.0", … }` and whose `dist/worker.js` starts via `runWorker`. Phase 1 replaces `capabilities`, adds `ui`, and implements the worker; the package layout and build script stay.
- Upstream contract: `package.json.paperclipPlugin = { manifest, worker[, ui] }`; worker module default-exports `definePlugin({...})` and calls `runWorker(plugin, import.meta.url)`.

- [ ] **Step 1: Create the package files**

`plugins/kyoube-terminal/package.json`:
```json
{
  "name": "@kyoube/plugin-terminal",
  "version": "0.1.0",
  "description": "Admin web terminal inside the KyoubeAI container (Paperclip plugin)",
  "license": "MIT",
  "type": "module",
  "files": ["dist", "package.json", "README.md"],
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "2026.831.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "^0.28.2",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  },
  "engines": {
    "node": ">=24.11.0"
  }
}
```

`plugins/kyoube-terminal/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "lib": ["ES2023", "DOM"],
    "jsx": "react-jsx"
  },
  "include": ["src", "tests"]
}
```

`plugins/kyoube-terminal/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
    environment: "node",
  },
});
```

`plugins/kyoube-terminal/build.mjs`:
```js
import esbuild from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// Worker-side bundles keep every dependency external: the plugin ships its own
// production node_modules (pnpm deploy), and native modules must not be bundled.
await esbuild.build({
  entryPoints: { manifest: "src/manifest.ts", worker: "src/worker.ts" },
  outdir: "dist",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: ["node24"],
  sourcemap: true,
  logLevel: "info",
});
```

- [ ] **Step 2: Write the failing test**

`plugins/kyoube-terminal/tests/plugin.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { PLUGIN_ID, PLUGIN_VERSION } from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("kyoube.terminal skeleton", () => {
  it("declares a valid manifest", () => {
    expect(manifest.id).toBe("kyoube.terminal");
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
  });

  it("sets up and reports healthy", async () => {
    // definePlugin() returns Object.freeze({ definition }); hooks live on `.definition`.
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    expect(harness.logs.some((entry) => entry.message.includes("kyoube.terminal"))).toBe(true);
    const health = await plugin.definition.onHealth?.();
    expect(health).toEqual({ status: "ok", message: "kyoube.terminal ready" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm install && pnpm --filter @kyoube/plugin-terminal test`
Expected: FAIL — `Cannot find module '../src/manifest.js'`

- [ ] **Step 4: Implement manifest.ts and worker.ts**

`plugins/kyoube-terminal/src/manifest.ts`:
```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kyoube.terminal";
export const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Terminal",
  description: "Browser terminal inside the KyoubeAI container for instance administration and agent harness login.",
  author: "KyoubeAI",
  categories: ["workspace", "ui"],
  capabilities: [],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
```

`plugins/kyoube-terminal/src/worker.ts`:
```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./manifest.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} worker started (skeleton)`);
  },
  async onHealth() {
    return { status: "ok", message: `${PLUGIN_ID} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 5: Run the test, typecheck, build**

Run: `pnpm --filter @kyoube/plugin-terminal test && pnpm --filter @kyoube/plugin-terminal typecheck && pnpm --filter @kyoube/plugin-terminal build`
Expected: PASS; `plugins/kyoube-terminal/dist/manifest.js` and `dist/worker.js` exist.

Run: `node -e "import('./plugins/kyoube-terminal/dist/manifest.js').then(m => console.log(m.default.id, m.default.version))"`
Expected: `kyoube.terminal 0.1.0`

- [ ] **Step 6: Commit**

```bash
git add plugins/kyoube-terminal pnpm-lock.yaml
git commit -m "feat(terminal): plugin package skeleton with health-only worker"
```

---

### Task 7: Docker image, entrypoint, Postgres init, compose, env example

**Files:**
- Create: `docker/Dockerfile`, `docker/entrypoint.sh`, `docker/kyoube`, `docker/postgres-init/01-kyoube.sh`, `docker-compose.yml`, `.env.example`

**Interfaces:**
- Consumes: `dist/kyoube.mjs` (Task 5), plugin `dist/` (Task 6).
- Produces: image `kyoubeai` with `kyoube` on PATH, plugins under `/opt/kyoube/plugins/{terminal}`, `claude`/`pi`/`hermes` on PATH; compose stack `app` + `db` with databases `paperclip` and `kyoube`.
- Upstream contract: the base image's `ENTRYPOINT ["/usr/bin/tini","--","docker-entrypoint.sh"]` and `CMD ["node","--import","./server/node_modules/tsx/dist/loader.mjs","server/dist/index.js"]` (WORKDIR `/app`, `HOME=/paperclip`, user `node`, `gosu` present). Setting our own `ENTRYPOINT` resets the inherited `CMD`, so the CMD is restated verbatim.

- [ ] **Step 1: Write the Postgres init script**

`docker/postgres-init/01-kyoube.sh`:
```bash
#!/bin/bash
# Runs once, on first initialisation of the Postgres data volume.
# Creates the KyoubeAI organisation database and its login role.
set -euo pipefail
: "${KYOUBE_DB_PASSWORD:?KYOUBE_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 -v pw="$KYOUBE_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
  -- CREATEROLE is needed because the apps plugin creates one NOLOGIN role per company.
  CREATE ROLE kyoube LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT;
  CREATE DATABASE kyoube OWNER kyoube;
  REVOKE CONNECT ON DATABASE paperclip FROM PUBLIC;
  REVOKE CONNECT ON DATABASE kyoube FROM PUBLIC;
EOSQL
```

- [ ] **Step 2: Write the entrypoint and wrapper**

`docker/entrypoint.sh`:
```sh
#!/bin/sh
# KyoubeAI container entrypoint. Prepares Kyoube state, starts the plugin
# bootstrap watcher, then hands over to Paperclip's own entrypoint unchanged.
set -e

BOOTSTRAP=/opt/kyoube/bootstrap/dist/kyoube.mjs
home_dir="${PAPERCLIP_HOME:-/paperclip}"

mkdir -p "$home_dir/kyoube" "$home_dir/.hermes"
if [ "$(id -u)" -eq 0 ]; then
  chown node:node "$home_dir" "$home_dir/kyoube" "$home_dir/.hermes" 2>/dev/null || true
  run_as_node() { gosu node "$@"; }
else
  run_as_node() { "$@"; }
fi

run_as_node node "$BOOTSTRAP" write-config

if [ "${KYOUBE_BOOTSTRAP_DISABLED:-0}" != "1" ]; then
  run_as_node node "$BOOTSTRAP" ensure-plugins --watch &
fi

exec docker-entrypoint.sh "$@"
```

`docker/kyoube`:
```sh
#!/bin/sh
# `kyoube` wrapper: always runs the bootstrap program as the `node` user so files
# it writes under /paperclip stay readable by Paperclip and the watcher.
if [ "$(id -u)" -eq 0 ] && command -v gosu >/dev/null 2>&1; then
  exec gosu node node /opt/kyoube/bootstrap/dist/kyoube.mjs "$@"
fi
exec node /opt/kyoube/bootstrap/dist/kyoube.mjs "$@"
```

- [ ] **Step 3: Write the Dockerfile**

`docker/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7
ARG PAPERCLIP_VERSION=2026.831.1

# ---------------------------------------------------------------------------
# Stage 1: build the Kyoube bootstrap CLI and plugins with pnpm.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS kyoube-build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY docker/bootstrap/package.json docker/bootstrap/
COPY plugins/kyoube-terminal/package.json plugins/kyoube-terminal/
RUN pnpm install --frozen-lockfile
COPY docker/bootstrap docker/bootstrap
COPY plugins plugins
RUN pnpm -r build \
 && pnpm --filter @kyoube/bootstrap deploy --prod /out/bootstrap \
 && pnpm --filter @kyoube/plugin-terminal deploy --prod /out/plugins/terminal \
 && test -f /out/bootstrap/dist/kyoube.mjs \
 && test -f /out/plugins/terminal/dist/manifest.js

# ---------------------------------------------------------------------------
# Stage 2: the runtime image = upstream Paperclip + pi + Hermes + Kyoube.
# ---------------------------------------------------------------------------
FROM ghcr.io/paperclipai/paperclip:${PAPERCLIP_VERSION}
ARG PI_VERSION=0.85.0
ARG KYOUBE_VERSION=dev
USER root

# pi coding agent (the `pi_local` adapter runs the `pi` binary).
RUN npm install --global --omit=dev "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && pi --version

# Hermes Agent (the `hermes_local` adapter runs `hermes chat`). Installed as
# root in FHS layout: code in /usr/local/lib/hermes-agent, launcher at
# /usr/local/bin/hermes. Runtime data lives under HERMES_HOME on the volume.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh \
 && HERMES_HOME=/opt/hermes-build-home bash /tmp/hermes-install.sh --non-interactive --dir /usr/local/lib/hermes-agent \
 && rm -f /tmp/hermes-install.sh \
 && chmod -R a+rX /usr/local/lib/hermes-agent \
 && test -x /usr/local/bin/hermes \
 && mkdir -p /tmp/hermes-check && chown node:node /tmp/hermes-check \
 && gosu node sh -c 'HOME=/tmp/hermes-check HERMES_HOME=/tmp/hermes-check/.hermes hermes --version' \
 && rm -rf /tmp/hermes-check /opt/hermes-build-home

# Kyoube bootstrap CLI and plugin bundles.
COPY --from=kyoube-build /out/bootstrap /opt/kyoube/bootstrap
COPY --from=kyoube-build /out/plugins /opt/kyoube/plugins
COPY docker/kyoube /usr/local/bin/kyoube
COPY docker/entrypoint.sh /usr/local/bin/kyoube-entrypoint.sh
RUN chmod +x /usr/local/bin/kyoube /usr/local/bin/kyoube-entrypoint.sh \
 && chown -R node:node /opt/kyoube \
 && node /opt/kyoube/bootstrap/dist/kyoube.mjs --help >/dev/null

ENV KYOUBE_VERSION=${KYOUBE_VERSION} \
    KYOUBE_PLUGIN_ROOT=/opt/kyoube/plugins \
    HERMES_HOME=/paperclip/.hermes

ENTRYPOINT ["/usr/bin/tini", "--", "kyoube-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
```

- [ ] **Step 4: Write compose and the env example**

`docker-compose.yml`:
```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: paperclip
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: paperclip
      KYOUBE_DB_PASSWORD: ${KYOUBE_DB_PASSWORD:?set KYOUBE_DB_PASSWORD in .env}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U paperclip -d paperclip"]
      interval: 2s
      timeout: 5s
      retries: 30

  app:
    build:
      context: .
      dockerfile: docker/Dockerfile
      args:
        PAPERCLIP_VERSION: ${PAPERCLIP_VERSION:-2026.831.1}
        KYOUBE_VERSION: ${KYOUBE_VERSION:-dev}
    image: kyoubeai:${KYOUBE_VERSION:-dev}
    # tini is PID 1 inside the image; pids_limit is the backstop against process leaks.
    pids_limit: 2048
    ports:
      - "${KYOUBE_PORT:-3100}:3100"
    environment:
      DATABASE_URL: postgres://paperclip:${POSTGRES_PASSWORD}@db:5432/paperclip
      KYOUBE_DATABASE_URL: postgres://kyoube:${KYOUBE_DB_PASSWORD}@db:5432/kyoube
      PORT: "3100"
      SERVE_UI: "true"
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: ${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}
      PAPERCLIP_PUBLIC_URL: ${PAPERCLIP_PUBLIC_URL:-http://localhost:3100}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET in .env}
      KYOUBE_BOARD_API_KEY: ${KYOUBE_BOARD_API_KEY:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
    volumes:
      - paperclip-home:/paperclip
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
  paperclip-home:
```

`.env.example`:
```
# ---- Required secrets (generate each with: openssl rand -hex 32) ----
BETTER_AUTH_SECRET=
POSTGRES_PASSWORD=
KYOUBE_DB_PASSWORD=

# ---- Reachability ----
# The URL people type into the browser. Must match exactly (scheme, host, port).
PAPERCLIP_PUBLIC_URL=http://localhost:3100
KYOUBE_PORT=3100
# private = LAN/VPN/Tailscale (browser first-admin claim enabled); public = internet-facing (put TLS in front)
PAPERCLIP_DEPLOYMENT_EXPOSURE=private

# ---- Versions ----
PAPERCLIP_VERSION=2026.831.1
KYOUBE_VERSION=dev

# ---- Optional: unattended plugin install (instance-admin board API key) ----
KYOUBE_BOARD_API_KEY=

# ---- Optional: headless provider keys for the agent harnesses ----
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

- [ ] **Step 5: Build the image**

Run: `cp .env.example .env` then fill the three secrets in `.env` (`openssl rand -hex 32` three times), then `docker compose build`
Expected: build succeeds. If the Hermes step fails, capture the installer output: the two knobs to adjust are the `--dir` value and the apt package list; `hermes --version` as the `node` user must succeed before continuing.

- [ ] **Step 6: Start the stack and verify health and CLIs**

Run: `docker compose up -d && sleep 20 && curl -fsS http://localhost:3100/api/health`
Expected: JSON containing `"status":"ok"`, `"deploymentMode":"authenticated"`, `"bootstrapStatus":"bootstrap_pending"`.

Run: `docker compose logs app | grep kyoube:`
Expected: `kyoube: wrote /paperclip/kyoube/config.json …` and `kyoube: no board API key yet …`.

Run: `docker compose exec app sh -c 'claude --version && pi --version && hermes --version && kyoube --help | head -1'`
Expected: three version strings and `kyoube — KyoubeAI bootstrap and diagnostics`.

Run: `docker compose exec db psql -U paperclip -d postgres -c '\l' | grep -E 'paperclip|kyoube'`
Expected: both databases listed, `kyoube` owned by `kyoube`.

- [ ] **Step 7: Commit**

```bash
git add docker/Dockerfile docker/entrypoint.sh docker/kyoube docker/postgres-init docker-compose.yml .env.example
git commit -m "feat(docker): overlay image with pi, Hermes, Kyoube bootstrap, and compose stack"
```

---

### Task 8: End-to-end smoke test script

**Files:**
- Create: `scripts/smoke.sh`, `scripts/smoke.env`

**Interfaces:**
- Consumes: the compose stack (Task 7), the `kyoube` CLI exit codes (Task 5).
- Upstream contract: `POST /api/auth/sign-up/email {name,email,password}` (needs `Origin` header + cookie jar); `POST /api/bootstrap/claim` (session; `authenticated/private` only) → `{claimed:true}`; `POST /api/board-api-keys {name}` → `{token}`; `GET /api/plugins`; `POST /api/companies {name}` → `{id}`; `POST /api/companies/:id/agents {name, adapterType, adapterConfig:{cwd}}`.

- [ ] **Step 1: Write the smoke environment**

`scripts/smoke.env`:
```
BETTER_AUTH_SECRET=smoke-only-secret-please-do-not-reuse-0123456789
POSTGRES_PASSWORD=smoke-postgres
KYOUBE_DB_PASSWORD=smoke-kyoube
PAPERCLIP_PUBLIC_URL=http://localhost:3199
KYOUBE_PORT=3199
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_VERSION=2026.831.1
KYOUBE_VERSION=smoke
```

- [ ] **Step 2: Write the smoke script**

`scripts/smoke.sh`:
```bash
#!/usr/bin/env bash
# End-to-end smoke test: builds the image, starts the stack on port 3199,
# creates the first admin, installs the Kyoube plugins through `kyoube`, and
# creates one agent per harness. Requires docker compose v2, curl, jq.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${SMOKE_PROJECT:-kyoube-smoke}"
ENV_FILE="$ROOT/scripts/smoke.env"
BASE_URL="http://localhost:3199"
KEEP="${KEEP:-0}"
TMP="$(mktemp -d)"
COOKIES="$TMP/cookies.txt"

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/docker-compose.yml" "$@"; }

cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    echo "--- smoke failed (exit $code); last app logs ---" >&2
    compose logs --tail 200 app >&2 || true
  fi
  if [[ "$KEEP" != "1" ]]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

post_json() { # url body -> prints body, stores status in HTTP_STATUS
  local url="$1" body="$2"
  HTTP_STATUS="$(curl -sS -o "$TMP/resp.json" -w '%{http_code}' -c "$COOKIES" -b "$COOKIES" \
    -H 'Content-Type: application/json' -H "Origin: $BASE_URL" -X POST "$url" --data "$body")"
  cat "$TMP/resp.json"
}

echo "==> build + up"
compose up -d --build

echo "==> wait for health"
for i in $(seq 1 180); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 180 ]]; then echo "health never came up" >&2; exit 1; fi
done
curl -fsS "$BASE_URL/api/health" | jq -e '.deploymentMode == "authenticated"' >/dev/null

echo "==> sign up first admin and claim the instance"
post_json "$BASE_URL/api/auth/sign-up/email" '{"name":"Smoke Admin","email":"smoke@kyoube.local","password":"smoke-password-123"}' >/dev/null
[[ "$HTTP_STATUS" =~ ^2 ]] || { echo "sign-up failed: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }
post_json "$BASE_URL/api/bootstrap/claim" '{}' | jq -e '.claimed == true' >/dev/null
curl -fsS "$BASE_URL/api/health" | jq -e '.bootstrapStatus == "ready"' >/dev/null

echo "==> create a board API key"
TOKEN="$(post_json "$BASE_URL/api/board-api-keys" '{"name":"kyoube-smoke"}' | jq -r '.token')"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "no board token" >&2; exit 1; }

echo "==> install plugins via kyoube ensure-plugins"
compose exec -T app kyoube ensure-plugins --api-key "$TOKEN"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" \
  | jq -e 'map(select(.pluginKey == "kyoube.terminal")) | length == 1 and .[0].status == "ready"' >/dev/null

echo "==> create a company and one agent per harness"
COMPANY_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/companies" --data '{"name":"Smoke Co"}' | jq -r '.id')"
[[ -n "$COMPANY_ID" && "$COMPANY_ID" != "null" ]] || { echo "company create failed" >&2; exit 1; }
for ADAPTER in claude_local pi_local hermes_local; do
  STATUS="$(curl -sS -o "$TMP/agent.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$BASE_URL/api/companies/$COMPANY_ID/agents" \
    --data "{\"name\":\"smoke-$ADAPTER\",\"adapterType\":\"$ADAPTER\",\"adapterConfig\":{\"cwd\":\"/paperclip/workspaces/smoke\"}}")"
  [[ "$STATUS" =~ ^2 ]] || { echo "agent create for $ADAPTER failed: $STATUS $(cat "$TMP/agent.json")" >&2; exit 1; }
  echo "    created agent for $ADAPTER"
done

echo "==> kyoube doctor"
compose exec -T -e KYOUBE_BOARD_API_KEY="$TOKEN" app kyoube doctor

echo "==> smoke passed"
```

- [ ] **Step 3: Run the smoke test**

Run: `bash scripts/smoke.sh`
Expected: every `==>` section passes and the script prints `smoke passed`. If `kyoube doctor` fails on the `kyoube database` check, the `KYOUBE_DATABASE_URL` host/port is wrong in compose; if it fails on a CLI check, fix the Dockerfile step for that CLI.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.sh scripts/smoke.env
git commit -m "test: end-to-end docker smoke test"
```

---

### Task 9: README v0 and CI workflow

**Files:**
- Modify: `README.md`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write README v0**

`README.md`:
```markdown
# KyoubeAI

**A multi-user AI operating system for organisations**, built on [Paperclip](https://github.com/paperclipai/paperclip).

KyoubeAI ships Paperclip with a dedicated PostgreSQL server, three agent harnesses pre-installed (Claude Code, pi, Hermes Agent), and Kyoube-specific capabilities delivered as Paperclip plugins:

- **Terminal** — a browser terminal inside the container for admins (authenticate harnesses, run `paperclipai`, inspect the box). *(Phase 1)*
- **Data** — an organisation database that agents with permission can design and populate (tables, fields, records) through tools and an API. *(Phase 2)*
- **Apps** — AI-built, database-backed applications (CRMs, ERPs, trackers) that run inside the Paperclip UI. *(Phase 3)*

Nothing here patches Paperclip: the image is built `FROM` the upstream release, and every Kyoube feature is a plugin. Upgrading Paperclip is a one-line version bump.

## Quickstart

Requirements: Docker Engine 24+ with Compose v2, 4 GB RAM.

```bash
git clone https://github.com/<org>/KyoubeAI.git && cd KyoubeAI
cp .env.example .env
# fill BETTER_AUTH_SECRET, POSTGRES_PASSWORD, KYOUBE_DB_PASSWORD (openssl rand -hex 32)
docker compose up -d --build
```

1. Open http://localhost:3100, sign up, and claim the instance (you become the instance admin).
2. Install the Kyoube plugins (one-time):
   ```bash
   docker compose exec app kyoube setup
   ```
   Approve the login link it prints. From then on plugins install and upgrade automatically at start-up.
3. Check everything: `docker compose exec app kyoube doctor`.
4. Authenticate the agent harnesses: either put provider API keys in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) or, once the Terminal plugin is installed, run `claude login`, `pi`, and `hermes setup` from the Terminal page. Credentials persist on the `paperclip-home` volume.

## Layout

| Path | What it is |
|---|---|
| `docker/Dockerfile` | Overlay image: upstream Paperclip + `pi` + `hermes` + Kyoube |
| `docker/bootstrap/` | The `kyoube` CLI (`setup`, `ensure-plugins`, `doctor`) |
| `plugins/` | Paperclip plugins (`kyoube-terminal`, later `kyoube-apps`) |
| `docker-compose.yml` | `app` + `db` (Postgres 17 with databases `paperclip` and `kyoube`) |
| `scripts/smoke.sh` | End-to-end smoke test used by CI |
| `docs/superpowers/` | Design spec and implementation plans |

## Updating

- **Paperclip:** change `PAPERCLIP_VERSION` in `.env` (and the `@paperclipai/plugin-sdk` version in `plugins/*/package.json` to the same value), then `docker compose up -d --build`.
- **KyoubeAI:** `git pull && docker compose up -d --build`. Plugins are upgraded automatically when their version changes.

## Development

```bash
corepack enable && pnpm install
pnpm test        # unit tests for the bootstrap CLI and plugins
pnpm build       # builds dist/ for every package
pnpm smoke       # full docker smoke test (needs docker, curl, jq)
```

## License

MIT. Paperclip is © Paperclip AI, MIT-licensed, and consumed unmodified as a published image.
```

- [ ] **Step 2: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build

  docker-smoke:
    runs-on: ubuntu-latest
    needs: unit
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v4
      - name: Smoke test the compose stack
        run: bash scripts/smoke.sh
```

- [ ] **Step 3: Verify locally and commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all green.

```bash
git add README.md .github/workflows/ci.yml
git commit -m "docs: README v0 and CI workflow"
```

---

## Phase 0 exit checklist

- [ ] `docker compose up -d --build` from a fresh clone reaches `/api/health` with `deploymentMode: authenticated`.
- [ ] Sign-up + claim works in the browser; `kyoube setup` installs `kyoube.terminal` and it shows `ready` under Settings → Plugins.
- [ ] `docker compose exec app kyoube doctor` passes; `claude`, `pi`, `hermes` print versions.
- [ ] `bash scripts/smoke.sh` passes locally and in CI.
- [ ] `git status` is clean and the tree contains no `.env`, data, or build output.
