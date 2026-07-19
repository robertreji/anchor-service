import * as StellarSdk from "@stellar/stellar-sdk";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";
const DIST_SECRET = process.env.ANCHOR_DISTRIBUTION_SECRET || "SCD63ZJ2DNEDU5RO5F7S245PYE5DNI3KNIKOOVLY3GZRHIUC3HNWLKHZ";
const USDC_ISSUER = process.env.NEXT_PUBLIC_USDC_ISSUER || "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BANK_URL = process.env.BANK_URL || "https://localhost:3001";
const BANK_API_KEY = process.env.BANK_API_KEY || "";

const CURSOR_FILE = path.join(process.cwd(), "last_synced_payment_id.txt");

// Initialize Supabase Client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// Initialize Horizon
const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);

// Derive Anchor public address
const distKeypair = StellarSdk.Keypair.fromSecret(DIST_SECRET);
const anchorAddress = distKeypair.publicKey();

// Save cursor to file
function saveCursor(cursor: string) {
  try {
    fs.writeFileSync(CURSOR_FILE, cursor, "utf8");
  } catch (err) {
    console.error("[payment-watcher] Failed to write cursor to file:", err);
  }
}

// Load cursor from file
function loadCursor(): string {
  try {
    if (fs.existsSync(CURSOR_FILE)) {
      return fs.readFileSync(CURSOR_FILE, "utf8").trim();
    }
  } catch (err) {
    console.error("[payment-watcher] Failed to read cursor from file:", err);
  }
  return "";
}

// Parse account prefix from UPI ID. E.g. "robert@stellarbank" -> "robert"
function parseAccountId(upiId: string): string {
  const clean = upiId.trim();
  if (clean.includes("@")) {
    return clean.split("@")[0].toLowerCase();
  }
  return clean.toLowerCase();
}

async function processPayment(payment: any) {
  const txHash = payment.transaction_hash;
  const amount = payment.amount;
  const assetCode = payment.asset_code;
  const assetIssuer = payment.asset_issuer;

  console.log(`[payment-watcher] Checking payment ${payment.id} in tx ${txHash}...`);

  // Verify it is USDC issued by our issuer
  if (assetCode !== "USDC" || assetIssuer !== USDC_ISSUER) {
    console.log(`[payment-watcher] Skipping non-USDC or wrong issuer payment (Asset: ${assetCode}:${assetIssuer})`);
    return;
  }

  // Fetch transaction details to retrieve the memo
  let transaction: any;
  try {
    transaction = await horizon.transactions().transaction(txHash).call();
  } catch (err: any) {
    console.error(`[payment-watcher] Failed to fetch transaction ${txHash}:`, err.message);
    return;
  }

  const memo = transaction.memo;
  const memoType = transaction.memo_type;

  if (!memo || (memoType !== "text" && memoType !== "id")) {
    console.log(`[payment-watcher] Skipping payment: No valid text/id memo found in tx ${txHash}`);
    return;
  }

  const referenceId = memo.trim();
  console.log(`[payment-watcher] Found memo reference: ${referenceId} in tx ${txHash}`);

  // Query Supabase for a matching pending remittance transaction
  const { data: remittance, error: dbErr } = await supabase
    .from("remittance_transactions")
    .select("*")
    .eq("reference_id", referenceId)
    .maybeSingle();

  if (dbErr) {
    console.error(`[payment-watcher] DB query failed for reference ${referenceId}:`, dbErr);
    return;
  }

  if (!remittance) {
    console.log(`[payment-watcher] No pending remittance matches reference ID ${referenceId}`);
    return;
  }

  if (remittance.status !== "pending") {
    console.log(`[payment-watcher] Remittance ${referenceId} already in status '${remittance.status}'. Skipping.`);
    return;
  }

  // Double check transaction amount match to avoid underpayment attacks
  const expectedAmount = parseFloat(remittance.amount_usdc);
  const receivedAmount = parseFloat(amount);
  
  if (receivedAmount < expectedAmount) {
    console.warn(`[payment-watcher] WARNING: Received ${receivedAmount} USDC, but expected ${expectedAmount} USDC. Marking failed.`);
    await supabase
      .from("remittance_transactions")
      .update({
        status: "failed",
        stellar_tx_hash: txHash,
        completed_at: new Date().toISOString(),
      })
      .eq("reference_id", referenceId);
    return;
  }

  console.log(`[payment-watcher] Matching remittance found! Sender: ${remittance.sender_username}, Recipient VPA: ${remittance.recipient_upi}, Amount: ${expectedAmount} USDC`);

  // Transition status to payment_detected
  try {
    await supabase
      .from("remittance_transactions")
      .update({
        status: "payment_detected",
        stellar_tx_hash: txHash,
      })
      .eq("reference_id", referenceId);
    console.log(`[payment-watcher] Status transitioned to 'payment_detected'`);
  } catch (err) {
    console.error("[payment-watcher] Failed to update status to payment_detected:", err);
  }

  // Transition status to processing
  try {
    await supabase
      .from("remittance_transactions")
      .update({
        status: "processing",
      })
      .eq("reference_id", referenceId);
    console.log(`[payment-watcher] Status transitioned to 'processing'`);
  } catch (err) {
    console.error("[payment-watcher] Failed to update status to processing:", err);
  }

  // Execute payout via bank simulator
  const toAccountId = parseAccountId(remittance.recipient_upi);
  console.log(`[payment-watcher] Executing bank simulator payout of ${expectedAmount} USD from ACC_ANCHOR to ${toAccountId}...`);

  try {
    const response = await fetch(`${BANK_URL}/api/transfers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BANK_API_KEY ? { Authorization: `Bearer ${BANK_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        from_account: "ACC_ANCHOR",
        to_account: toAccountId,
        amount: expectedAmount,
        currency: "USD",
        reference_id: referenceId,
        idempotency_key: `rem-${referenceId}`,
      }),
    });

    const data = await response.json();

    if (!response.ok && response.status !== 409) {
      throw new Error(data.error || "Bank transfer failed");
    }

    console.log(`[payment-watcher] Bank payout successful! Transfer ID: ${data.transfer_id || "existing"}`);

    // Transition status to completed
    await supabase
      .from("remittance_transactions")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("reference_id", referenceId);
    console.log(`[payment-watcher] Remittance transaction ${referenceId} successfully completed!`);
  } catch (payoutErr: any) {
    console.error(`[payment-watcher] Payout execution failed for ${referenceId}:`, payoutErr.message);
    
    // Mark as failed
    await supabase
      .from("remittance_transactions")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
      })
      .eq("reference_id", referenceId);
  }
}

