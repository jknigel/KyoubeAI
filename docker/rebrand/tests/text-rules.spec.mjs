import { describe, expect, it } from "vitest";
import { NAME_RE, buildTextRules, findResidual, rewriteCode, rewriteText } from "../lib/text-rules.mjs";

const brand = {
  name: "KyoubeAI",
  urls: {
    home: "https://example.test/home",
    docs: "https://example.test/docs",
    feedback: "https://example.test/feedback",
    tos: "https://example.test/tos",
    repo: "https://example.test/repo",
  },
  phrases: { "/Users/paperclip/workspace": "/Users/you/workspace", "[paperclip]": "[kyoubeai]" },
};
const rules = buildTextRules(brand);
const run = (text) => rewriteText(text, rules).text;

describe("the generic name rule", () => {
  it.each([
    ['children:"Welcome to Paperclip"', 'children:"Welcome to KyoubeAI"'],
    ["Paperclip's current default", "KyoubeAI's current default"],
    ['"Paperclip-managed folder."', '"KyoubeAI-managed folder."'],
    ["**Paperclip** skill", "**KyoubeAI** skill"],
    ["[Paperclip](https://x)", "[KyoubeAI](https://x)"],
    ['"Paperclip task context:"', '"KyoubeAI task context:"'],
    ["/^Paperclip exhausted the bounded/", "/^KyoubeAI exhausted the bounded/"],
    ["title:t=\"Paperclip\"", "title:t=\"KyoubeAI\""],
  ])("rewrites display text %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  it.each([
    "e?.metadata?.managedByPaperclip===!0",
    "manifest.minimumPaperclipVersion",
    "function PaperclipLockup(){}",
    "readPaperclipSkillSyncPreference(config)",
    "class PaperclipCloudConnector {}",
    'header("X-Paperclip-Run-Id")',
    'e.set("X-Paperclip-Route",p)',
    "PAPERCLIP_API_URL=$PAPERCLIP_RUN_ID",
    '"paperclipai/paperclip/paperclip"',
    'managedMode:"paperclip_managed"',
    '"paperclip:inbox:filters"',
    ".paperclip-mention-chip{}",
    "https://telemetry.paperclip.ing/ingest",
    "https://pages.paperclip.ing",
    'new URL(t,"https://paperclip.invalid")',
  ])("leaves the identifier %j alone", (input) => {
    expect(run(input)).toBe(input);
  });

  it("is symmetric: a message and the regex that matches it change together", () => {
    const server = 'throw new Error("Paperclip could not restore the revision.")';
    const ui = 'if(/^Paperclip could not/.test(m))';
    expect(run(server)).toContain("KyoubeAI could not restore");
    expect(run(ui)).toContain("/^KyoubeAI could not/");
  });
});

describe("phrase overrides", () => {
  it("apply before the name rule and only to the exact text", () => {
    expect(run('placeholder:"/Users/paperclip/workspace"')).toBe('placeholder:"/Users/you/workspace"');
    expect(run('n.startsWith("[paperclip]")')).toBe('n.startsWith("[kyoubeai]")');
    expect(run('"[paperclip-runner]"')).toBe('"[paperclip-runner]"');
  });
});

describe("the URL map", () => {
  it.each([
    ['href:"https://docs.paperclip.ing/"', 'href:"https://example.test/docs"'],
    ['"https://docs.paperclip.ing/guides/x#y"', '"https://example.test/docs"'],
    ['"https://paperclip.ing/feedback"', '"https://example.test/feedback"'],
    ['"https://paperclip.ing/tos"', '"https://example.test/tos"'],
    ['href:"https://paperclip.ing/ee"', 'href:"https://example.test/home"'],
    ['P1e="https://github.com/paperclipai/paperclip"', 'P1e="https://example.test/repo"'],
    ['"https://github.com/paperclipai/paperclip/blob/master/doc/INSTALLING.md#x"', '"https://example.test/repo"'],
    ["[Paperclip](https://paperclip.ing) on", "[KyoubeAI](https://example.test/home) on"],
    ['url:"https://paperclip.ing"}', 'url:"https://example.test/home"}'],
  ])("maps %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  it("does not touch the telemetry, pages or invalid hosts", () => {
    for (const keep of ["https://telemetry.paperclip.ing/feedback-traces", "https://pages.paperclip.ing/x", "https://paperclip.invalid"]) {
      expect(run(keep)).toBe(keep);
    }
  });
});

