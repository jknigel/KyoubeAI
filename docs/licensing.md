# Licensing

KyoubeAI is free for up to **5 users** on an instance. A user is a person with a sign-in account;
AI agents never count. Above 5 you need a licence from KyoubeAI (see `LICENSE` and
kyoubeai.com/pricing), delivered as a licence key.

## What happens at the limit

When an instance has as many users as it's allowed, the next new account is refused. That covers
sign-up, an invited person creating an account, and every other way in. The person signing up sees:

> This KyoubeAI instance has reached its user limit (5 of 5). An instance admin can add a licence
> key under Settings → Plugins → KyoubeAI Licence.

Everyone who already has an account keeps working. The limit never locks anyone out.

## Applying a licence key

A key looks like `KYB1.` followed by two long blocks of letters and digits. An instance admin can
apply it in either of two ways:

- **In the app:** open **Settings → Plugins → KyoubeAI Licence**, paste the key, and press
  **Apply**.
- **From the Terminal page:** `kyoube license set <key>`.

The key is checked before it's saved, and a key that isn't valid is never saved. The page then
shows "Licensed to <customer>: <n> of <limit> users", and the expiry date or "perpetual".

Keys are checked entirely on your instance. Nothing is sent to KyoubeAI, and no internet connection
is needed.

To replace a key, apply the new one. To remove it, use **Remove licence** or
`kyoube license clear`; the free limit of 5 then applies again.

## Keys for one instance

Most keys work on any of your instances. A key can also be issued for a single instance. For that,
send KyoubeAI the **Instance ID** shown on the Licence page (or by `kyoube license show`).

The ID is kept in `/kyoubeai/kyoube/instance-id` on the home volume, so restoring a backup keeps it.
A fresh install gets a new ID and needs a new key.

## Expiry

Keys normally last a year from the day they're issued; some are perpetual.

In the last 30 days before expiry, instance admins see a reminder chip in the top bar and a warning
on the Licence page, and `kyoube doctor` shows a `WARN` line. When the key expires, the free limit
of 5 applies again. Nobody is locked out or deleted, but no new user can be added while the
instance has 5 or more. Apply the renewed key to lift the limit again.

## Removing a user to free a seat

The core has no way to delete an account, so KyoubeAI adds one. In the Terminal page:

```
kyoube users list
kyoube users remove person@example.com
```

Removing a user:

- takes them out of every company and deletes their account, sessions, sign-in and API keys;
- keeps comments they wrote, with no author shown.

You can't remove the last instance admin, or the admin whose board API key `kyoube setup` stored.
To remove that admin, run `kyoube setup` signed in as another instance admin first.

If `KYOUBE_BOARD_API_KEY` is set in the environment, `kyoube` can't tell whose key it is, so it
refuses to remove any instance admin until you unset the variable. Other users can still be removed.

If a removal stops halfway, for example after the memberships are archived but before the account is
deleted, `kyoube` says so and asks you to run the same command again to finish.

The Licence page lists everyone counted, and each person's **Remove** shows the exact command.

## The user list on the Licence page

The page reads a list of users that the container refreshes every minute
(`/kyoubeai/kyoube/license-users.json`), and shows when it was read. `kyoube license refresh`
refreshes it at once. The limit itself is always checked live, when an account is created.

## One known gap

If two people create accounts at exactly the same moment with one seat left, both can get in,
leaving the instance one over its limit. The next sign-up is refused as usual, and the Licence page
and `kyoube doctor` show the overage.

## For maintainers

- **How the limit is enforced:** a standing core patch (`docker/core-patches/patches.mjs`,
  `license-seat-limit-*`) adds one Better Auth `user.create.before` hook, which calls
  `/opt/kyoube/license/enforce.mjs` (`packages/license`).
- **If the check is broken:** when the check can't run, sign-ups are refused (`LICENSE_CHECK_FAILED`)
  and `kyoube doctor` FAILs its `licence enforcement` line.
- **Core updates:**
  - The build fails if the patch no longer matches.
  - `scripts/smoke.sh` proves the limit on every PR, after every core bump (`scripts/bump-core.sh`),
    and weekly against the core's `:beta`.
  - Its licensed check needs the `KYOUBE_SMOKE_LICENSE` repository secret.
- **Two paths the hook doesn't cover:** the hook sees every account created through Better Auth. The
  core also inserts into its `user` table directly in two places:
  - The `local-board` principal of a `local_trusted` deployment (`server/dist/index.js`). It is
    unreachable, because KyoubeAI forces `PAPERCLIP_DEPLOYMENT_MODE=authenticated`.
  - The cloud-tenant header sync (`resolveCloudTenantActor` in `server/dist/middleware/auth.js`). It
    is gated by `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN`, which `docker/entrypoint.sh` clears before
    the core starts.

  When you bump the core, re-check both.
- **Signing keys:**
  - `pnpm --filter @kyoube/license keygen <kid>` creates one and prints the entry for
    `packages/license/src/trusted-keys.ts`.
  - `pnpm --silent --filter @kyoube/license sign --kid <kid> --customer "<name>" --seats <n>` issues a key. Keep `--silent`: without it pnpm writes its banner and engine warnings
    to stdout, and the output (often redirected to a file or a secret) must be the single `KYB1.` line.
  - The private key lives in `~/.kyoube-license/keys/`. It must never enter a repository, and it
    must be backed up.
