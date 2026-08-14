import { describe, expect, it } from "vitest";
import { isAutoUpdateEnabled, isGlobalInstall, sameMajor, verifyPendingUpdate } from "../lib/auto-update";

describe("mcp-server auto-update — sameMajor", () => {
  it("accepts same-major updates", () => {
    expect(sameMajor("0.1.0", "0.2.0")).toBe(true);
    expect(sameMajor("1.4.2", "1.5.0")).toBe(true);
  });

  it("rejects major jumps", () => {
    expect(sameMajor("0.9.9", "1.0.0")).toBe(false);
    expect(sameMajor("1.9.0", "2.0.0")).toBe(false);
  });
});

describe("mcp-server auto-update — isAutoUpdateEnabled", () => {
  it("is enabled only with ASTRIVYA_MCP_AUTO_UPDATE=1", () => {
    const prev = process.env.ASTRIVYA_MCP_AUTO_UPDATE;
    try {
      process.env.ASTRIVYA_MCP_AUTO_UPDATE = undefined;
      expect(isAutoUpdateEnabled()).toBe(false);
      process.env.ASTRIVYA_MCP_AUTO_UPDATE = "0";
      expect(isAutoUpdateEnabled()).toBe(false);
      process.env.ASTRIVYA_MCP_AUTO_UPDATE = "1";
      expect(isAutoUpdateEnabled()).toBe(true);
    } finally {
      process.env.ASTRIVYA_MCP_AUTO_UPDATE = prev;
    }
  });
});

describe("mcp-server auto-update — isGlobalInstall", () => {
  it("accepts global npm installs", () => {
    expect(isGlobalInstall("/usr/lib/node_modules/@astrivya/mcp-server/dist/index.js")).toBe(true);
    expect(
      isGlobalInstall("/home/user/.local/share/pnpm/global/5/node_modules/@astrivya/mcp-server/dist/index.js"),
    ).toBe(true);
    expect(isGlobalInstall("/home/user/.bun/install/global/node_modules/@astrivya/mcp-server/dist/index.js")).toBe(
      true,
    );
  });

  it("accepts Windows global npm installs", () => {
    expect(
      isGlobalInstall("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@astrivya\\mcp-server\\dist\\index.js"),
    ).toBe(true);
  });

  it("rejects npx cache installs", () => {
    expect(isGlobalInstall("/home/user/.npm/_npx/abc123/node_modules/@astrivya/mcp-server/dist/index.js")).toBe(false);
    expect(
      isGlobalInstall(
        "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\@astrivya\\mcp-server\\dist\\index.js",
      ),
    ).toBe(false);
  });

  it("rejects local project installs and unknown paths", () => {
    expect(isGlobalInstall("/project/node_modules/@astrivya/mcp-server/dist/index.js")).toBe(false);
    expect(isGlobalInstall("/usr/lib/node_modules/@astrivya/cli/dist/index.js")).toBe(false);
    expect(isGlobalInstall("")).toBe(false);
  });
});

describe("mcp-server auto-update — verifyPendingUpdate", () => {
  it("reports success when the running code reached the target", () => {
    expect(verifyPendingUpdate({ pending: "0.2.0" }, "0.2.0")).toEqual({ updated: true, target: "0.2.0" });
    expect(verifyPendingUpdate({ pending: "0.2.0" }, "0.3.0")).toEqual({ updated: true, target: "0.2.0" });
  });

  it("reports failure when the target was not reached", () => {
    expect(verifyPendingUpdate({ pending: "0.2.0" }, "0.1.0")).toEqual({ updated: false });
  });

  it("reports nothing when there is no pending update", () => {
    expect(verifyPendingUpdate({}, "0.1.0")).toEqual({ updated: false });
  });
});
