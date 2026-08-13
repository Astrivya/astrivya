import type { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRootAction } from "../lib/entry-guard";

function makeProgram(args: string[]) {
  return { args, outputHelp: vi.fn() } as unknown as Command;
}

describe("runRootAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the TUI when invoked with no arguments", () => {
    const program = makeProgram([]);
    const startTui = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    runRootAction(program, startTui);

    expect(startTui).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("errors with exit 1 instead of launching the TUI for an unknown command", () => {
    const program = makeProgram(["frobnicate"]);
    const startTui = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runRootAction(program, startTui);

    expect(startTui).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown command: frobnicate"));
    expect(program.outputHelp).toHaveBeenCalledWith({ error: true });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not mistake option-only invocations for unknown commands", () => {
    const program = makeProgram([]);
    const startTui = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    runRootAction(program, startTui);

    expect(startTui).toHaveBeenCalledOnce();
  });

  it("surfaces TUI startup errors and exits 1", async () => {
    const program = makeProgram([]);
    const startTui = vi.fn().mockRejectedValue(new Error("boom"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runRootAction(program, startTui);
    await new Promise((r) => setTimeout(r, 0));

    expect(errorSpy).toHaveBeenCalledWith("TUI error:", expect.stringContaining("boom"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
