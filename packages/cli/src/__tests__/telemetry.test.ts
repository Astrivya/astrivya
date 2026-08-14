import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as compat from "../lib/compat";
import * as telemetry from "../lib/telemetry";

describe("telemetry", () => {
  beforeEach(() => {
    // Isolate the telemetry state file + config from the real user config dir.
    process.env.APPDATA = path.join(os.tmpdir(), "astrivya-test-config", String(Date.now()));
    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "astrivya-test-config", String(Date.now()));
    vi.spyOn(compat, "loadConfig").mockReturnValue({});
    process.env.ASTRIVYA_TELEMETRY = "";
    process.env.NO_TELEMETRY = "";
    process.env.CI = "";
    process.env.GITHUB_ACTIONS = "";
    process.env.GITLAB_CI = "";
    process.env.CIRCLECI = "";
    process.env.TRAVIS = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.ASTRIVYA_TELEMETRY = "";
    process.env.NO_TELEMETRY = "";
    process.env.CI = "";
    process.env.GITHUB_ACTIONS = "";
    process.env.GITLAB_CI = "";
    process.env.CIRCLECI = "";
    process.env.TRAVIS = "";
  });

  it("is enabled by default (opt-out)", () => {
    expect(telemetry.isTelemetryEnabled()).toBe(true);
  });

  it("is disabled when the user opted out in config", () => {
    vi.mocked(compat.loadConfig).mockReturnValue({ telemetry: "off" });
    expect(telemetry.isTelemetryEnabled()).toBe(false);
  });

  it("is disabled via ASTRIVYA_TELEMETRY=off", () => {
    process.env.ASTRIVYA_TELEMETRY = "off";
    expect(telemetry.isTelemetryEnabled()).toBe(false);
  });

  it("is disabled via NO_TELEMETRY=1", () => {
    process.env.NO_TELEMETRY = "1";
    expect(telemetry.isTelemetryEnabled()).toBe(false);
  });

  it("is disabled in CI", () => {
    process.env.CI = "1";
    expect(telemetry.isTelemetryEnabled()).toBe(false);
  });

  it("does not send when disabled", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.CI = "1";
    telemetry.capture("oss_cli_command", { command: "akg query" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(() => telemetry.capture("oss_cli_command", { command: "doctor" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("sends the expected payload shape when enabled", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetry.capture("oss_cli_command", { command: "akg query", exit: "ok" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("posthog.com/capture");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.event).toBe("oss_cli_command");
    expect(body.properties.command).toBe("akg query");
    expect(body.properties.product).toBe("cli");
    expect(body.properties.install_id).toBeTruthy();
    expect(body.distinct_id).toBe(body.properties.install_id);
  });

  it("payload never contains forbidden fields", () => {
    const payload = telemetry.buildCapturePayload("oss_cli_command", {
      command: "x",
      file: "/tmp/a.ts",
      token: "secret",
      query: "SELECT 1",
    });
    expect(Object.keys(payload.properties)).not.toContain("file");
    expect(Object.keys(payload.properties)).not.toContain("token");
    expect(Object.keys(payload.properties)).not.toContain("query");
    for (const key of telemetry.captureForbiddenKeys) {
      expect(Object.keys(payload.properties)).not.toContain(key);
    }
  });

  it("begin/end command telemetry emit one event with exit and duration", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetry.beginCommandTelemetry("config set");
    telemetry.endCommandTelemetry("ok");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.event).toBe("oss_cli_command");
    expect(body.properties).toMatchObject({ command: "config set", exit: "ok" });
    expect(typeof body.properties.duration_ms).toBe("number");
  });

  it("emits error_type on failure", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetry.beginCommandTelemetry("doctor");
    telemetry.endCommandTelemetry("error", "ApiError");
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.properties).toMatchObject({ exit: "error", error_type: "ApiError" });
  });

  it("double end is a no-op (one event per command)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetry.beginCommandTelemetry("status");
    telemetry.endCommandTelemetry("ok");
    telemetry.endCommandTelemetry("error", "X");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("captureUpdateResult emits oss_cli_update with ok and versions", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetry.captureUpdateResult(true, "0.3.0", "0.4.0");
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.event).toBe("oss_cli_update");
    expect(body.properties).toMatchObject({ ok: true, from_version: "0.3.0", to_version: "0.4.0" });
  });

  it("captureUpdateResult reports failure with error_type and no forbidden keys", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    telemetry.captureUpdateResult(false, "0.3.0", undefined, "ENOENT");
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.event).toBe("oss_cli_update");
    expect(body.properties).toMatchObject({ ok: false, from_version: "0.3.0", error_type: "ENOENT" });
    expect(body.properties.to_version).toBeUndefined();
    for (const key of telemetry.captureForbiddenKeys) {
      expect(Object.keys(body.properties)).not.toContain(key);
    }
  });

  it("banner prints once per install", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    telemetry.maybePrintTelemetryBanner();
    telemetry.maybePrintTelemetryBanner();
    expect(errSpy).toHaveBeenCalledOnce();
  });
});
