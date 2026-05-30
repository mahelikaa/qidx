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

const SETTLEMENT_PROGRAM_ID =
  process.env.SETTLEMENT_PROGRAM_ID ||
  "8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy";

const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const conn = new Connection(RPC_URL, "confirmed");

// sha256("global:<name>")[0..8]
function anchorDisc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
const SETTLE_BATCH_DISC = anchorDisc("settle_batch");

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

function decodeSettleBatch(buf, remainingAccounts) {
  if (buf.length < 12) return { instruction: "settle_batch", error: "too short" };

  const nTrades = buf.readUInt32LE(8);
  const trades = [];
  let offset = 12;

  for (let i = 0; i < nTrades; i++) {
    if (offset + 16 > buf.length) break;
    trades.push({
      base_amount: buf.readBigUInt64LE(offset).toString(),
      quote_amount: buf.readBigUInt64LE(offset + 8).toString(),
    });
    offset += 16;
  }

  // authority(0), token_program(1), then 4 accounts per trade
  const accs = remainingAccounts.slice(2);
  for (let i = 0; i < trades.length && i < accs.length / 4; i++) {
    trades[i].maker_base  = accs[i * 4]?.toString();
    trades[i].taker_base  = accs[i * 4 + 1]?.toString();
    trades[i].taker_quote = accs[i * 4 + 2]?.toString();
    trades[i].maker_quote = accs[i * 4 + 3]?.toString();
  }

  return { instruction: "settle_batch", program: SETTLEMENT_PROGRAM_ID, trade_count: nTrades, trades };
}

function decodeTokenTransfer(buf) {
  if (buf.length < 9) return null;
  return { instruction: "transfer", amount: buf.readBigUInt64LE(1).toString() };
}

function decodeInstruction(buf, programId, remainingAccounts) {
  if (!buf || buf.length === 0)
    return { instruction: "unknown", program: programId, reason: "empty data" };

  if (programId === SETTLEMENT_PROGRAM_ID && bufStartsWith(buf, SETTLE_BATCH_DISC))
    return decodeSettleBatch(buf, remainingAccounts);

  if ((programId === SPL_TOKEN || programId === TOKEN_2022) && buf[0] === 3)
    return decodeTokenTransfer(buf);

  return {
    instruction: "unknown",
    program: programId,
    discriminator: buf[0],
    data_hex: buf.toString("hex").slice(0, 32) + (buf.length > 16 ? "..." : ""),
  };
}

function decodeTransaction(tx, signature) {
  const accountKeys = getAccountKeys(tx);
  const msg = tx.transaction.message;
  const decoded = [];

  const programIdAt = (idx) => accountKeys[idx] ?? "(unknown)";

  for (const ix of msg.compiledInstructions ?? msg.instructions ?? []) {
    const buf = toBuffer(ix.data);
    const programId = programIdAt(ix.programIdIndex);
    const ixAccounts = (ix.accountKeyIndexes ?? ix.accounts ?? []).map((idx) => accountKeys[idx]);
    decoded.push(decodeInstruction(buf, programId, ixAccounts));
  }

  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) {
      decoded.push(decodeInstruction(toBuffer(ix.data), programIdAt(ix.programIdIndex), []));
    }
  }

  const preBal = tx.meta?.preTokenBalances ?? [];
  const balanceChanges = (tx.meta?.postTokenBalances ?? []).reduce((acc, post) => {
    const pre = preBal.find((p) => p.accountIndex === post.accountIndex);
    const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? "0");
    const postAmt = BigInt(post.uiTokenAmount?.amount ?? "0");
    if (preAmt !== postAmt) {
      acc.push({
        account: accountKeys[post.accountIndex],
        mint: post.mint,
        change: (postAmt - preAmt).toString(),
        pre: preAmt.toString(),
        post: postAmt.toString(),
      });
    }
    return acc;
  }, []);

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

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version, program: SETTLEMENT_PROGRAM_ID, cluster: RPC_URL.includes("devnet") ? "devnet" : "mainnet" });
});

app.get("/tx/:signature", async (req, res) => {
  const { signature } = req.params;

  if (!signature || signature.length < 80 || signature.length > 100)
    return res.status(400).json({ error: "Invalid signature format" });

  let tx;
  try {
    tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx) {
      await new Promise((r) => setTimeout(r, 500));
      tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    }
  } catch (e) {
    return res.status(502).json({ error: "RPC error", detail: e.message });
  }

  if (!tx) return res.status(404).json({ error: "Transaction not found", signature });

  try {
    res.json(decodeTransaction(tx, signature));
  } catch (e) {
    res.status(500).json({ error: "Decode error", detail: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`qidx running on http://localhost:${PORT}`);
});
