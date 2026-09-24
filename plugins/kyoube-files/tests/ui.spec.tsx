import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFilesTab } from "../src/ui/ProjectFilesTab.js";
import { GlobalFilesButton, issueRefFromPath, TaskFilesPanel } from "../src/ui/GlobalFilesButton.js";
import { filesTabPath, ProjectSidebarItem } from "../src/ui/ProjectSidebarItem.js";
import { breadcrumbs, bytesToBase64, formatBytes, formatWhen, imageTypeOf, isMarkdown, joinPath, parentOf } from "../src/ui/format.js";
import { bridgeErrorMessage, errorCodeFrom, errorText } from "../src/ui/error-code.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };

function installBridge(pathname = "/acme/projects/p1") {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => ({ companyId: "c1", companyPrefix: "acme", projectId: "p1", entityId: "p1", entityType: "project", userId: "u1" }),
      useHostLocation: () => ({ pathname, search: "", hash: "" }),
      useHostNavigation: () => ({
        resolveHref: (to: string) => `/acme${to}`,
        navigate: () => {},
        linkProps: (to: string) => ({ href: `/acme${to}`, onClick: () => {} }),
      }),
      usePluginAction: () => async () => ({}),
      usePluginToast: () => () => null,
    },
  };
}

afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });

describe("ProjectSidebarItem", () => {
  it("links to the project's Files tab using the host's route ref, falling back to the id", () => {
    installBridge();
    const context = { companyId: "c1", companyPrefix: "acme", projectId: "p1", entityId: "p1", entityType: "project" as const, userId: "u1", projectRef: "PRJ" };
    const html = renderToStaticMarkup(createElement(ProjectSidebarItem, { context }));
    expect(html).toContain(`href="/acme/projects/PRJ?tab=plugin%3Akyoube.files%3Aproject-files"`);
    expect(html).toContain("Files");
    const { projectRef: _omit, ...withoutRef } = context;
    expect(renderToStaticMarkup(createElement(ProjectSidebarItem, { context: withoutRef }))).toContain("/projects/p1?tab=");
  });
  it("builds the tab path with the manifest's ids", () => {
    expect(filesTabPath("a b")).toBe("/projects/a%20b?tab=plugin%3Akyoube.files%3Aproject-files");
  });
});

describe("ProjectFilesTab", () => {
  it("renders its loading state before the access call answers", () => {
    installBridge();
    const context = { companyId: "c1", companyPrefix: "acme", projectId: "p1", entityId: "p1", entityType: "project", userId: "u1" };
    expect(renderToStaticMarkup(createElement(ProjectFilesTab, { context }))).toContain("Loading");
  });
});

describe("GlobalFilesButton", () => {
  it("recognises task pages by route", () => {
    expect(issueRefFromPath("/BAP/issues/BAP-12")).toBe("BAP-12");
    expect(issueRefFromPath("/BAP/issues/BAP-12/")).toBe("BAP-12");
    expect(issueRefFromPath("/issues/3f2c0b8e-1111-4222-8333-444455556666")).toBe("3f2c0b8e-1111-4222-8333-444455556666");
    expect(issueRefFromPath("/BAP/issues/BAP%2D9")).toBe("BAP-9");
    expect(issueRefFromPath("/BAP/projects/x/issues/all")).toBeNull();
    expect(issueRefFromPath("/BAP/issues")).toBeNull();
    expect(issueRefFromPath("/BAP/dashboard")).toBeNull();
  });
  it("renders nothing until a task's project is located, and nothing at all off task pages", () => {
    installBridge("/acme/dashboard");
    const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };
    expect(renderToStaticMarkup(createElement(GlobalFilesButton, { context }))).toBe("");
    installBridge("/acme/issues/ACME-1");
    // Effects do not run in a static render, so the locate call has not answered: no icon yet.
    expect(renderToStaticMarkup(createElement(GlobalFilesButton, { context }))).toBe("");
  });
  it("docks a panel with the project's files and a close control", () => {
    installBridge();
    const html = renderToStaticMarkup(createElement(TaskFilesPanel, { projectId: "p1", projectName: "Onboarding", onClose: () => {} }));
    expect(html).toContain('aria-label="Project files"');
    expect(html).toContain("Onboarding");
    expect(html).toContain('aria-label="Close project files"');
    expect(html).toContain("Loading");
  });
});

describe("format helpers", () => {
  it("formats bytes and times", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(-1)).toBe("");
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(formatWhen(now - 10_000, now)).toBe("just now");
    expect(formatWhen(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatWhen(now - 2 * 86_400_000, now)).toBe("2 d ago");
    expect(formatWhen(now - 30 * 86_400_000, now)).toBe("2026-08-20");
  });
  it("classifies names and splits paths", () => {
    expect(imageTypeOf("a.PNG")).toBe("image/png");
    expect(imageTypeOf("a.txt")).toBeNull();
    expect(imageTypeOf(".png")).toBeNull();
    expect(isMarkdown("README.md")).toBe(true);
    expect(isMarkdown("readme")).toBe(false);
    expect(breadcrumbs("")).toEqual([]);
    expect(breadcrumbs("a/b")).toEqual([{ path: "a", name: "a" }, { path: "a/b", name: "b" }]);
    expect(parentOf("a/b")).toBe("a");
    expect(parentOf("a")).toBe("");
    expect(joinPath("", "x")).toBe("x");
    expect(joinPath("a", "x")).toBe("a/x");
  });
  it("base64-encodes bytes in chunks", () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("error helpers", () => {
  it("finds the worker's code inside a wrapped bridge rejection and strips it for display", () => {
    const rejection = { code: "WORKER_ERROR", message: "Plugin action failed: conflict: docs/plan.md changed on disk since it was opened" };
    expect(bridgeErrorMessage(rejection)).toContain("conflict");
    expect(errorCodeFrom(rejection)).toBe("conflict");
    expect(errorText(rejection)).toBe("docs/plan.md changed on disk since it was opened");
    expect(errorCodeFrom({ code: "TIMEOUT", message: "timed out" })).toBe("error");
    expect(errorText("plain")).toBe("plain");
    expect(bridgeErrorMessage(null)).toBe("error");
  });
});
