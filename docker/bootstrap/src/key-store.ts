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

/**
 * Read the stored board API key, or `null` when there isn't a usable one.
 *
 * A truncated or hand-edited `board-key.json` is treated as *missing* (with a
 * warning) rather than fatal: `ensure-plugins --watch` re-reads this file every
 * 60 s for the life of the container, so throwing here would turn one corrupt
 * file into an endless crash loop instead of the "run kyoube setup" path that
 * actually fixes it.
 */
export async function readBoardKey(
  filePath: string,
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<BoardKeyRecord | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: Partial<BoardKeyRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<BoardKeyRecord>;
  } catch (error) {
    warn(
      `kyoube: ignoring malformed ${filePath} (${error instanceof Error ? error.message : String(error)}); ` +
        "treating it as no stored key — re-run kyoube setup",
    );
    return null;
  }
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
