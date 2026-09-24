/**
 * How the Studio layout meets the core's own agent page (`/<co>/agents/<ref>/<view>`).
 *
 * The core page has fixed views and no plugin slot, so the Concept C profile
 * is a Studio page (`/<co>/team/<ref>`). The core page's default view sends
 * people to the profile instead: "overview" since core 2026.916, "dashboard"
 * before it, and the bare agent URL, which the core resolves to its default.
 * Its other views (Instructions, Skills, Harness / Runtime, …) stay the
 * core's, with the agent's character in their header. `?classic=1` keeps the
 * core's own overview.
 */
import { characterFor } from "../characters.js";

const CORE_AGENT_PAGE = /^\/[^/]+\/agents\/([^/]+)(?:\/([^/]+))?\/?$/;
const NOT_AN_AGENT = new Set(["new", "all"]);
/** The core's default agent view, under its current and its previous name. */
const DEFAULT_VIEWS = new Set(["overview", "dashboard"]);

/** The agent a core agent URL is about, and which view, or null for other pages. */
export function coreAgentPage(pathname: string): { ref: string; tab: string } | null {
  const match = CORE_AGENT_PAGE.exec(pathname);
  if (!match) return null;
  const ref = decodeURIComponent(match[1]!);
  if (NOT_AN_AGENT.has(ref)) return null;
  return { ref, tab: match[2] ? decodeURIComponent(match[2]) : "overview" };
}

/** Where the Studio layout sends a core agent URL: its default view goes to the profile; everything else stays. */
export function agentRedirectTarget(pathname: string, search: string): string | null {
  if (/(?:^|[?&])classic=1(?:&|$)/.test(search)) return null;
  const page = coreAgentPage(pathname);
  if (!page || !DEFAULT_VIEWS.has(page.tab)) return null;
  return `/team/${encodeURIComponent(page.ref)}`;
}

/**
 * The core agent page's header, recognised by the page's own wrapper: every
 * view renders inside `.agent-settings-content`, whose first `<header>` holds
 * the agent's avatar and name.
 */
export const CORE_AGENT_HEADER = ".agent-settings-content > header";

/** `value` as a double-quoted CSS string, safe inside an attribute selector. */
export function cssString(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&").replace(/[\r\n\f]/g, " ")}"`;
}

/**
 * CSS that paints an agent's character over the avatar in the core agent
 * page's header, for the agent on screen. The core labels that avatar
 * "<agent name> avatar" (role="img"), so the rule matches that agent's header
 * only, and when the core changes that markup the selector simply stops
 * matching.
 */
export function coreAvatarCss(agent: { name: string; icon: string | null }): string {
  const { tint, svg } = characterFor(agent.icon, agent.name);
  const avatar = `${CORE_AGENT_HEADER} [role="img"][aria-label=${cssString(`${agent.name} avatar`)}]`;
  const image = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  return [
    `${avatar} { background: ${image} center / 100% no-repeat, var(--kyoube-tile-${tint}, #e9e9ec); width: 56px; height: 56px; border-radius: 30%; }`,
    `${avatar} > * { opacity: 0; }`,
  ].join("\n");
}