async function watchPayments() {
  try {
    let cursor = loadCursor();
    
    // If no cursor file exists, fetch the latest payment to start polling from
    if (!cursor) {
      console.log("[payment-watcher] No cursor found. Fetching latest payment as checkpoint...");
      const latestPayments = await horizon
        .payments()
        .forAccount(anchorAddress)
        .order("desc")
        .limit(1)
        .call();
      
      if (latestPayments.records.length > 0) {
        cursor = latestPayments.records[0].id;
        saveCursor(cursor);
        console.log(`[payment-watcher] Saved initial checkpoint cursor: ${cursor}`);
      }
    }

    console.log(`[payment-watcher] Checking for new payments to ${anchorAddress} from cursor: ${cursor || "none"}`);

    const paymentsBuilder = horizon
      .payments()
      .forAccount(anchorAddress)
      .order("asc");
    
    if (cursor) {
      paymentsBuilder.cursor(cursor);
    }

    const response = await paymentsBuilder.call();
    const records = response.records || [];

    if (records.length > 0) {
      console.log(`[payment-watcher] Found ${records.length} new payments to check.`);
      
      for (const record of records) {
        // Only check incoming payments of type "payment"
        if (record.type === "payment" && record.to === anchorAddress) {
          await processPayment(record);
        }
        cursor = record.id;
        saveCursor(cursor);
      }
    }
  } catch (error: any) {
    console.error("[payment-watcher] Error in payment watcher cycle:", error.message);
  }
}

// Polling interval (5 seconds)
const INTERVAL = 5000;
console.log(`========================================`);
console.log(`[payment-watcher] Daemon started.`);
console.log(`[payment-watcher] Anchor Address: ${anchorAddress}`);
console.log(`[payment-watcher] Monitoring USDC Issuer: ${USDC_ISSUER}`);
console.log(`[payment-watcher] Polling Horizon API every ${INTERVAL / 1000}s...`);
console.log(`========================================`);

setInterval(watchPayments, INTERVAL);

// Run immediately on boot
watchPayments();
