import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { injectPluginEnv } from "../lib/plugin";

vi.mock("../lib/compat", () => ({
  getBaseUrl: vi.fn(() => "https://api.astrivya.ai"),
  getToken: vi.fn(() => "cfg-token"),
  getLicenseKey: vi.fn(() => "astlk_test"),
}));

const envKeys = ["ASTRIVYA_BASE_URL", "ASTRIVYA_TOKEN", "ASTRIVYA_LICENSE_KEY"] as const;

describe("injectPluginEnv", () => {
  beforeEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it("injects the CLI-resolved base URL and credentials into the environment", () => {
    expect(process.env.ASTRIVYA_BASE_URL).toBeUndefined();
    injectPluginEnv();
    expect(process.env.ASTRIVYA_BASE_URL).toBe("https://api.astrivya.ai");
    expect(process.env.ASTRIVYA_TOKEN).toBe("cfg-token");
    expect(process.env.ASTRIVYA_LICENSE_KEY).toBe("astlk_test");
  });

  it("never overrides an existing environment value", () => {
    process.env.ASTRIVYA_BASE_URL = "https://custom.example.com";
    process.env.ASTRIVYA_TOKEN = "env-token";
    injectPluginEnv();
    expect(process.env.ASTRIVYA_BASE_URL).toBe("https://custom.example.com");
    expect(process.env.ASTRIVYA_TOKEN).toBe("env-token");
  });
});
