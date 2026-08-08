import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";
import initSqlJs from "sql.js";

export interface LocalConversation {
  id: string;
  title: string;
  mode: string;
  is_pinned: boolean;
  is_archived: boolean;
  tokens_input: number;
  tokens_output: number;
  cost: number;
  forked_from: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface LocalMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ExportData {
  conversation: {
    title: string;
    mode: string;
  };
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

const _SCHEMA_VERSION = 2;

export class SessionStore {
  private db: any = null;
  private dbPath = "";

  async init(): Promise<void> {
    const paths = envPaths("astrivya", { suffix: "" });
    const configDir = paths.config;
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    this.dbPath = path.join(configDir, "sessions.db");

    const SQL = await initSqlJs();
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
      this.runMigrations();
    } else {
      this.db = new SQL.Database();
      this.createSchemaV2();
      this.saveToDisk();
    }
  }

  private createSchemaV2(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Conversation',
        mode TEXT DEFAULT 'thinking',
        is_pinned INTEGER DEFAULT 0,
        is_archived INTEGER DEFAULT 0,
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        cost REAL DEFAULT 0.0,
        forked_from TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS _meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.db.run(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '2')`);
  }

  private runMigrations(): void {
    let version = 1;
    const rows = this.db.exec("SELECT value FROM _meta WHERE key = 'schema_version'");
    if (rows.length > 0 && rows[0].values.length > 0) {
      version = Number.parseInt(rows[0].values[0][0] as string, 10) || 1;
    }

    if (version < 2) {
      const tableInfo = this.db.exec("PRAGMA table_info(conversations)");
      const existingCols = new Set<string>();
      if (tableInfo.length > 0) {
        for (const row of tableInfo[0].values) {
          existingCols.add(row[1] as string);
        }
      }
      if (!existingCols.has("tokens_input")) {
        this.db.run("ALTER TABLE conversations ADD COLUMN tokens_input INTEGER DEFAULT 0");
      }
      if (!existingCols.has("tokens_output")) {
        this.db.run("ALTER TABLE conversations ADD COLUMN tokens_output INTEGER DEFAULT 0");
      }
      if (!existingCols.has("cost")) {
        this.db.run("ALTER TABLE conversations ADD COLUMN cost REAL DEFAULT 0.0");
      }
      if (!existingCols.has("forked_from")) {
        this.db.run("ALTER TABLE conversations ADD COLUMN forked_from TEXT");
      }
      if (!existingCols.has("_meta")) {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS _meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
      }
      this.db.run(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '2')`);
      this.saveToDisk();
    }
  }

  private saveToDisk(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  private runQuery(sql: string, params: any[] = []): any[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private uuid(): string {
    return crypto.randomUUID();
  }

  private rowToConversation(r: any): LocalConversation {
    return {
      id: r.id,
      title: r.title,
      mode: r.mode,
      is_pinned: !!r.is_pinned,
      is_archived: !!r.is_archived,
      tokens_input: r.tokens_input ?? 0,
      tokens_output: r.tokens_output ?? 0,
      cost: r.cost ?? 0.0,
      forked_from: r.forked_from ?? null,
      message_count: r.message_count ?? 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  async listConversations(): Promise<LocalConversation[]> {
    const rows = this.runQuery(
      `SELECT c.id, c.title, c.mode, c.is_pinned, c.is_archived,
              c.tokens_input, c.tokens_output, c.cost, c.forked_from,
              c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       WHERE c.is_archived = 0
       ORDER BY c.is_pinned DESC, c.updated_at DESC`,
    );
    return rows.map((r) => this.rowToConversation(r));
  }

  async getConversation(id: string): Promise<{ conversation: LocalConversation; messages: LocalMessage[] }> {
    const convRows = this.runQuery(
      `SELECT c.id, c.title, c.mode, c.is_pinned, c.is_archived,
              c.tokens_input, c.tokens_output, c.cost, c.forked_from,
              c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c WHERE c.id = ?`,
      [id],
    );
    if (convRows.length === 0) throw new Error(`Session not found: ${id}`);
    const conversation = this.rowToConversation(convRows[0]);

    const msgRows = this.runQuery(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages WHERE conversation_id = ?
       ORDER BY created_at ASC`,
      [id],
    );
    const messages: LocalMessage[] = msgRows.map((r: any) => ({
      id: r.id,
      conversation_id: r.conversation_id,
      role: r.role as "user" | "assistant",
      content: r.content,
      created_at: r.created_at,
    }));

    return { conversation, messages };
  }

  async createConversation(title: string, forkedFrom?: string): Promise<LocalConversation> {
    const id = this.uuid();
    const now = this.now();
    this.db.run(
      `INSERT INTO conversations (id, title, mode, is_pinned, is_archived, tokens_input, tokens_output, cost, forked_from, created_at, updated_at)
       VALUES (?, ?, 'thinking', 0, 0, 0, 0, 0.0, ?, ?, ?)`,
      [id, title, forkedFrom || null, now, now],
    );
    this.saveToDisk();
    return {
      id,
      title,
      mode: "thinking",
      is_pinned: false,
      is_archived: false,
      tokens_input: 0,
      tokens_output: 0,
      cost: 0.0,
      forked_from: forkedFrom || null,
      message_count: 0,
      created_at: now,
      updated_at: now,
    };
  }

  async updateConversation(
    id: string,
    updates: Partial<Pick<LocalConversation, "title" | "mode" | "is_pinned" | "is_archived">>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [];
    if (updates.title !== undefined) {
      sets.push("title = ?");
      params.push(updates.title);
    }
    if (updates.mode !== undefined) {
      sets.push("mode = ?");
      params.push(updates.mode);
    }
    if (updates.is_pinned !== undefined) {
      sets.push("is_pinned = ?");
      params.push(updates.is_pinned ? 1 : 0);
    }
    if (updates.is_archived !== undefined) {
      sets.push("is_archived = ?");
      params.push(updates.is_archived ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(this.now());
    params.push(id);
    this.db.run(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, params);
    this.saveToDisk();
  }

  async updateTokens(id: string, input: number, output: number, cost: number): Promise<void> {
    this.db.run(
      "UPDATE conversations SET tokens_input = tokens_input + ?, tokens_output = tokens_output + ?, cost = cost + ?, updated_at = ? WHERE id = ?",
      [input, output, cost, this.now(), id],
    );
    this.saveToDisk();
  }

  async deleteConversation(id: string): Promise<void> {
    this.db.run("DELETE FROM messages WHERE conversation_id = ?", [id]);
    this.db.run("DELETE FROM conversations WHERE id = ?", [id]);
    this.saveToDisk();
  }

  async addMessage(conversationId: string, role: "user" | "assistant", content: string): Promise<LocalMessage> {
    const id = this.uuid();
    const now = this.now();
    this.db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, conversationId, role, content, now],
    );
    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, conversationId]);
    this.saveToDisk();
    return { id, conversation_id: conversationId, role, content, created_at: now };
  }

  async exportConversation(id: string): Promise<ExportData> {
    const { conversation, messages } = await this.getConversation(id);
    return {
      conversation: {
        title: conversation.title,
        mode: conversation.mode,
      },
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
  }

  async importConversation(data: ExportData): Promise<LocalConversation> {
    const conv = await this.createConversation(data.conversation.title);
    if (data.conversation.mode && data.conversation.mode !== "thinking") {
      await this.updateConversation(conv.id, { mode: data.conversation.mode });
    }
    for (const msg of data.messages) {
      await this.addMessage(conv.id, msg.role, msg.content);
    }
    return conv;
  }

  async forkConversation(sourceId: string, newTitle?: string): Promise<LocalConversation> {
    const { conversation, messages } = await this.getConversation(sourceId);
    const title = newTitle || `${conversation.title} (fork)`;
    const fork = await this.createConversation(title, sourceId);
    for (const msg of messages) {
      await this.addMessage(fork.id, msg.role, msg.content);
    }
    return fork;
  }

  close(): void {
    if (this.db) {
      this.saveToDisk();
      this.db.close();
      this.db = null;
    }
  }

  countMessages(conversationId: string): number {
    const rows = this.runQuery("SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?", [conversationId]);
    return rows[0]?.cnt ?? 0;
  }
}

let _instance: SessionStore | null = null;

export async function getSessionStore(): Promise<SessionStore> {
  if (!_instance) {
    _instance = new SessionStore();
    await _instance.init();
  }
  return _instance;
}
