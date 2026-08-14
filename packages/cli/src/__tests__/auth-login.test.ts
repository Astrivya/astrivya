import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginChoice, probeOAuthConfig, runTokenLogin } from "../commands/auth";

vi.mock("../lib/compat", () => ({
  apiCall: vi.fn(),
  clearConfig: vi.fn(),
  clearLicenseKey: vi.fn(),
  findFreePort: vi.fn(),
  getBaseUrl: vi.fn().mockReturnValue("https://api.astrivya.ai"),
  getLicenseKey: vi.fn(),
  getPremiumAuth: vi.fn(),
  getToken: vi.fn(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  saveLicenseKey: vi.fn(),
  startOAuthServer: vi.fn(),
}));

vi.mock("../lib/prompt", () => ({
  prompt: vi.fn(),
  promptHidden: vi.fn(),
}));

import { getBaseUrl, saveConfig } from "../lib/compat";
import { promptHidden } from "../lib/prompt";

const mocks = {
  getBaseUrl: vi.mocked(getBaseUrl),
  saveConfig: vi.mocked(saveConfig),
  promptHidden: vi.mocked(promptHidden),
};

describe("parseLoginChoice", () => {
  it("maps the numbered options", () => {
    expect(parseLoginChoice("1")).toBe("browser");
    expect(parseLoginChoice("2")).toBe("token");
    expect(parseLoginChoice("3")).toBe("cancel");
  });

  it("maps friendly aliases", () => {
    expect(parseLoginChoice("browser")).toBe("browser");
    expect(parseLoginChoice("b")).toBe("browser");
    expect(parseLoginChoice("paste")).toBe("token");
    expect(parseLoginChoice("token")).toBe("token");
    expect(parseLoginChoice("cancel")).toBe("cancel");
    expect(parseLoginChoice("q")).toBe("cancel");
  });

  it("rejects unknown input", () => {
    expect(parseLoginChoice("4")).toBeNull();
    expect(parseLoginChoice("")).toBeNull();
    expect(parseLoginChoice("yes")).toBeNull();
  });
});

describe("probeOAuthConfig", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("accepts a healthy OAuth redirect with a client id", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://github.com/login/oauth/authorize?client_id=abc&scope=read%3Auser" },
      }),
    );
    const result = await probeOAuthConfig("https://api.astrivya.ai", 18080);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://api.astrivya.ai/auth/cli?cli_port=18080");
  });

  it("flags a misconfigured cloud with an empty client id", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://github.com/login/oauth/authorize?client_id=&scope=read%3Auser" },
      }),
    );
    const result = await probeOAuthConfig("https://api.astrivya.ai", 18080);
    expect(result.ok).toBe(false);
    expect(result.issue).toContain("client id");
  });

  it("flags an unreachable cloud", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await probeOAuthConfig("https://api.astrivya.ai", 18080);
    expect(result.ok).toBe(false);
    expect(result.issue).toContain("could not reach");
  });

  it("appends the provider param when not github", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?client_id=g1" },
      }),
    );
    const result = await probeOAuthConfig("https://api.astrivya.ai", 18080, "google");
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.astrivya.ai/auth/cli?cli_port=18080&provider=google",
      expect.anything(),
    );
  });
});

describe("runTokenLogin", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("validates and saves a provided token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ email: "a@b.c" }), { status: 200 }));
    const ok = await runTokenLogin("tok123");
    expect(ok).toBe(true);
    expect(saveConfig).toHaveBeenCalledWith({ token: "tok123", baseUrl: "https://api.astrivya.ai" });
  });

  it("rejects a token the server refuses", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const ok = await runTokenLogin("bad");
    expect(ok).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("prompts for a token when none is provided", async () => {
    mocks.promptHidden.mockResolvedValue("pasted-token");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ email: "a@b.c" }), { status: 200 }));
    const ok = await runTokenLogin();
    expect(ok).toBe(true);
    expect(saveConfig).toHaveBeenCalledWith({ token: "pasted-token", baseUrl: "https://api.astrivya.ai" });
  });

  it("cancels when the paste is empty", async () => {
    mocks.promptHidden.mockResolvedValue("");
    const ok = await runTokenLogin();
    expect(ok).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
  });
});
