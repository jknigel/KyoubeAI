#!/usr/bin/env node
// Issues a licence key from the command line with a private key keygen made.
// KyoubeAI-Admin does the same from its web page; this exists so the smoke
// test's key and the first keys don't wait for it. The key is the only line on
// stdout; a one-line summary goes to stderr.
// Usage: pnpm --filter @kyoube/license sign --kid 2026a --customer "Acme Ltd" --seats 10
//          [--expires YYYY-MM-DD | --perpetual] [--instance <instance ID>]
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isIsoDate, oneYearFrom, signLicense } from "../dist/index.js";

function fail(message) {
  console.error(`sign: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    kid: { type: "string" },
    customer: { type: "string" },
    seats: { type: "string" },
    expires: { type: "string" },
    perpetual: { type: "boolean" },
    instance: { type: "string" },
  },
});
if (!values.kid) fail("--kid is required");
const customer = values.customer?.trim();
if (!customer) fail("--customer is required");
const seats = Number(values.seats);
if (!Number.isInteger(seats) || seats < 1) fail("--seats must be a whole number of at least 1");
if (values.expires && values.perpetual) fail("use --expires or --perpetual, not both");
if (values.expires && !isIsoDate(values.expires)) fail("--expires must be a date written YYYY-MM-DD");

const today = new Date().toISOString().slice(0, 10);
const payload = {
  v: 1,
  kid: values.kid,
  id: `lic_${randomBytes(9).toString("base64url")}`,
  customer,
  seats,
  issuedAt: today,
  expiresAt: values.perpetual ? null : (values.expires ?? oneYearFrom(today)),
  instanceId: values.instance?.trim() || null,
};
const keys = path.join(process.env.KYOUBE_LICENSE_HOME ?? path.join(homedir(), ".kyoube-license"), "keys");
const pem = await readFile(path.join(keys, `${values.kid}.pem`), "utf8").catch(() => null);
if (pem === null) fail(`no private key for kid ${values.kid} in ${keys} (run keygen first)`);
let key;
try {
  key = signLicense(payload, pem);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
console.error(`Licence ${payload.id}: ${customer}, ${seats} users, ${payload.expiresAt ? `expires ${payload.expiresAt}` : "perpetual"}${payload.instanceId ? `, instance ${payload.instanceId}` : ", any instance"}`);
console.log(key);
