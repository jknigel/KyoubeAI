import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kyoube.notify";
export const PLUGIN_VERSION = "0.1.0";
/** The Notifications page: `/<prefix>/notifications` (not a reserved company route segment). */
export const NOTIFICATIONS_ROUTE = "notifications";

/**
 * Every event the worker listens to. Core 2026.916.1 never sends
 * `interaction.created` (an agent's question is logged as
 * `issue.thread_interaction_created`, which its activity log does not map to a
 * plugin event), so new questions are found when the agent's run ends or a
 * comment lands. It will be subscribed once the core sends it, for instant delivery.
 */
export const SUBSCRIBED_EVENTS = [
  "approval.created",
  "issue.updated",
  "issue.comment.created",
  "agent.run.finished",
  "agent.run.failed",
] as const;

// `minimumHostVersion` is deliberately absent, for the reason recorded in the
// terminal plugin's manifest: core 2026.831.1 (still in 2026.916.1) compares it against a host version
// it never sets, so any minimum would reject the install.
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Notifications",
  description: "Push notifications on phones and desktops: when an agent asks you something, when an approval is waiting, and when your task is done or blocked. Sent by this instance straight to the browser's push service; nothing goes through KyoubeAI.",
  author: "KyoubeAI",
  categories: ["ui"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issue.interactions.read",
    "approvals.read",
    "agents.read",
    "companies.read",
    "access.members.read",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      // order -1: above Studio Home (order 0), so the prompt is the first thing on a phone.
      { type: "dashboardWidget", id: "notify-card", displayName: "Notifications", exportName: "NotifyCard", order: -1 },
      { type: "page", id: "notify-page", displayName: "Notifications", exportName: "NotificationsPage", routePath: NOTIFICATIONS_ROUTE },
    ],
  },
};

export default manifest;
