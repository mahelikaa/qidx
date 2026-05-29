// index.js — qidx REST API
// GET /tx/:signature  → returns fully decoded transaction JSON
//                        Knows about: settle_batch, SPL token transfers
// GET /health         → { status, version, program }
require("dotenv").config();

const express = require("express");
const { Connection } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const crypto = require("crypto");
const { version } = require("./package.json");

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("❌  RPC_URL not set. Add it to your .env file.");
  process.exit(1);
}

// The deployed settlement program
const SETTLEMENT_PROGRAM_ID =
  process.env.SETTLEMENT_PROGRAM_ID ||
  "8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy";

const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const conn = new Connection(RPC_URL, "confirmed");

// Anchor discriminator = sha256("global:<instruction_name>")[0..8]
function anchorDisc(name) {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
}
const SETTLE_BATCH_DISC = anchorDisc("settle_batch");

// ---------- Buffer helpers ----------

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") {
    try { return Buffer.from(bs58.decode(data)); } catch { return null; }
  }
  return null;
}

function bufStartsWith(buf, prefix) {
  if (!buf || buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

// ---------- Account key resolver ----------

function getAccountKeys(tx) {
  const msg = tx.transaction.message;
  if (msg.staticAccountKeys) {
    const keys = [...msg.staticAccountKeys.map((k) => k.toBase58())];
    const loaded = tx.meta?.loadedAddresses;
    if (loaded) {
      keys.push(...(loaded.writable?.map((k) => k.toBase58()) ?? []));
      keys.push(...(loaded.readonly?.map((k) => k.toBase58()) ?? []));
    }
    return keys;
  }
  return msg.accountKeys.map((k) => (typeof k === "string" ? k : k.toBase58()));
}

// ---------- Instruction decoders ----------

/**
 * Decode a settle_batch instruction.
 * Wire format (after 8-byte Anchor discriminator):
 *   [0..3]  u32 LE  number of trades (Borsh Vec length)
 *   then N × {
 *     [0..7]   u64 LE  base_amount
 *     [8..15]  u64 LE  quote_amount
 *   }
 */
function decodeSettleBatch(buf, accountKeys, programIndex, remainingAccounts) {
  if (buf.length < 12) return { instruction: "settle_batch", error: "too short" };

  const nTrades = buf.readUInt32LE(8); // 8 = skip discriminator
  const trades = [];
  let offset = 12; // 8 disc + 4 vec length

  for (let i = 0; i < nTrades; i++) {
    if (offset + 16 > buf.length) break;
    trades.push({
      base_amount: buf.readBigUInt64LE(offset).toString(),
      quote_amount: buf.readBigUInt64LE(offset + 8).toString(),
    });
    offset += 16;
  }

  // Resolve token account addresses from remaining accounts
  // Layout: authority(0), token_program(1), then 4×N trade accounts
  const tradeAccounts = remainingAccounts.slice(2);
  for (let i = 0; i < trades.length && i < tradeAccounts.length / 4; i++) {
    trades[i].maker_base  = tradeAccounts[i * 4]?.toString();
    trades[i].taker_base  = tradeAccounts[i * 4 + 1]?.toString();
    trades[i].taker_quote = tradeAccounts[i * 4 + 2]?.toString();
    trades[i].maker_quote = tradeAccounts[i * 4 + 3]?.toString();
  }

  return {
    instruction: "settle_batch",
    program: SETTLEMENT_PROGRAM_ID,
    trade_count: nTrades,
    trades,
  };
}

/**
 * Decode a generic SPL Token transfer (discriminator = 3).
 * [0]     u8   disc (3)
 * [1..8]  u64 LE amount
 */
function decodeTokenTransfer(buf, accountKeys, ix) {
  if (buf.length < 9) return null;
  const amount = buf.readBigUInt64LE(1);
  // For legacy instructions, accountKeys are referenced by index in ix.accounts
  return {
    instruction: "transfer",
    amount: amount.toString(),
  };
}

function decodeInstruction(buf, accountKeys, programId, remainingAccounts) {
  if (!buf || buf.length === 0)
    return { instruction: "unknown", program: programId, reason: "empty data" };

  // Check for settle_batch first (8-byte Anchor discriminator)
  if (programId === SETTLEMENT_PROGRAM_ID && bufStartsWith(buf, SETTLE_BATCH_DISC)) {
    return decodeSettleBatch(buf, accountKeys, null, remainingAccounts);
  }

  // SPL token disc=3 → transfer
  if ((programId === SPL_TOKEN || programId === TOKEN_2022) && buf[0] === 3) {
    return decodeTokenTransfer(buf, accountKeys, null);
  }

  return {
    instruction: "unknown",
    program: programId,
    discriminator: buf[0],
    data_hex: buf.toString("hex").slice(0, 32) + (buf.length > 16 ? "..." : ""),
  };
}

// ---------- Full transaction decoder ----------

function decodeTransaction(tx, signature) {
  const accountKeys = getAccountKeys(tx);
  const msg = tx.transaction.message;
  const decoded = [];

  function programIdAt(idx) {
    return accountKeys[idx] ?? "(unknown)";
  }

  const outerIxs = msg.compiledInstructions ?? msg.instructions ?? [];
  for (const ix of outerIxs) {
    const buf = toBuffer(ix.data);
    const programId = programIdAt(ix.programIdIndex);
    // Pass all account keys so settle_batch decoder can resolve them
    const ixAccounts = (ix.accountKeyIndexes ?? ix.accounts ?? []).map(
      (idx) => accountKeys[idx]
    );
    decoded.push(decodeInstruction(buf, accountKeys, programId, ixAccounts));
  }

  // Inner instructions
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) {
      const buf = toBuffer(ix.data);
      const programId = programIdAt(ix.programIdIndex);
      decoded.push(decodeInstruction(buf, accountKeys, programId, []));
    }
  }

  // Token balance changes
  const balanceChanges = [];
  const preBal = tx.meta?.preTokenBalances ?? [];
  const postBal = tx.meta?.postTokenBalances ?? [];
  for (const post of postBal) {
    const pre = preBal.find((p) => p.accountIndex === post.accountIndex);
    const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? "0");
    const postAmt = BigInt(post.uiTokenAmount?.amount ?? "0");
    if (preAmt !== postAmt) {
      balanceChanges.push({
        account: accountKeys[post.accountIndex],
        mint: post.mint,
        change: (postAmt - preAmt).toString(),
        pre: preAmt.toString(),
        post: postAmt.toString(),
      });
    }
  }

  return {
    signature,
    slot: tx.slot,
    timestamp: tx.blockTime ?? null,
    fee: tx.meta?.fee ?? null,
    compute_units_used: tx.meta?.computeUnitsConsumed ?? null,
    instructions: decoded,
    token_balance_changes: balanceChanges,
  };
}

// ---------- Express app ----------

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version,
    program: SETTLEMENT_PROGRAM_ID,
    cluster: RPC_URL.includes("devnet") ? "devnet" : "mainnet",
  });
});

app.get("/tx/:signature", async (req, res) => {
  const { signature } = req.params;

  if (!signature || signature.length < 80 || signature.length > 100) {
    return res.status(400).json({ error: "Invalid signature format" });
  }

  let tx;
  try {
    tx = await conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) {
      await new Promise((r) => setTimeout(r, 500));
      tx = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    }
  } catch (e) {
    return res.status(502).json({ error: "RPC error", detail: e.message });
  }

  if (!tx) {
    return res.status(404).json({ error: "Transaction not found", signature });
  }

  try {
    const result = decodeTransaction(tx, signature);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "Decode error", detail: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ qidx REST API running on http://localhost:${PORT}`);
  console.log(`   GET /tx/:signature   — decode any settlement transaction`);
  console.log(`   GET /health          — service info\n`);
  console.log(`   Tracking program: ${SETTLEMENT_PROGRAM_ID}`);
  console.log(`   RPC: ${RPC_URL}\n`);
});
