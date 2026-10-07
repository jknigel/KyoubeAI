# KyoubeAI on your phone

KyoubeAI installs as an app on phones and computers (a PWA) and sends push notifications. There is
no store app and no KyoubeAI server in between. Each instance sends Web Push itself, to the push
service of the person's browser (Apple, Google, Mozilla or Microsoft), with the payload encrypted. Those
services see that a notification was sent to a device, never what it says.

The pieces:

- **`plugins/kyoube-notify/`** (`kyoube.notify`) — an ordinary plugin on the public SDK. It listens
  for core events, decides who to tell, encrypts and sends the push, and draws the Home card and the
  Notifications page.
- **`docker/pwa/`** — a build-time step, like the rebrand. It makes the app installable in standalone
  mode and loads the push handlers (`kyoube-push-sw.js`) from the core's own service worker.

## Installing

- **iPhone and iPad** (iOS or iPadOS 16.4 or later). Open KyoubeAI in Safari, tap Share, then **Add to
  Home Screen**, then open KyoubeAI from the Home Screen icon. iOS sends notifications only to an app
  opened that way.
- **Android.** In Chrome, open the menu and choose **Install app** (or **Add to Home screen**).
- **Desktop.** Click the install icon in the address bar of Chrome or Edge. In Safari, use File, then
  **Add to Dock**.

## Turning notifications on

- **The Home card.** Until this device is on, Home shows "Get notified on this device" with **Turn on**
  and **Not now** (dismissed per device). Once it is on, the card shrinks to one line with a link to
  Settings.
- **The Notifications page** (`/<prefix>/notifications`, linked from the Home card and the Workspace
  page). It shows this device's status with **Turn on** or **Turn off**, **Send a test**, two opt-in
  switches (failed runs, comments), and your other devices, each with its last delivery or last error
  and a **Remove** button.

Tap **Turn on** yourself: iOS only shows the permission prompt after a tap. A person in two
companies gets both on the same device.

## What you are told

| Event | Who is told | Default |
|---|---|---|
| An agent asks a question | the person it is addressed to; if no one, the task's creator, or the assignee if the creator has left | on |
| An approval is waiting | every active member except viewers | on |
| A task moves to done or blocked | the task's creator and assignee | on |
| An agent's run fails | owners and admins who turned it on; at most one per agent every 30 minutes | opt-in |
| An agent or person comments on a task | the task's creator and assignee who turned it on | opt-in |

Nobody is told about their own action, and only active members are told. A notification carries an
agent name, a task identifier and title, or an approval type and name. It never carries comment text,
question bodies or app data, because a lock screen can be seen by others. A question shows the
question's title (or a fixed label such as "a confirmation"), never its summary.

**A question arrives when the agent's run ends, usually within seconds.** The core sends plugins no
event for a new question: it logs one as `issue.thread_interaction_created`, which it does not pass on.
So when a run finishes or fails, or a comment lands, the plugin lists that task's interactions and
notifies each open question it has not told anyone about yet.

## Why it needs `https://`

Browsers allow push only from a secure origin (`https://`, or `localhost` on the same machine). Set
`KYOUBE_PUBLIC_URL` in `.env` to the `https://` address people use. Ways to get one:

- **cloudflared**, a tunnel with its own certificate (the live instances use it).
- **Tailscale.** `tailscale serve` gives the machine an `https://<machine>.<tailnet>.ts.net` address
  that works on every device on the tailnet.
- **A reverse proxy** (Caddy, Traefik, nginx) with a certificate.

`docs/operations.md` covers putting a proxy or tunnel in front. Over `http://` the Home card says push
needs `https://` and sends no prompt.

## Troubleshooting

The Home card and the Notifications page show one of these states for the device:

| State | Meaning |
|---|---|
| On | This device is subscribed. |
| Off | This device is not registered: permission not asked yet, or granted but the device was removed or the push service dropped it. Tap **Turn on**. |
| Add to Home Screen | iPhone or iPad, opened in Safari. Add KyoubeAI to the Home Screen and open it from there. |
| Needs a secure address | The page is open over `http://`. See above. |
| Blocked | The browser or phone is blocking notifications for this site. Allow them in the browser's or the phone's settings, then come back. The card never asks again on its own. |
| Unsupported | This browser cannot receive push. The Home card hides itself; the Notifications page says so. Use another browser. |

- **"Last attempt failed: push service refused the request (403)".** The push service no longer
  accepts this instance's keys. This happens after restoring a backup from another instance, or any
  restore that lost the instance's keys. Turn the device off and on again on the Notifications page.
- **A device whose subscription the push service reports gone (404 or 410)** is removed
  automatically. Turn it on again.
- **Nothing arrives on an iPhone.** Check that KyoubeAI was opened from the Home Screen icon, not
  from Safari, and that a Focus mode is not hiding notifications.
- **A device stops receiving.** The push service may have rotated its subscription. Open KyoubeAI on
  that device and turn notifications on again.
- **Shared computers.** Notifications follow the browser's subscription to the last person who turned
  them on. On a shared computer, press **Turn off** before you sign out, so the next person's
  notifications do not go to the wrong screen (and yours stop).
- **Send a test** on the Notifications page shows at once whether the chain works for a device.

## How it survives core updates

| Layer | Relies on | Guarded by |
|---|---|---|
| Installable app (`docker/pwa/pwa.mjs`, after the rebrand) | `ui/dist/sw.js` with one `fetch` listener and no `push` listener; `site.webmanifest` parsing as a JSON object; `<meta name="apple-mobile-web-app-title"` once in `index.html` | every check runs before anything is written, and a mismatch stops the image build (messages below) |
| Core still registers its worker | `register("/sw.js")` in the bundle | a warning only: **Turn on** (Home card and Notifications page) registers `/sw.js` itself |
| The plugin | the published plugin SDK only | the SDK pin (`scripts/check-pins.sh`), the plugin's tests, and a test that every name in `SUBSCRIBED_EVENTS` is in the pinned SDK's `PLUGIN_EVENT_TYPES`, so a renamed event fails CI at a bump |
| Phone toast cap | the toast viewport anchors in `docker/theme` (`toast-viewport`, `toast-list`) | the theme step and its gate test; see `docs/theme.md` |
| Smoke test | the served manifest is standalone, `/sw.js` imports the push handlers, `/kyoube-push-sw.js` is served as JavaScript, `kyoube.notify` is installed; and a real push is sent, decrypted and its VAPID signature, audience and expiry checked (`scripts/push-live-check.mjs`) | `scripts/smoke.sh` |
| Weekly upstream run | the same smoke against `paperclip:beta` | `.github/workflows/upstream-beta.yml` |

What the `pwa` step's messages mean at a bump is in `docs/upgrading.md`, "When the pwa step fails at
a core bump".

**If a later SDK declares `interaction.created`** as a plugin event, add it to `SUBSCRIBED_EVENTS` in
`plugins/kyoube-notify/src/manifest.ts` and add a case in `Notifier.handle`
(`plugins/kyoube-notify/src/notifier.ts`) that calls `checkQuestions`. Questions then arrive the
moment they are asked instead of when the run ends.

## Real-device checklist

Manual, before a release that touches this. On an iPhone, from the Home Screen icon, and on an Android
phone in Chrome, against an `https://` instance:

1. Turn on from the Home card.
2. **Send a test** on the Notifications page; it arrives.
3. An agent asks a question; the notification arrives after the agent's run ends.
4. An approval is created; the notification arrives.
5. Tapping each notification opens the right page (the task, the approval).
6. **Turn off** stops them.
