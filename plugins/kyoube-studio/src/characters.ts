/**
 * KyoubeAI's agent characters: flat busts drawn as SVG, one per agent.
 *
 * The core gives each agent an icon name (rocket, target, sparkles, ... from
 * its 40-icon picker) and no picture. The icon decides the character's tint,
 * hairstyle, accessory and shirt, so picking an icon in the agent's settings
 * picks a face. The agent's name decides skin tone and hair colour, so two
 * agents that share an icon still look like two people. An agent with no
 * icon gets a face from its name alone. `bot`, `cpu` and `circuit-board`
 * are robots.
 *
 * The tile behind the bust is not part of the SVG: the component paints it
 * from the theme's --kyoube-tile-<tint> token so it follows light and dark.
 */

export type Tint = "teal" | "sky" | "violet" | "amber" | "rose" | "zinc";
type Hair = "short" | "bun" | "long" | "curly" | "beanie" | "bob" | "buzz" | "cap" | "ponytail" | "mohawk" | "wavy" | "bald";
type Accessory = "none" | "glasses" | "earring" | "headphones" | "beard" | "freckles";

interface Traits {
  tint: Tint;
  hair: Hair;
  accessory: Accessory;
}

const SHIRTS: Record<Tint, string> = {
  teal: "#0f766e",
  sky: "#0369a1",
  violet: "#4c1d95",
  amber: "#b45309",
  rose: "#be123c",
  zinc: "#3f3f46",
};
/** [skin, shade for neck and ears] */
const SKINS: Array<[string, string]> = [
  ["#f3cfb3", "#e2b393"],
  ["#eab893", "#d69f79"],
  ["#d9a27e", "#c48b66"],
  ["#b57a54", "#9c6644"],
  ["#8d5a3b", "#774a2f"],
  ["#633e28", "#52321f"],
];
const HAIR_COLOURS = ["#1f1a17", "#3b2418", "#5b3a29", "#8a3b1c", "#a16207", "#52525b"];

/** The core's agent icon names (ui/src/lib/agent-icons.ts) and the character each one draws. */
export const ICON_TRAITS: Record<string, Traits | { robot: Tint }> = {
  bot: { robot: "teal" },
  cpu: { robot: "sky" },
  "circuit-board": { robot: "violet" },
  brain: { tint: "violet", hair: "short", accessory: "glasses" },
  zap: { tint: "amber", hair: "mohawk", accessory: "none" },
  rocket: { tint: "sky", hair: "bun", accessory: "earring" },
  code: { tint: "teal", hair: "buzz", accessory: "glasses" },
  terminal: { tint: "zinc", hair: "cap", accessory: "none" },
  shield: { tint: "sky", hair: "short", accessory: "none" },
  eye: { tint: "violet", hair: "bob", accessory: "none" },
  search: { tint: "amber", hair: "wavy", accessory: "glasses" },
  wrench: { tint: "amber", hair: "cap", accessory: "beard" },
  hammer: { tint: "rose", hair: "buzz", accessory: "beard" },
  lightbulb: { tint: "amber", hair: "curly", accessory: "none" },
  sparkles: { tint: "violet", hair: "beanie", accessory: "none" },
  star: { tint: "rose", hair: "ponytail", accessory: "earring" },
  heart: { tint: "rose", hair: "long", accessory: "none" },
  flame: { tint: "rose", hair: "mohawk", accessory: "earring" },
  bug: { tint: "teal", hair: "curly", accessory: "glasses" },
  cog: { tint: "zinc", hair: "short", accessory: "headphones" },
  database: { tint: "teal", hair: "bob", accessory: "glasses" },
  globe: { tint: "sky", hair: "wavy", accessory: "freckles" },
  lock: { tint: "zinc", hair: "bald", accessory: "beard" },
  mail: { tint: "sky", hair: "ponytail", accessory: "none" },
  "message-square": { tint: "teal", hair: "long", accessory: "earring" },
  "file-code": { tint: "violet", hair: "buzz", accessory: "headphones" },
  "git-branch": { tint: "teal", hair: "ponytail", accessory: "glasses" },
  package: { tint: "amber", hair: "beanie", accessory: "freckles" },
  puzzle: { tint: "violet", hair: "curly", accessory: "earring" },
  target: { tint: "amber", hair: "curly", accessory: "earring" },
  wand: { tint: "violet", hair: "long", accessory: "freckles" },
  atom: { tint: "sky", hair: "bald", accessory: "glasses" },
  radar: { tint: "teal", hair: "bob", accessory: "headphones" },
  swords: { tint: "rose", hair: "short", accessory: "beard" },
  telescope: { tint: "sky", hair: "cap", accessory: "glasses" },
  microscope: { tint: "teal", hair: "bun", accessory: "glasses" },
  crown: { tint: "amber", hair: "wavy", accessory: "earring" },
  gem: { tint: "violet", hair: "bob", accessory: "earring" },
  hexagon: { tint: "zinc", hair: "wavy", accessory: "headphones" },
  pentagon: { tint: "rose", hair: "bun", accessory: "none" },
  fingerprint: { tint: "zinc", hair: "buzz", accessory: "glasses" },
};

