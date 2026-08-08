export type CreditSurface =
  | "web_chat"
  | "space_qa"
  | "agent_proxy"
  | "mcp_gateway"
  | "cli_query"
  | "mcp_server_tool"
  | "cron_briefing"
  | "cron_standup"
  | "purchase"
  | "monthly_refill"
  | "admin_grant"
  | "refund";

export type CreditTransactionType = "debit" | "credit";

export interface CreditBalance {
  user_id: string;
  balance: number;
  lifetime_purchased: number;
  lifetime_consumed: number;
  last_monthly_refill_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  balance_after: number;
  surface: CreditSurface;
  transaction_type: CreditTransactionType;
  reference_id: string | null;
  cost_breakdown: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface DebitResult {
  ok: boolean;
  balance_after?: number;
  reason?: string;
  balance?: number;
  required?: number;
  deficit?: number;
}

export interface CreditResult {
  ok: boolean;
  balance_after?: number;
  reason?: string;
}