describe("counts and residuals", () => {
  it("reports how many replacements each rule kind made", () => {
    const { counts } = rewriteText('Paperclip and Paperclip, https://paperclip.ing/tos, [paperclip]', rules);
    expect(counts).toEqual({ phrase: 1, url: 1, name: 2 });
  });

  it("finds what the rule would still match, with context", () => {
    expect(findResidual("nothing here")).toEqual([]);
    const residual = findResidual(".".repeat(50) + "Paperclip rules" + "y".repeat(50));
    expect(residual).toHaveLength(1);
    expect(residual[0]).toContain("Paperclip rules");
    expect(residual[0].length).toBeLessThanOrEqual(80);
  });

  it("exports the rule as a global regex", () => {
    expect(NAME_RE.flags).toContain("g");
    expect("a Paperclip b Paperclip".match(NAME_RE)).toHaveLength(2);
  });
});

describe("rewriteCode: the name rule only in display context", () => {
  const code = (text) => rewriteCode(text, rules);

  it.each([
    ["a single-quoted prompt string", "  const prompt = 'You work in a Paperclip-managed company.';", "KyoubeAI-managed"],
    ["a double-quoted label", '  label: "Paperclip API URL",', '"KyoubeAI API URL"'],
    ["a backtick template on one line", "  const s = `Managed by Paperclip`;", "Managed by KyoubeAI"],
    ["a // comment", "const x = 1; // Paperclip does x", "// KyoubeAI does x"],
    ["a JSDoc continuation line", " * Paperclip writes the run log here.", " * KyoubeAI writes"],
    ["a one-line block comment", "const x = 1; /* Paperclip note */ const y = 2;", "/* KyoubeAI note */"],
    ["a string after an escaped quote", '  const s = "she said \\"hi\\" to Paperclip";', 'to KyoubeAI"'],
  ])("rewrites %s", (_label, input, expected) => {
    const result = code(input);
    expect(result.text).toContain(expected);
    expect(result.codeShaped).toEqual([]);
  });

  it.each([
    ["the continuation line of a template literal opened earlier", "  runs inside a Paperclip-managed company.", "a KyoubeAI-managed"],
    ["a JSX text child", "        <Tiny>Paperclip source refs</Tiny>", ">KyoubeAI source refs<"],
    ["a bulleted doc line inside a template", "- You want Paperclip to run the CLI locally", "want KyoubeAI to run"],
  ])("still rewrites %s: prose is not an identifier", (_label, input, expected) => {
    const result = code(input);
    expect(result.text).toContain(expected);
    expect(result.codeShaped).toEqual([]);
  });

  it.each([
    ["a lucide import", 'import { Paperclip } from "lucide-react";'],
    ["a JSX element", '      <Paperclip className="h-4" />'],
    ["a JSX closing tag", "  </Paperclip>"],
    ["an icon map entry", "  icon: Paperclip,"],
    ["a re-export", "export { Paperclip } from './icons';"],
    ["a type position", "  const x: Paperclip = y;"],
  ])("leaves %s alone and reports it", (_label, input) => {
    const result = code(input);
    expect(result.text).toBe(input);
    expect(result.codeShaped).toHaveLength(1);
    expect(result.codeShaped[0]).toContain("Paperclip");
    expect(result.counts.name ?? 0).toBe(0);
  });

  it("applies phrase and URL rules regardless of context", () => {
    expect(code('log("[paperclip] skipping");').text).toBe('log("[kyoubeai] skipping");');
    expect(code("const u = [paperclip];").text).toBe("const u = [kyoubeai];");
    expect(code("fetch(https://paperclip.ing/tos)").text).toBe("fetch(https://example.test/tos)");
  });

  it("counts display-context rewrites and keeps line structure", () => {
    const input = 'const a = "Paperclip one";\nimport { Paperclip } from "lucide-react";\n// Paperclip two\n';
    const result = code(input);
    expect(result.text).toBe('const a = "KyoubeAI one";\nimport { Paperclip } from "lucide-react";\n// KyoubeAI two\n');
    expect(result.counts.name).toBe(2);
    expect(result.codeShaped).toHaveLength(1);
  });
});