/** The human characters an agent without a known icon draws from, by name. */
const HUMAN_ICONS = Object.keys(ICON_TRAITS).filter((icon) => !("robot" in ICON_TRAITS[icon]!));

/** FNV-1a: small, stable across runs and platforms, good enough to spread names. */
export function nameHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface Character {
  tint: Tint;
  svg: string;
}

const HEAD = { cx: 20, cy: 18.8, rx: 7.8, ry: 8.4 };

function hairBack(hair: Hair, colour: string): string {
  switch (hair) {
    case "long": return `<path d="M10.6 20.5c-.9-7.9 3.2-12.6 9.4-12.6s10.3 4.7 9.4 12.6l.8 11h-4.4l-.8-7H15l-.8 7H9.8z" fill="${colour}"/>`;
    case "bob": return `<path d="M10.8 22.4c-1-8.1 3.1-13.2 9.2-13.2s10.2 5.1 9.2 13.2c-1.3.9-2.8 1.3-4.3 1.1l-.4-8.1h-9l-.4 8.1c-1.5.2-3-.2-4.3-1.1z" fill="${colour}"/>`;
    case "ponytail": return `<path d="M27.4 12.2c3.9.7 5.6 4.8 4.1 9.8-.5 1.8-1.7 3.3-3.2 4 1.1-3.6.6-7.1-1-9.7z" fill="${colour}"/>`;
    case "bun": return `<circle cx="20" cy="7.6" r="3.7" fill="${colour}"/>`;
    default: return "";
  }
}

