#!/usr/bin/env node
// Creates a licence signing key pair. The private half goes to
// ~/.kyoube-license/keys/<kid>.pem (mode 600): the folder KyoubeAI-Admin's
// key store reads, never a repository. The public half is printed as the entry
// to add to packages/license/src/trusted-keys.ts.
// Usage: pnpm --filter @kyoube/license keygen <kid>      e.g. 2026a
import { generateKeyPairSync } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const kid = process.argv.slice(2).find((arg) => arg !== "--");
if (!kid || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(kid)) {
  console.error("keygen: usage: keygen <kid>   (lowercase letters, digits and dashes, e.g. 2026a)");
  process.exit(1);
}
const dir = path.join(process.env.KYOUBE_LICENSE_HOME ?? path.join(homedir(), ".kyoube-license"), "keys");
const file = path.join(dir, `${kid}.pem`);
const exists = await access(file).then(() => true, () => false);
if (exists) {
  console.error(`keygen: ${file} already exists; choose a new kid`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
await mkdir(dir, { recursive: true, mode: 0o700 });
await writeFile(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
console.log(`Private key written to ${file}. Back it up to your password manager now: it is the only copy.\n`);
console.log("Add this entry to TRUSTED_KEYS in packages/license/src/trusted-keys.ts:\n");
console.log(`  ${JSON.stringify(kid)}: ${JSON.stringify(publicPem)},`);
