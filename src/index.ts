import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { getPendingWithdrawal, savePendingWithdrawal } from "./db";
import * as StellarSdk from "@stellar/stellar-sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3003;
const ANCHOR_API_KEY = process.env.ANCHOR_API_KEY;
const PLATFORM_API_URL = process.env.PLATFORM_API_URL || "http://localhost:8085";
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";
const DIST_SECRET = process.env.ANCHOR_DISTRIBUTION_SECRET;
if (!DIST_SECRET) {
  throw new Error("ANCHOR_DISTRIBUTION_SECRET environment variable is required");
}
const USDC_ISSUER = process.env.NEXT_PUBLIC_USDC_ISSUER || "GAJ553PWUPQDOJBP33JKEHXJXCGT5QTU7U245Y243MMQUA4QBQIJ55ND";

// Initialize horizon connection
const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);

// Middleware for service-to-service auth
function authenticate(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (ANCHOR_API_KEY) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.split(" ")[1] !== ANCHOR_API_KEY) {
      return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
    }
  }
  next();
}

// JSON-RPC helper for Platform API
async function callPlatformRpc(method: string, params: any) {
  console.log(`[anchor-service] Calling Platform RPC: ${method}`);
  const response = await fetch(PLATFORM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      {
        id: Math.random().toString(36).substring(2, 9),
        jsonrpc: "2.0",
        method,
        params,
      },
    ]),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Platform RPC error (${response.status}): ${errorText}`);
  }

  const json = await response.json();
  if (json[0]?.error) {
    throw new Error(`Platform RPC error payload: ${JSON.stringify(json[0].error)}`);
  }
  return json[0]?.result;
}

// 1. GET /api/anchor/transactions/:id
// Proxies transaction details from the Platform API
app.get("/api/anchor/transactions/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    console.log(`[anchor-service] Proxying getTransaction for ID: ${id}`);
    const platformRes = await fetch(`${PLATFORM_API_URL}/transactions/${encodeURIComponent(id)}`);
    if (!platformRes.ok) {
      const errText = await platformRes.text();
      return res.status(platformRes.status).json({ error: `Platform returned error: ${errText}` });
    }
    const data = await platformRes.json();
    return res.json(data);
  } catch (error: any) {
    console.error("Proxy platform transaction error:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch transaction details" });
  }
});

// 2. POST /api/anchor/transactions/deposit
// Transitions deposit status to pending_user_transfer_start
app.post("/api/anchor/transactions/deposit", authenticate, async (req, res) => {
  const { transactionId, amount, asset } = req.body;
  if (!transactionId || !amount || !asset) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const amountVal = parseFloat(amount);
    const fee = amountVal * 0.1;
    console.log(`[anchor-service] Deposit transition for tx ${transactionId}: requesting offchain funds...`);
    
    await callPlatformRpc("request_offchain_funds", {
      transaction_id: transactionId,
      message: "waiting on the user to transfer funds",
      amount_in: {
        asset: "iso4217:USD",
        amount: amountVal.toFixed(2),
      },
      amount_out: {
        asset,
        amount: (amountVal - fee).toFixed(2),
      },
      fee_details: {
        total: fee.toFixed(2),
        asset: "iso4217:USD",
      },
    });

    return res.json({ success: true, message: "Transaction state updated to pending_user_transfer_start." });
  } catch (error: any) {
    console.error("Platform RPC request_offchain_funds error:", error);
    return res.status(500).json({ error: error.message || "Failed to transition transaction state" });
  }
});

// 3. POST /api/anchor/transactions/withdraw
// Saves withdrawal mapping and transitions status to pending_user_transfer_start
app.post("/api/anchor/transactions/withdraw", authenticate, async (req, res) => {
  const { transactionId, bankAccountId, amount, asset } = req.body;
  if (!transactionId || !bankAccountId || !amount || !asset) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const amountVal = parseFloat(amount);
    const fee = amountVal * 0.1;
    
    // Save withdrawal mapping locally so withdraw-observer knows where to pay out the USD
    console.log(`[anchor-service] Saving withdrawal mapping: ${transactionId} -> account: ${bankAccountId}, amount: ${amountVal} USD`);
    savePendingWithdrawal(transactionId, bankAccountId, amountVal);

    // Call Platform RPC to transition state
    console.log(`[anchor-service] Withdrawal transition for tx ${transactionId}: requesting onchain funds...`);
    await callPlatformRpc("request_onchain_funds", {
      transaction_id: transactionId,
      message: "waiting on the user to transfer funds",
      amount_in: {
        asset,
        amount: amountVal.toFixed(2),
      },
      amount_out: {
        asset: "iso4217:USD",
        amount: (amountVal - fee).toFixed(2),
      },
      fee_details: {
        total: fee.toFixed(2),
        asset,
      },
    });

    return res.json({ success: true, message: "Withdrawal registered and transaction state updated." });
  } catch (error: any) {
    console.error("Platform RPC request_onchain_funds error:", error);
    return res.status(500).json({ error: error.message || "Failed to transition transaction state" });
  }
});

// 3.5. POST /api/anchor/transactions/onchain-received
// Transitions status to pending_anchor when on-chain funds are submitted by user
app.post("/api/anchor/transactions/onchain-received", authenticate, async (req, res) => {
  const { transactionId, stellarTxHash } = req.body;
  if (!transactionId || !stellarTxHash) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    console.log(`[anchor-service] Notifying Platform of onchain funds received for tx ${transactionId} (hash: ${stellarTxHash})...`);
    await callPlatformRpc("notify_onchain_funds_received", {
      transaction_id: transactionId,
      stellar_transaction_id: stellarTxHash,
      message: "On-chain funds received. Processing withdrawal payout.",
    });

    return res.json({ success: true, message: "Transaction state updated to pending_anchor." });
  } catch (error: any) {
    console.error("Platform RPC notify_onchain_funds_received error:", error);
    return res.status(500).json({ error: error.message || "Failed to notify onchain funds received" });
  }
});

// 4. POST /api/anchor/webhook
// Receives deposit transfer webhook from Bank, submits on-chain USDC payment
app.post("/api/anchor/webhook", authenticate, async (req, res) => {
  try {
    const { reference_id, amount, from_account } = req.body;
    console.log(`[anchor-service] Received deposit webhook for reference_id: ${reference_id}, amount: ${amount}, from: ${from_account}`);

    if (!reference_id) {
      return res.status(400).json({ error: "Missing reference_id" });
    }

    // A. Fetch transaction details from Platform
    let txData: any;
    try {
      const platformTxRes = await fetch(`${PLATFORM_API_URL}/transactions/${reference_id}`);
      if (!platformTxRes.ok) {
        throw new Error(`Platform returned status ${platformTxRes.status}`);
      }
      txData = await platformTxRes.json();
    } catch (err: any) {
      console.warn(`[anchor-service] WARNING: Transfer received with unknown transaction ID (reference_id): ${reference_id}`);
      return res.json({ success: true, warning: "Unknown transaction ID" });
    }

    // B. Prevent duplicate processing
    if (txData.status !== "incomplete" && txData.status !== "pending_user_transfer_start") {
      console.log(`[anchor-service] Transaction ${reference_id} is already in status '${txData.status}'. Skipping duplicate processing.`);
      return res.json({ success: true, message: "Transaction already processed" });
    }

    if (txData.kind !== "deposit") {
      console.warn(`[anchor-service] Expected deposit transaction, got kind: ${txData.kind}`);
      return res.status(400).json({ error: "Invalid transaction kind" });
    }

    const destinationAddress = txData.destination_account;
    if (!destinationAddress) {
      return res.status(400).json({ error: "No destination account specified in transaction" });
    }

    const amountUSDC = txData.amount_out?.amount;
    const assetString = txData.amount_out?.asset || txData.amount_expected?.asset || "";
    const usdcIssuer = assetString.split(":")[2] || USDC_ISSUER;

    if (!amountUSDC) {
      return res.status(400).json({ error: "Amount out (USDC) is not specified in transaction" });
    }

    console.log(`[anchor-service] Processing deposit payout of ${amountUSDC} USDC to ${destinationAddress}...`);

    // C. Transition Platform status to pending_anchor
    try {
      await callPlatformRpc("notify_offchain_funds_received", {
        transaction_id: reference_id,
        message: "Fiat funds received. Preparing USDC payment.",
      });
    } catch (err: any) {
      console.error("[anchor-service] Failed to transition to pending_anchor on Platform:", err.message);
    }

    // D. Send USDC on-chain
    let txHash = "";
    try {
      const keypair = StellarSdk.Keypair.fromSecret(DIST_SECRET);
      const sourceAccount = await horizon.loadAccount(keypair.publicKey());
      const usdcAsset = new StellarSdk.Asset("USDC", usdcIssuer);

      const networkPassphrase = HORIZON_URL.includes("testnet")
        ? StellarSdk.Networks.TESTNET
        : StellarSdk.Networks.PUBLIC;

      const fee = HORIZON_URL.includes("testnet")
        ? StellarSdk.BASE_FEE
        : "10000";

      const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: fee,
        networkPassphrase: networkPassphrase,
      });

      if (txData.memo) {
        let memoObj;
        if (txData.memo_type === "id") {
          memoObj = StellarSdk.Memo.id(txData.memo);
        } else if (txData.memo_type === "hash") {
          memoObj = StellarSdk.Memo.hash(txData.memo);
        } else {
          memoObj = StellarSdk.Memo.text(txData.memo);
        }
        builder.addMemo(memoObj);
      }

      builder.addOperation(
        StellarSdk.Operation.payment({
          destination: destinationAddress,
          asset: usdcAsset,
          amount: amountUSDC,
        })
      );

      const tx = builder.setTimeout(180).build();
      tx.sign(keypair);
      const submitRes = await horizon.submitTransaction(tx);
      txHash = submitRes.hash;
      console.log(`[anchor-service] Successfully submitted USDC payment. Tx Hash: ${txHash}`);
    } catch (err: any) {
      console.error("[anchor-service] Failed to send USDC payment on-chain:", err.message);
      if (err.response?.data) {
        console.error("[anchor-service] Horizon error details:", JSON.stringify(err.response.data, null, 2));
      }
      
      try {
        await callPlatformRpc("notify_transaction_error", {
          transaction_id: reference_id,
          message: `On-chain payout failed: ${err.message}`,
        });
      } catch (rpcErr) {
        console.error("[anchor-service] Failed to notify transaction error on Platform:", rpcErr);
      }

      return res.status(500).json({ error: `On-chain payment failed: ${err.message}` });
    }

    // E. Finalize Platform transaction to completed
    try {
      console.log(`[anchor-service] Transitioning deposit tx ${reference_id} to completed...`);
      await callPlatformRpc("notify_onchain_funds_sent", {
        transaction_id: reference_id,
        stellar_transaction_id: txHash,
      });
    } catch (err: any) {
      console.error("[anchor-service] Failed to mark transaction completed on Platform:", err.message);
    }

    return res.json({ success: true, txHash });
  } catch (error: any) {
    console.error("[anchor-service] Webhook endpoint error:", error);
    return res.status(500).json({ error: error.message || "Webhook processing failed" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`[anchor-service] Standalone Anchor Service listening on port ${PORT}`);
  console.log(`[anchor-service] Horizon URL: ${HORIZON_URL}`);
  console.log(`[anchor-service] Platform API URL: ${PLATFORM_API_URL}`);
  console.log(`========================================`);
});

// Import and start withdrawal observer background loop
import "./withdraw-observer";

// Import and start remittance payment watcher background loop
import "./payment-watcher";
// Touch to reload nodemon config
