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
  // breadcrumb and the links back to it now agree. The agent page's own
  // "Dashboard" tab is a different thing and is left alone.
  {
    id: "home-sidebar-label",
    files: BUNDLE,
    pattern: /to:"\/dashboard",label:"Dashboard"/g,
    replacement: 'to:"/dashboard",label:"Home"',
    expect: 1,
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

  // ── An agent's default view is its Overview ──────────────────────────────
  // The Studio plugin shows an agent's profile (Concept C) at /team/<agent>
  // and sends the core agent page's default "dashboard" view there, so that
  // tab and its breadcrumb are called Overview. The route value stays.
  {
    id: "agent-overview-tab",
    files: BUNDLE,
    pattern: /\{value:"dashboard",label:"Dashboard"\}/g,
    replacement: '{value:"dashboard",label:"Overview"}',
    expect: 1,
  },
  {
    id: "agent-overview-breadcrumb",
    files: BUNDLE,
    pattern: /([\w$]+)\.push\(\{label:"Dashboard"\}\)/g,
    replacement: '$1.push({label:"Overview"})',
    expect: 1,
  },

  // ── The core's "Apps" area is called Connections ─────────────────────────
  // KyoubeAI's own Apps (AI-built apps over company data) keep the name. The
  // core's area connects outside tools, so it becomes Connections, and its
  // existing "Connections" sub-page becomes "Connected apps" so a breadcrumb
  // never reads "Connections › Connections". Sub-page first, then the area.
  {
    id: "connections-subpage-nav",
    files: BUNDLE,
    pattern: /to:"\/apps\/connections",label:"Connections"/g,
    replacement: 'to:"/apps/connections",label:"Connected apps"',
    expect: 1,
  },
  {
    id: "connections-subpage-breadcrumb",
    files: BUNDLE,
    pattern: /\{label:"Apps",href:"\/apps"\},\{label:"Connections"\}/g,
    replacement: '{label:"Connections",href:"/apps"},{label:"Connected apps"}',
    expect: 1,
  },
  {
    id: "connections-subpage-heading",
    files: BUNDLE,
    pattern: /(\("h1",\{className:"text-2xl font-bold tracking-tight",children:)"Connections"(\}\),\(0,[\w$]+\.jsx\)\("p",\{className:"mt-1 text-sm text-muted-foreground",children:"The t)/g,
    replacement: '$1"Connected apps"$2',
    expect: 2,
  },
  {
    id: "connections-breadcrumbs",
    files: BUNDLE,
    pattern: /\{label:"Apps",href:"\/apps"\}/g,
    replacement: '{label:"Connections",href:"/apps"}',
    expect: 9,
  },
  {
    id: "connections-breadcrumb-root",
    files: BUNDLE,
    pattern: /\{label:"Apps"\}\]/g,
    replacement: '{label:"Connections"}]',
    expect: 1,
  },
  {
    id: "connections-sidebar-label",
    files: BUNDLE,
    pattern: /to:"\/apps",label:"Apps"/g,
    replacement: 'to:"/apps",label:"Connections"',
    expect: 1,
  },
  {
    id: "connections-area-title",
    files: BUNDLE,
    pattern: /(truncate text-sm font-bold text-foreground",children:)"Apps"/g,
    replacement: '$1"Connections"',
    expect: 1,
  },
  {
    id: "connections-area-section",
    files: BUNDLE,
    pattern: /(uppercase tracking-wide text-muted-foreground",children:)"Apps"/g,
    replacement: '$1"Connections"',
    expect: 1,
  },
  {
    id: "connections-browse-heading",
    files: BUNDLE,
    pattern: /(\("h1",\{className:"text-2xl font-bold tracking-tight",children:)"Apps"/g,
    replacement: '$1"Connections"',
    expect: 1,
  },
  {
    id: "connections-empty-hint",
    files: BUNDLE,
    pattern: /("Add one from ",\(0,[\w$]+\.jsx\)\("span",\{className:"font-medium text-foreground",children:)"Apps"/g,
    replacement: '$1"Connections"',
    expect: 1,
  },
  {
    id: "connections-experimental-toggle",
    files: BUNDLE,
    pattern: /title:"Apps",description:"Show the Apps navigation/g,
    replacement: 'title:"Connections",description:"Show the Connections navigation',
    expect: 2,
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
