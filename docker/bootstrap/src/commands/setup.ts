import { readConfig, resolveConfigPath, type KyoubeConfig } from "../config.js";
import { resolveBoardKeyPath, writeBoardKey, type BoardKeyRecord } from "../key-store.js";
import { createCoreClient, type CoreClient, type CoreClientOptions } from "../core-api.js";
import { describeMissing, waitForKyoubeSkills } from "../skills.js";
import { runEnsurePlugins } from "./ensure-plugins.js";

/**
 * Runtime dependencies for {@link runSetup}, injectable so tests can drive the
 * approval state machine without touching disk or the network. Mirrors
 * {@link RunEnsurePluginsDeps}: every field defaults to the real
 * implementation, so `cli.ts` keeps using the two-argument form.
 */
export interface RunSetupDeps {
  readConfig: (filePath: string) => Promise<KyoubeConfig>;
  createClient: (opts: CoreClientOptions) => CoreClient;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  writeKey: (filePath: string, record: BoardKeyRecord) => Promise<void>;
  runEnsurePlugins: (flags: Record<string, string | true>, env: NodeJS.ProcessEnv) => Promise<number>;
}

const defaultRunSetupDeps: RunSetupDeps = {
  readConfig,
  createClient: createCoreClient,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log: (line: string) => console.log(line),
  writeKey: writeBoardKey,
  runEnsurePlugins,
};

/**
 * One-time interactive bootstrap: obtains an instance-admin board API key via
 * the core's CLI auth challenge (approved in the browser), stores it, and
 * installs the Kyoube plugins.
 */
export async function runSetup(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  deps: Partial<RunSetupDeps> = {},
): Promise<number> {
  const { readConfig: loadConfig, createClient, sleep, log, writeKey, runEnsurePlugins: ensure } = {
    ...defaultRunSetupDeps,
    ...deps,
  };
  const config = await loadConfig(resolveConfigPath(env));
  const apiBase = typeof flags["api-base"] === "string" ? flags["api-base"] : config.paperclipApiUrl;
  const client = createClient({ apiBase });
  const health = await client.waitForHealth({ timeoutMs: 60_000, intervalMs: 1000 });
  if (health.bootstrapStatus === "bootstrap_pending") {
    log(
      `kyoube: no instance admin exists yet. Open ${config.publicUrl}, sign up, and claim the instance, then re-run kyoube setup.`,
    );
    return 1;
  }

  const challenge = await client.createCliAuthChallenge({ command: "kyoube setup", clientName: "kyoube" });
  const approvalUrl = `${config.publicUrl}${challenge.approvalPath}`;
  log("kyoube: approve this CLI login as an instance admin in your browser:");
  log(`  ${approvalUrl}`);
  log(`  (expires ${challenge.expiresAt})`);

  const deadline = Date.parse(challenge.expiresAt);
  while (Number.isNaN(deadline) || Date.now() < deadline) {
    const status = await client.getCliAuthChallengeStatus(challenge.pollPath, challenge.token);
    if (status === "approved") {
      // The token is already live at this point: upstream created the board API
      // key inside the approve transaction. Persist it even if the follow-up
      // whoAmI call fails, or the key is orphaned — issued, unusable by us, and
      // only revocable from the UI.
      let userId: string | null = null;
      try {
        userId = (await client.whoAmI(challenge.boardApiToken)).userId;
      } catch (error) {
        log(
          `kyoube: warning: could not read the approving user (${error instanceof Error ? error.message : String(error)}); ` +
            "storing the board API key without a user id",
        );
      }
      const keyPath = resolveBoardKeyPath(config);
      await writeKey(keyPath, { token: challenge.boardApiToken, userId, createdAt: new Date().toISOString() });
      log(`kyoube: stored board API key at ${keyPath}`);
      const ensureCode = await ensure({ "api-base": apiBase }, env);
      if (ensureCode !== 0) return ensureCode;
      return reportKyoubeSkills(createClient({ apiBase, apiKey: challenge.boardApiToken }), sleep, log);
    }
    if (status === "cancelled") {
      log("kyoube: the login was cancelled in the browser");
      return 1;
    }
    if (status === "expired") break;
    await sleep(Math.max(500, challenge.suggestedPollIntervalMs));
  }
  log("kyoube: the login request expired before it was approved; run kyoube setup again");
  return 1;
}

/**
 * The `kyoube.apps` worker imports the Kyoube Data and Kyoube Apps skills into
 * every company's skill library as it activates (and again whenever a company
 * is created). Setup confirms that landed everywhere before declaring success,
 * since an agent can only be given a skill its company's library holds.
 */
async function reportKyoubeSkills(
  client: CoreClient,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
): Promise<number> {
  const status = await waitForKyoubeSkills(client, { sleep });
  if (status.companies.length === 0) {
    log("kyoube: no company exists yet; the Kyoube skills are installed automatically when a company is created");
    return 0;
  }
  if (status.missing.length === 0) {
    log(`kyoube: Kyoube skills installed in ${status.companies.length}/${status.companies.length} companies`);
    return 0;
  }
  log(
    `kyoube: the Kyoube skills are missing in ${describeMissing(status.missing)}; ` +
      'open Company Settings → Data access there and click "Install the Kyoube Data skill", or check the kyoube.apps worker log',
  );
  return 1;
}
