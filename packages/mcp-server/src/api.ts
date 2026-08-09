const CLOUD_URL = process.env.ASTRIVYA_CLOUD_URL || "";
const OPENAI_KEY = process.env.ASTRIVYA_OPENAI_KEY;
const ANTHROPIC_KEY = process.env.ASTRIVYA_ANTHROPIC_KEY;

function resolveBaseUrl(): string {
  return process.env.ASTRIVYA_BASE_URL || "https://www.astrivya.ai";
}

function resolveToken(): string | undefined {
  return process.env.ASTRIVYA_TOKEN || process.env.ASTRIVYA_API_KEY;
}

export const API_PATHS = {
  DECISIONS: "/api/decisions",
  BRIEFING_DAILY: (limit?: number) => `/api/briefing/daily${limit ? `?limit=${limit}` : ""}`,
  AKG_SYNC_PUSH: "/api/akg/sync/push",
  AKG_SYNC_SEARCH: "/api/akg/sync/search",
  CREDIT_BALANCE: "/api/credits/balance",
  CREDIT_TRANSACTIONS: (limit?: number) => `/api/credits/transactions${limit ? `?limit=${limit}` : ""}`,
} as const;

export function getConfig() {
  return {
    baseUrl: resolveBaseUrl(),
    token: resolveToken(),
    syncUrl: CLOUD_URL,
    openaiKey: OPENAI_KEY,
    anthropicKey: ANTHROPIC_KEY,
  };
}

export function getByokProvider(): { name: string; key: string } | null {
  if (OPENAI_KEY) return { name: "openai", key: OPENAI_KEY };
  if (ANTHROPIC_KEY) return { name: "anthropic", key: ANTHROPIC_KEY };
  return null;
}

export async function syncCall(endpoint: string, method: "GET" | "POST" | "PATCH", body?: any): Promise<any> {
  const { syncUrl, token } = getConfig();
  if (!syncUrl || !token) {
    throw new Error("Cloud server not configured. Set ASTRIVYA_CLOUD_URL and ASTRIVYA_TOKEN.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `${syncUrl}${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`syncCall ${method} ${url} → ${res.status}: ${text.slice(0, 200)}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