function hairFront(hair: Hair, colour: string, tint: Tint): string {
  switch (hair) {
    case "short": return `<path d="M11.9 17.9c-.8-6.2 3.2-10.1 8.5-10.1 5.6 0 9 3.6 8.2 9.6-1.5-2.8-3.9-4.4-7.2-4.8-2.9 2.1-6 3.9-9.5 5.3z" fill="${colour}"/>`;
    case "bun": return `<path d="M11.8 18.4c-.5-6 3.4-9.6 8.2-9.6s8.7 3.6 8.2 9.6c-1.9-3.6-4.8-5.2-8.2-5.2s-6.3 1.6-8.2 5.2z" fill="${colour}"/>`;
    case "long": return `<path d="M11.9 17c1.2-5.3 4.4-7.8 8.1-7.8 4.1 0 7.3 2.7 8.2 7.4-3.7-.5-7.1-2.3-9.3-4.8-1.6 2.4-4 4.3-7 5.2z" fill="${colour}"/>`;
    case "curly": return `<g fill="${colour}"><circle cx="13" cy="13" r="3.5"/><circle cx="16.4" cy="9.6" r="3.6"/><circle cx="20.2" cy="8.6" r="3.7"/><circle cx="24" cy="9.7" r="3.6"/><circle cx="27.2" cy="13" r="3.5"/><circle cx="28.1" cy="16.6" r="2.6"/><circle cx="11.9" cy="16.6" r="2.6"/></g>`;
    case "beanie": return `<path d="M12.3 19.6c-.6-2 .1-3.2 1.1-3.8M27.7 19.6c.6-2-.1-3.2-1.1-3.8" stroke="${colour}" stroke-width="2.2" stroke-linecap="round" fill="none"/><path d="M11.2 16.4c0-5.7 3.9-9.4 8.8-9.4s8.8 3.7 8.8 9.4z" fill="${SHIRTS[tint]}"/><rect x="10.7" y="14.6" width="18.6" height="3.4" rx="1.7" fill="${SHIRTS[tint]}" opacity=".8"/><rect x="10.7" y="14.6" width="18.6" height="3.4" rx="1.7" fill="#fff" opacity=".18"/><circle cx="20" cy="6.6" r="1.9" fill="#fff" opacity=".85"/>`;
    case "bob": return `<path d="M11.6 16.6c.6-4.9 3.9-7.7 8.4-7.7s7.8 2.8 8.4 7.7z" fill="${colour}"/>`;
    case "buzz": return `<path d="M12.2 15.8c.6-4.7 3.8-7.3 7.8-7.3s7.2 2.6 7.8 7.3c-2.4-1.6-5-2.3-7.8-2.3s-5.4.7-7.8 2.3z" fill="${colour}"/>`;
    case "cap": return `<path d="M11.4 15.9c.3-4.9 3.8-8.1 8.6-8.1s8.3 3.2 8.6 8.1z" fill="${SHIRTS[tint]}"/><path d="M20 14.3h10.8c.9 0 1.2 1.2.4 1.6-3 1.2-6.8 1.4-11.2 1.2z" fill="${SHIRTS[tint]}"/><path d="M20 14.3h10.8c.9 0 1.2 1.2.4 1.6-3 1.2-6.8 1.4-11.2 1.2z" fill="#000" opacity=".18"/>`;
    case "ponytail": return `<path d="M11.8 17.6c-.4-5.9 3.4-9.5 8.2-9.5 4.9 0 8.6 3.4 8.2 9.2-3.2-1.2-6.4-3.2-8.4-5.6-1.8 2.8-4.6 4.8-8 5.9z" fill="${colour}"/>`;
    case "mohawk": return `<path d="M17.6 13.4c-.3-4.4.5-7.7 2.4-10 1.9 2.3 2.7 5.6 2.4 10z" fill="${colour}"/><path d="M12.8 15.2c1.8-1.1 4.2-1.8 7.2-1.8s5.4.7 7.2 1.8" stroke="${colour}" stroke-width="1.2" fill="none" opacity=".5"/>`;
    case "wavy": return `<path d="M11.4 18.6c-1.2-6.6 2.8-11 8.6-11 6 0 9.6 4.4 8.6 11-.9-1.4-1.3-3.2-1.2-5.2-1.4 1.4-3.2 1.9-5 1.4-1.6-.4-2.8-1.6-3.6-3-1.2 2.4-3.6 4.2-6.2 4.6-.4.8-.8 1.4-1.2 2.2z" fill="${colour}"/>`;
    case "bald": return "";
  }
}

function accessory(kind: Accessory, colour: string): string {
  switch (kind) {
    case "glasses": return `<g fill="none" stroke="#1f2328" stroke-width=".95"><circle cx="16.8" cy="19.6" r="2.6"/><circle cx="23.2" cy="19.6" r="2.6"/><path d="M19.4 19.5h1.2"/></g>`;
    case "earring": return `<circle cx="12" cy="21.2" r="1" fill="#fbbf24"/>`;
    case "headphones": return `<path d="M11.2 18.2c0-6.1 3.9-9.9 8.8-9.9s8.8 3.8 8.8 9.9" stroke="#27272a" stroke-width="1.8" fill="none"/><rect x="9.6" y="16.6" width="3.4" height="6" rx="1.6" fill="#27272a"/><rect x="27" y="16.6" width="3.4" height="6" rx="1.6" fill="#27272a"/>`;
    case "beard": return `<path d="M13.4 21.4c.8 4.6 3.5 6.9 6.6 6.9s5.8-2.3 6.6-6.9c-1.9 1.1-4.1 1.6-6.6 1.6s-4.7-.5-6.6-1.6z" fill="${colour}"/>`;
    case "freckles": return `<g fill="#a0522d" opacity=".55"><circle cx="15.2" cy="21.6" r=".45"/><circle cx="16.4" cy="22.3" r=".45"/><circle cx="14.6" cy="22.6" r=".45"/><circle cx="24.8" cy="21.6" r=".45"/><circle cx="23.6" cy="22.3" r=".45"/><circle cx="25.4" cy="22.6" r=".45"/></g>`;
    case "none": return "";
  }
}

