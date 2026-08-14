import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuth } from "../lib/auth-guard";

vi.mock("../commands/auth", () => ({
  runLoginFlow: vi.fn(),
}));

vi.mock("../lib/auto-update", () => ({
  askYesNo: vi.fn(),
}));

vi.mock("../lib/compat", () => ({
  getToken: vi.fn(),
}));

import { runLoginFlow } from "../commands/auth";
import { askYesNo } from "../lib/auto-update";
import { getToken } from "../lib/compat";

const mocks = {
  getToken: vi.mocked(getToken),
  askYesNo: vi.mocked(askYesNo),
  runLoginFlow: vi.mocked(runLoginFlow),
};

describe("ensureAuth", () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    vi.clearAllMocks();
  });

  it("passes through when already authenticated", async () => {
    mocks.getToken.mockReturnValue("tok");
    expect(await ensureAuth({ interactive: true })).toBe(true);
    expect(mocks.askYesNo).not.toHaveBeenCalled();
  });

  it("rejects without prompting on a non-interactive terminal", async () => {
    mocks.getToken.mockReturnValue(undefined);
    expect(await ensureAuth({ interactive: false })).toBe(false);
    expect(mocks.askYesNo).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("astrivya auth login"));
  });

  it("rejects when the user declines the login prompt", async () => {
    mocks.getToken.mockReturnValue(undefined);
    mocks.askYesNo.mockResolvedValue(false);
    expect(await ensureAuth({ interactive: true })).toBe(false);
    expect(mocks.runLoginFlow).not.toHaveBeenCalled();
  });

  it("runs the login flow and succeeds when a token appears", async () => {
    mocks.getToken.mockReturnValueOnce(undefined).mockReturnValueOnce("tok");
    mocks.askYesNo.mockResolvedValue(true);
    mocks.runLoginFlow.mockResolvedValue({});
    expect(await ensureAuth({ interactive: true })).toBe(true);
    expect(mocks.runLoginFlow).toHaveBeenCalledTimes(1);
  });

  it("fails when the login flow throws", async () => {
    mocks.getToken.mockReturnValue(undefined);
    mocks.askYesNo.mockResolvedValue(true);
    mocks.runLoginFlow.mockRejectedValue(new Error("port busy"));
    expect(await ensureAuth({ interactive: true })).toBe(false);
  });

  it("fails when login completes without a token", async () => {
    mocks.getToken.mockReturnValue(undefined);
    mocks.askYesNo.mockResolvedValue(true);
    mocks.runLoginFlow.mockResolvedValue({});
    expect(await ensureAuth({ interactive: true })).toBe(false);
  });
});
