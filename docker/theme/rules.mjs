/**
 * Display-text changes the KyoubeAI theme makes to the core's compiled UI.
 *
 * Like docker/core-patches, every rule anchors on string literals and code
 * shape, never on minifier-chosen identifier names (`[\w$]+` stands in for
 * those), and must match exactly `expect` times across the files it names.
 * A core release that moves or rewords one of these strings therefore stops
 * the build here with the rule's id instead of shipping a half-renamed UI.
 * The fix is to look at the new code and update the pattern, never to relax
 * `expect`.
 *
 * Unlike core-patches these are permanent: they are product decisions (what
 * a page is called), not bug fixes waiting for upstream. They change text
 * and one theme default only; no behaviour.
 *
 * Rules run in order, so a later rule sees the output of an earlier one.
 */

const BUNDLE = ["ui/dist/assets/*.js"];

export const TEXT_RULES = [
  // ── "Dashboard" is called Home ───────────────────────────────────────────
  // The mobile bottom bar already says Home; the desktop sidebar, the page's
  // breadcrumb and the links back to it now agree. (The agent page's default
  // view has been called Overview upstream since core 2026.916.)
  {
    id: "home-sidebar-label",
    files: BUNDLE,
    pattern: /to:"\/dashboard",label:"Dashboard"/g,
    replacement: 'to:"/dashboard",label:"Home"',
    // The streamlined sidebar (the default) and the legacy one an instance
    // can still opt back into both ship in the bundle.
    expect: 2,
  },
  {
    id: "home-breadcrumb",
    files: BUNDLE,
    pattern: /\[\{label:"Dashboard"\}\]/g,
    replacement: '[{label:"Home"}]',
    expect: 1,
  },
  {
    id: "home-live-runs-breadcrumb",
    files: BUNDLE,
    pattern: /\{label:"Dashboard",href:"\/dashboard"\}/g,
    replacement: '{label:"Home",href:"/dashboard"}',
    expect: 1,
  },
  {
    id: "home-live-runs-backlink",
    files: BUNDLE,
    pattern: /(to:"\/dashboard",className:"[^"]*",children:\[\(0,[\w$]+\.jsx\)\([\w$]+,\{className:"h-3\.5 w-3\.5"\}\),)"Dashboard"\]/g,
    replacement: '$1"Home"]',
    expect: 1,
  },
  {
    id: "home-command-palette",
    files: BUNDLE,
    pattern: /(\("\/dashboard"\),children:\[\(0,[\w$]+\.jsx\)\([\w$]+,\{className:"mr-2 h-4 w-4"\}\),)"Dashboard"\]/g,
    replacement: '$1"Home"]',
    expect: 1,
  },

  // ── The core's integrations area is Connectors everywhere ──────────────
  // Upstream renamed its "Apps" area to Connectors (sidebar, page title and
  // most breadcrumbs) in 2026.916, which already keeps "Apps" free for
  // KyoubeAI's own Apps. Three access-profile pages still say "Apps" in their
  // breadcrumb; they say Connectors here too.
  {
    id: "connectors-breadcrumbs",
    files: BUNDLE,
    pattern: /\{label:"Apps",href:"\/apps"\}/g,
    replacement: '{label:"Connectors",href:"/apps"}',
    expect: 3,
  },

  // ── A plugin page is titled by its page ──────────────────────────────────
  // The host titles every plugin page "Plugins › <plugin name>" (so the
  // Data page read "Plugins › Kyoube Data & Apps"). KyoubeAI's plugin pages
  // are first-class destinations, so the breadcrumb shows the page slot's own
  // name ("Data", "Workspace"), falling back to the plugin's.
  {
    id: "plugin-page-title",
    files: BUNDLE,
    pattern: /([\w$]+)\(\[\{label:"Plugins",href:"\/company\/settings\/instance\/plugins"\},\{label:([\w$]+)\.pluginDisplayName\}\]\)/g,
    replacement: "$1([{label:$2.displayName??$2.pluginDisplayName}])",
    expect: 1,
  },

  // ── Dark is the default theme ─────────────────────────────────────────────
  // index.html's boot script picks the theme before React mounts, and the
  // core's ThemeProvider starts from whatever it picked. With no stored
  // choice it used the OS preference; KyoubeAI opens dark. A choice made with
  // the theme toggle is stored and still wins.
  {
    id: "dark-by-default",
    files: ["ui/dist/index.html"],
    pattern: /const fallback = prefersDark \? "dark" : "light";/g,
    replacement: 'const fallback = "dark";',
    expect: 1,
  },
];