function human(traits: Traits, seed: number): string {
  const [skin, shade] = SKINS[seed % SKINS.length]!;
  const hairColour = HAIR_COLOURS[Math.floor(seed / 7) % HAIR_COLOURS.length]!;
  const shirt = SHIRTS[traits.tint];
  const mouth = traits.accessory === "beard"
    ? `<path d="M18.2 24.4q1.8 1 3.6 0" fill="none" stroke="#f4f4f5" stroke-width="1" stroke-linecap="round" opacity=".7"/>`
    : `<path d="M17.8 23.2q2.2 1.7 4.4 0" fill="none" stroke="#1f2328" stroke-width="1.1" stroke-linecap="round"/>`;
  const cheeks = traits.accessory === "freckles" || traits.accessory === "beard" ? "" : `<circle cx="15.4" cy="22" r="1.3" fill="#e27d6a" opacity=".35"/><circle cx="24.6" cy="22" r="1.3" fill="#e27d6a" opacity=".35"/>`;
  return [
    hairBack(traits.hair, hairColour),
    `<path d="M5 40c0-8.2 6.7-12.6 15-12.6S35 31.8 35 40z" fill="${shirt}"/>`,
    `<path d="M16.6 28.4 20 33l3.4-4.6" fill="none" stroke="#fff" stroke-width="1" opacity=".35"/>`,
    `<rect x="17" y="23.5" width="6" height="6" rx="2" fill="${shade}"/>`,
    `<ellipse cx="11.9" cy="19.6" rx="1.3" ry="1.8" fill="${shade}"/><ellipse cx="28.1" cy="19.6" rx="1.3" ry="1.8" fill="${shade}"/>`,
    `<ellipse cx="${HEAD.cx}" cy="${HEAD.cy}" rx="${HEAD.rx}" ry="${HEAD.ry}" fill="${skin}"/>`,
    cheeks,
    accessory(traits.accessory === "glasses" || traits.accessory === "headphones" ? "none" : traits.accessory, hairColour),
    `<circle cx="17" cy="19.7" r="1" fill="#1f2328"/><circle cx="23" cy="19.7" r="1" fill="#1f2328"/>`,
    mouth,
    hairFront(traits.hair, hairColour, traits.tint),
    traits.accessory === "glasses" || traits.accessory === "headphones" ? accessory(traits.accessory, hairColour) : "",
  ].join("");
}

function robot(tint: Tint): string {
  const body = SHIRTS[tint];
  return [
    `<path d="M8 40c0-7.4 5.4-11 12-11s12 3.6 12 11z" fill="${body}"/>`,
    `<path d="M20 8.6V5.6" stroke="#52525b" stroke-width="1.6" stroke-linecap="round"/><circle cx="20" cy="5" r="1.7" fill="#2dd4bf"/>`,
    `<rect x="17.6" y="24" width="4.8" height="5.5" rx="1.4" fill="#71717a"/>`,
    `<rect x="11" y="9" width="18" height="16" rx="6" fill="#d4d4d8"/>`,
    `<rect x="13.5" y="12.5" width="13" height="8.5" rx="4" fill="#27272a"/>`,
    `<circle cx="17.3" cy="16.7" r="1.5" fill="#5eead4"/><circle cx="22.7" cy="16.7" r="1.5" fill="#5eead4"/>`,
    `<rect x="9.2" y="14.5" width="2" height="5" rx="1" fill="#a1a1aa"/><rect x="28.8" y="14.5" width="2" height="5" rx="1" fill="#a1a1aa"/>`,
  ].join("");
}

/** The character for one agent: its tint and a 40×40 SVG with no background. */
export function characterFor(icon: string | null | undefined, name: string): Character {
  const seed = nameHash(name || "agent");
  const key = icon && ICON_TRAITS[icon] ? icon : HUMAN_ICONS[seed % HUMAN_ICONS.length]!;
  const traits = ICON_TRAITS[key]!;
  const inner = "robot" in traits ? robot(traits.robot) : human(traits, seed);
  const tint = "robot" in traits ? traits.robot : traits.tint;
  return { tint, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" aria-hidden="true" focusable="false">${inner}</svg>` };
}
