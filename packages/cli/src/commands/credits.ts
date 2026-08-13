import type { Command } from "commander";
import { apiCall, getBaseUrl, getToken, loadConfig } from "../lib/compat";
import { color, getErrorMessage, json as printJson, startSpinner, table } from "../lib/output";

export function registerCredits(program: Command): void {
  const cmd = program
    .command("credits")
    .description("View cloud credit balance, purchase history, and usage")
    .option("--json", "Output raw JSON")
    .option("--ndjson", "Output newline-delimited JSON");

  cmd.action(async (options) => {
    const config = loadConfig();

    if (config.offlineMode) {
      console.log(color.dim("Credit information is only available in online mode."));
      return;
    }

    let spinner: any = null;
    try {
      const token = getToken();
      if (!token) {
        console.log(color.red("Not logged in. Run 'astrivya auth login' first."));
        return;
      }

      spinner = startSpinner("Fetching credit balance...");
      const balance: any = await apiCall("/api/credits/balance", "GET");
      const txs: any[] = await apiCall("/api/credits/transactions?limit=10", "GET");
      spinner.stop();

      if (options.ndjson) {
        console.log(JSON.stringify({ balance, recentTransactions: txs }));
        return;
      }

      if (options.json) {
        printJson({ balance, recentTransactions: txs });
        return;
      }

      const bal = balance?.balance ?? 0;
      const purchased = balance?.lifetime_purchased ?? 0;
      const consumed = balance?.lifetime_consumed ?? 0;

      console.log(`\n  ${color.bold("Credits & Usage")}`);
      console.log(`  ${color.dim("\u2500".repeat(44))}`);

      const pctColor = bal <= 10 ? color.red : bal <= 50 ? color.yellow : color.green;
      console.log(
        `  ${color.bold("Balance:")}    ${pctColor(`${bal} credits`)}${bal <= 10 ? color.red(" \u26A0 Low") : ""}`,
      );

      if (consumed > 0) {
        const pct = Math.min(Math.round((consumed / (consumed + bal)) * 100), 100);
        const barLen = 20;
        const filled = Math.round((pct / 100) * barLen);
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
        const barColor = pct >= 80 ? color.red : pct >= 50 ? color.yellow : color.green;
        console.log(`  ${color.bold("Used:")}       ${consumed} credits`);
        console.log(`              ${barColor(bar)} ${barColor(`${pct}%`)}`);
      }

      console.log(`  ${color.bold("Purchased:")}  ${purchased} credits lifetime`);

      if (txs.length > 0) {
        console.log();
        console.log(`  ${color.bold("Recent Transactions")}`);
        const rows = txs.slice(0, 5).map((t: any) => {
          const date = t.created_at ? new Date(t.created_at).toLocaleDateString() : "?";
          const amt = t.transaction_type === "debit" ? `-${t.amount}` : `+${t.amount}`;
          return [date, t.surface ?? "?", amt, `${t.balance_after ?? "?"}`];
        });
        table(["Date", "Surface", "\u0394", "After"], rows);
      }

      if (bal <= 10) {
        console.log(`  ${color.yellow("\u26A0  Low balance. Run 'astrivya credits buy' to top up.")}`);
      }

      console.log();
    } catch (err: unknown) {
      if (spinner) spinner.stop();
      console.error(color.red(`Failed: ${getErrorMessage(err)}`));
    }
  });

  cmd
    .command("history")
    .description("Show credit transaction history")
    .option("--limit <number>", "Number of transactions", "20")
    .option("--json", "Output raw JSON")
    .action(async (options) => {
      let spinner: any = null;
      try {
        const token = getToken();
        if (!token) {
          console.log(color.red("Not logged in. Run 'astrivya auth login' first."));
          return;
        }

        const limit = Math.max(1, Math.min(500, Number.parseInt(options.limit, 10) || 20));
        spinner = startSpinner("Fetching transaction history...");
        const txs: any[] = await apiCall(`/api/credits/transactions?limit=${limit}`, "GET");
        spinner.stop();

        if (options.json) {
          printJson(txs);
          return;
        }

        if (!txs.length) {
          console.log(color.dim("No transactions found."));
          return;
        }

        console.log(`\n  ${color.bold("Transaction History")}`);
        console.log(`  ${color.dim("\u2500".repeat(60))}`);
        for (const t of txs) {
          const date = t.created_at ? new Date(t.created_at).toLocaleString() : "?";
          const amtStr = t.transaction_type === "debit" ? `-${t.amount}` : `+${t.amount}`;
          const amtColor = t.transaction_type === "debit" ? color.red : color.green;
          console.log(
            `  ${color.dim(date)}  ${amtColor(amtStr.padStart(6))}  ${color.dim(t.surface ?? "?")}  ${color.dim(`\u2192 ${t.balance_after}`)}`,
          );
        }
        console.log();
      } catch (err: unknown) {
        if (spinner) spinner.stop();
        console.error(color.red(`Failed: ${getErrorMessage(err)}`));
      }
    });

  cmd
    .command("buy")
    .description("Purchase additional credits (opens browser)")
    .action(() => {
      const baseUrl = getBaseUrl();
      const url = `${baseUrl}/settings/billing`;
      console.log(`Opening ${color.cyan(url)} ...`);
      import("open")
        .then((o) => o.default(url))
        .catch(() => {
          console.log(`Open this URL in your browser:\n  ${color.cyan(url)}`);
        });
    });
}
