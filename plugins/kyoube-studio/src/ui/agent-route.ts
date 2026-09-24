/**
 * How the Studio layout meets the core's own agent page (`/<co>/agents/<ref>/<tab>`).
 *
 * The core page has fixed tabs and no plugin slot, so the Concept C profile
 * is a Studio page (`/<co>/team/<ref>`). The core page's default view (its
 * "Dashboard" tab, which docker/theme renames "Overview") sends people to the
 * profile instead; its other tabs (Instructions, Skills, Configuration,
 * Runs, …) stay the core's, with the agent's character in their header.
 * `?classic=1` keeps the core's own dashboard view.
 */
import { characterFor } from "../characters.js";

const CORE_AGENT_PAGE = /^\/[^/]+\/agents\/([^/]+)(?:\/([^/]+))?\/?$/;
const NOT_AN_AGENT = new Set(["new", "all"]);

/** The agent a core agent URL is about, and which tab, or null for other pages. */
export function coreAgentPage(pathname: string): { ref: string; tab: string } | null {
  const match = CORE_AGENT_PAGE.exec(pathname);
  if (!match) return null;
  const ref = decodeURIComponent(match[1]!);
  if (NOT_AN_AGENT.has(ref)) return null;
  return { ref, tab: match[2] ? decodeURIComponent(match[2]) : "dashboard" };
}

/** Where the Studio layout sends a core agent URL: its default view goes to the profile; everything else stays. */
export function agentRedirectTarget(pathname: string, search: string): string | null {
  if (/(?:^|[?&])classic=1(?:&|$)/.test(search)) return null;
  const page = coreAgentPage(pathname);
  if (!page || page.tab !== "dashboard") return null;
  return `/team/${encodeURIComponent(page.ref)}`;
}

/**
 * The core agent page, recognised by its own tab bar: the Radix tab triggers
 * carry their route value at the end of their id.
 */
export const CORE_AGENT_PAGE_SCOPE = 'main:has([role="tab"][id$="-trigger-instructions"]):has([role="tab"][id$="-trigger-budget"])';

/** Every icon name the core's agent-icon picker offers; anything else renders as its default, `bot`. */
const CORE_ICONS = new Set(["bot", "cpu", "brain", "zap", "rocket", "code", "terminal", "shield", "eye", "search", "wrench", "hammer", "lightbulb", "sparkles", "star", "heart", "flame", "bug", "cog", "database", "globe", "lock", "mail", "message-square", "file-code", "git-branch", "package", "puzzle", "target", "wand", "atom", "circuit-board", "radar", "swords", "telescope", "microscope", "crown", "gem", "hexagon", "pentagon", "fingerprint"]);

/**
 * CSS that paints an agent's character over the icon button in the core
 * agent page's header (the icon picker's trigger), for the agent on screen.
 * It only matches inside the core agent page and only a trigger that holds
 * this agent's icon, so anything else on the page is untouched, and when the
 * core changes that markup the selector simply stops matching.
 */
export function coreAvatarCss(agent: { name: string; icon: string | null }): string {
  const iconClass = `lucide-${agent.icon && CORE_ICONS.has(agent.icon) ? agent.icon : "bot"}`;
  const { tint, svg } = characterFor(agent.icon, agent.name);
  const trigger = `${CORE_AGENT_PAGE_SCOPE} button[data-slot="popover-trigger"]:has(> svg.${iconClass})`;
  const image = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  return [
    `${trigger} { background: ${image} center / 100% no-repeat, var(--kyoube-tile-${tint}, #e9e9ec); width: 56px; height: 56px; border-radius: 30%; }`,
    `${trigger} > svg { opacity: 0; }`,
  ].join("\n");
}
