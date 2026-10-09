import { describe, expect, it } from "vitest";
import { openedBy } from "../../src/ui/groups/opened.js";

const groups = [
  { id: "g1", agents: ["a1", "a2"], apps: ["x"] },
  { id: "g2", agents: ["a2"], apps: [] },
];

describe("openedBy", () => {
  it("names what a delete opens to everyone", () => {
    expect(openedBy(groups, { deleteId: "g1" })).toEqual({ agents: ["a1"], apps: ["x"] });
    expect(openedBy(groups, { deleteId: "g2" })).toEqual({ agents: [], apps: [] });
  });
  it("names what removing items from a group opens", () => {
    expect(openedBy(groups, { groupId: "g1", nextAgents: ["a2"], nextApps: [] })).toEqual({ agents: ["a1"], apps: ["x"] });
    expect(openedBy(groups, { groupId: "g1", nextAgents: ["a1"], nextApps: ["x"] })).toEqual({ agents: [], apps: [] });
  });
});
