import { describe, expect, it } from "vitest";
import { GOSU_PATHS, findGosu, planNodeUser, writesAsNode, type NodeUserInput } from "../src/run-as-node.js";

const base: NodeUserInput = {
  command: "harness",
  positionals: ["install", "pi"],
  uid: 0,
  gosu: "/usr/sbin/gosu",
  execPath: "/usr/local/bin/node",
  script: "/opt/kyoube/bootstrap/dist/kyoube.mjs",
  argv: ["harness", "install", "pi"],
  reexeced: false,
};

describe("writesAsNode", () => {
  it("covers a harness install, a Claude sign-in and the agent-rules state, nothing else", () => {
    expect(writesAsNode("harness", ["install", "pi"])).toBe(true);
    expect(writesAsNode("connect", ["claude"])).toBe(true);
    expect(writesAsNode("agent-rules", ["off"])).toBe(true);
    expect(writesAsNode("agent-rules", [])).toBe(true);
    expect(writesAsNode("harness", ["list"])).toBe(false);
    expect(writesAsNode("harness", ["missing", "pi_local"])).toBe(false);
    expect(writesAsNode("doctor", [])).toBe(false);
    expect(writesAsNode("ensure-plugins", [])).toBe(false);
  });
});

it("re-runs license and users as node, since they write files the server's node processes rewrite", () => {
  expect(writesAsNode("license", ["set"])).toBe(true);
  expect(writesAsNode("users", ["remove"])).toBe(true);
  expect(writesAsNode("doctor", [])).toBe(false);
});

describe("planNodeUser", () => {
  it("re-executes a harness install as node through gosu when run as root, with the same arguments", () => {
    expect(planNodeUser(base)).toEqual({
      kind: "reexec",
      file: "/usr/sbin/gosu",
      args: ["node", "/usr/local/bin/node", "/opt/kyoube/bootstrap/dist/kyoube.mjs", "harness", "install", "pi"],
    });
  });

  it("re-executes kyoube connect claude as node, keeping its flags", () => {
    const plan = planNodeUser({ ...base, command: "connect", positionals: ["claude"], argv: ["connect", "claude", "--dir", "/x"] });
    expect(plan).toEqual({ kind: "reexec", file: "/usr/sbin/gosu", args: ["node", "/usr/local/bin/node", base.script, "connect", "claude", "--dir", "/x"] });
  });

  it("runs as is for the node user (or any user but root), and for commands that write nothing node needs", () => {
    expect(planNodeUser({ ...base, uid: 1000 })).toEqual({ kind: "run" });
    expect(planNodeUser({ ...base, uid: undefined })).toEqual({ kind: "run" });
    expect(planNodeUser({ ...base, command: "doctor", positionals: [] })).toEqual({ kind: "run" });
    expect(planNodeUser({ ...base, positionals: ["list"] })).toEqual({ kind: "run" });
  });

  it("refuses as root when there is no gosu to switch with, naming what to run instead", () => {
    const plan = planNodeUser({ ...base, gosu: null });
    expect(plan.kind).toBe("refuse");
    expect(plan.kind === "refuse" && plan.message).toContain("docker compose exec -u node app kyoube");
    expect(planNodeUser({ ...base, script: undefined }).kind).toBe("refuse");
  });

  it("refuses rather than loops when the re-executed process is still root", () => {
    const plan = planNodeUser({ ...base, reexeced: true });
    expect(plan.kind).toBe("refuse");
    expect(plan.kind === "refuse" && plan.message).toContain("still running as root");
  });
});

describe("findGosu", () => {
  it("takes the first executable gosu from the system directories only", () => {
    expect(findGosu((file) => file === "/usr/bin/gosu" || file === "/usr/sbin/gosu")).toBe("/usr/sbin/gosu");
    expect(findGosu(() => false)).toBeNull();
    expect(GOSU_PATHS.every((file) => !file.startsWith("/kyoubeai"))).toBe(true);
  });
});
