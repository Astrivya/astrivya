import * as readline from "node:readline";

export function prompt(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Prompt for a secret without echoing keystrokes back to the terminal. */
export function promptHidden(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    const internal = rl as unknown as { _writeToOutput: (s: string) => void };
    const originalWrite = internal._writeToOutput;
    internal._writeToOutput = (s: string) => {
      if (s === query) originalWrite.call(rl, s);
    };
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
