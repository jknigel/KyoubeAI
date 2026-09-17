import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { API_ROUTES } from "./api-routes.js";
import { APP_API_ROUTES } from "./apps/api-routes.js";
import { APPS_PAGE_ROUTE } from "./apps/page-route.js";
import { appToolDeclarations } from "./apps/tools.js";
import appsSkillMarkdown from "./skills/kyoube-apps.md";
import skillMarkdown from "./skills/kyoube-data.md";
import { toolDeclarations } from "./tools.js";

export const PLUGIN_ID = "kyoube.apps";
export const PLUGIN_VERSION = "0.4.2";
export const DATA_PAGE_ROUTE = "data";
export const DATA_ACCESS_SETTINGS_ROUTE = "data-access";
export { APPS_PAGE_ROUTE };
export const DATA_SKILL_KEY = "kyoube-data";
export const APPS_SKILL_KEY = "kyoube-apps";
export const PURGE_JOB_KEY = "purge-trash";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Data & Apps",
  description: "Per-company organisation database that agents and people can design and populate, plus AI-built apps on top of it.",
  author: "KyoubeAI",
  categories: ["workspace", "automation", "ui"],
  capabilities: [
    "agent.tools.register",
    "api.routes.register",
    "access.members.read",
    "agents.read",
    "activity.log.write",
    "skills.managed",
    // The worker installs the two managed skills into a company whenever it is
    // first touched inside a company-scoped invocation — the board-only
    // `skills.install` route that `kyoube ensure-plugins` calls for every
    // company, the `data.access` read behind the sidebar, the Data-access
    // page's button — and, through this capability, on `company.created`
    // (see `installSkills` in plugin.ts). It never enumerates companies
    // itself: a host call made outside an invocation has no company scope and
    // the host refuses `skills.managed.reconcile` without one.
    "events.subscribe",
    "jobs.schedule",
    "ui.page.register",
    "ui.sidebar.register",
    // Required by the `companySettingsPage` slot below: upstream's
    // UI_SLOT_CAPABILITIES (server/src/services/plugin-capability-validator.ts)
    // maps both `settingsPage` and `companySettingsPage` to
    // `instance.settings.register`, and POST /api/plugins/install rejects the
    // whole manifest with "inconsistent capabilities" when it is absent.
    "instance.settings.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  tools: [...toolDeclarations(), ...appToolDeclarations()],
  apiRoutes: [...API_ROUTES, ...APP_API_ROUTES],
  jobs: [{ jobKey: PURGE_JOB_KEY, displayName: "Purge trashed tables and fields", description: "Drops tables/fields soft-deleted more than 30 days ago.", schedule: "0 3 * * *" }],
  skills: [
    { skillKey: DATA_SKILL_KEY, displayName: "Kyoube Data", slug: "kyoube-data", description: "Design and use the company's Kyoube organisation database through the kyoube.apps tools.", markdown: skillMarkdown },
    { skillKey: APPS_SKILL_KEY, displayName: "Kyoube Apps", slug: "kyoube-apps", description: "Build and publish single-file apps over the company's Kyoube Data tables.", markdown: appsSkillMarkdown },
  ],
  ui: {
    slots: [
      { type: "page", id: "data-page", displayName: "Data", exportName: "DataPage", routePath: DATA_PAGE_ROUTE },
      { type: "sidebar", id: "data-nav", displayName: "Data", exportName: "SidebarEntry" },
      { type: "companySettingsPage", id: "data-access", displayName: "Data access", exportName: "DataAccessSettingsPage", routePath: DATA_ACCESS_SETTINGS_ROUTE },
      { type: "page", id: "apps-page", displayName: "Apps", exportName: "AppsPage", routePath: APPS_PAGE_ROUTE },
      { type: "sidebar", id: "apps-nav", displayName: "Apps", exportName: "AppsSidebarEntry" },
    ],
  },
};

export default manifest;
