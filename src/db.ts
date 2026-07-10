import Database from "better-sqlite3";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const DB_FILE = process.env.DB_PATH || "anchor.db";
const DB_PATH = path.isAbsolute(DB_FILE) ? DB_FILE : path.join(process.cwd(), DB_FILE);

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_withdrawals (
        transaction_id TEXT PRIMARY KEY,
        bank_account_id TEXT NOT NULL,
        amount REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pending_withdrawals_id ON pending_withdrawals(transaction_id);
    `);
    console.log(`[anchor-service] Connected to SQLite DB: ${DB_PATH}`);
  }
  return db;
}

export interface PendingWithdrawal {
  transaction_id: string;
  bank_account_id: string;
  amount: number;
  created_at: string;
}

export function savePendingWithdrawal(
  transactionId: string,
  bankAccountId: string,
  amount: number
): void {
  const database = getDb();
  database
    .prepare(
      "INSERT OR REPLACE INTO pending_withdrawals (transaction_id, bank_account_id, amount) VALUES (?, ?, ?)"
    )
    .run(transactionId, bankAccountId, amount);
}

export function getPendingWithdrawal(transactionId: string): PendingWithdrawal | null {
  const database = getDb();
  try {
    const row = database
      .prepare("SELECT * FROM pending_withdrawals WHERE transaction_id = ?")
      .get(transactionId) as PendingWithdrawal | undefined;
    return row || null;
  } catch {
    return null;
  }
}

export function deletePendingWithdrawal(transactionId: string): void {
  const database = getDb();
  try {
    database.prepare("DELETE FROM pending_withdrawals WHERE transaction_id = ?").run(transactionId);
  } catch (err: any) {
    console.error(`[anchor-service] Failed to delete pending withdrawal ${transactionId}:`, err.message);
  }
}
