// decode-batch.js
// Correctly decodes p-token Batch / WithdrawExcessLamports / UnwrapLamports
// transactions directly from the Solana RPC — no Helius enrichment layer.
//
// Batch instruction wire format (SIMD-0266):
//   [0]      u8       discriminator (22)
//   [1..2]   u16 LE   number of transfers (N)
//   then N × TransferEntry:
//     [0..3]  u32 LE  source account index (into tx.message.accountKeys)
//     [4..7]  u32 LE  destination account index
//     [8..15] u64 LE  amount (lamports / token smallest unit)
//
// WithdrawExcessLamports (23):
//   [0]     u8  discriminator
//   [1..4]  u32 source account index
//   [5..8]  u32 destination account index
//
// UnwrapLamports (24):
//   [0]     u8  discriminator
//   [1..4]  u32 account index
//   [5..8]  u32 destination account index
require("dotenv").config();

const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58").default;

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("❌  RPC_URL not set.");
  process.exit(1);
}

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") {
    try { return Buffer.from(bs58.decode(data)); } catch { return null; }
  }
  return null;
}

// Resolve account keys (handles versioned address lookup tables too)
function getAccountKeys(tx) {
  const msg = tx.transaction.message;
  // Versioned message exposes staticAccountKeys + loaded accounts
  if (msg.staticAccountKeys) {
    const keys = [...msg.staticAccountKeys.map((k) => k.toBase58())];
    // Add loaded writable + readonly from address lookup tables
    const loaded = tx.meta?.loadedAddresses;
    if (loaded) {
      keys.push(...(loaded.writable?.map((k) => k.toBase58()) ?? []));
      keys.push(...(loaded.readonly?.map((k) => k.toBase58()) ?? []));
    }
    return keys;
  }
  // Legacy message
  return msg.accountKeys.map((k) =>
    typeof k === "string" ? k : (k.toBase58?.() ?? String(k))
  );
}

// ---------- Instruction decoders ----------

function decodeBatch(buf, accountKeys) {
  if (buf.length < 3) return null;
  const nTransfers = buf.readUInt16LE(1);
  const transfers = [];
  let offset = 3;

  for (let i = 0; i < nTransfers; i++) {
    if (offset + 16 > buf.length) break;
    const srcIdx = buf.readUInt32LE(offset);
    const dstIdx = buf.readUInt32LE(offset + 4);
    // u64 — JS BigInt to avoid precision loss
    const amount = buf.readBigUInt64LE(offset + 8);
    transfers.push({
      from: accountKeys[srcIdx] ?? `account[${srcIdx}]`,
      to: accountKeys[dstIdx] ?? `account[${dstIdx}]`,
      amount: amount.toString(),
    });
    offset += 16;
  }

  return {
    instruction: "batch",
    transfer_count: nTransfers,
    transfers,
  };
}

function decodeWithdrawExcessLamports(buf, accountKeys) {
  if (buf.length < 9) return null;
  const srcIdx = buf.readUInt32LE(1);
  const dstIdx = buf.readUInt32LE(5);
  return {
    instruction: "withdraw_excess_lamports",
    source: accountKeys[srcIdx] ?? `account[${srcIdx}]`,
    destination: accountKeys[dstIdx] ?? `account[${dstIdx}]`,
  };
}

function decodeUnwrapLamports(buf, accountKeys) {
  if (buf.length < 9) return null;
  const accIdx = buf.readUInt32LE(1);
  const dstIdx = buf.readUInt32LE(5);
  return {
    instruction: "unwrap_lamports",
    account: accountKeys[accIdx] ?? `account[${accIdx}]`,
    destination: accountKeys[dstIdx] ?? `account[${dstIdx}]`,
  };
}

function decodeInstruction(buf, accountKeys, programId) {
  if (!buf || buf.length === 0) {
    return {
      instruction: "unknown",
      program: programId,
      reason: "empty data",
    };
  }

  const disc = buf[0];

  if (programId === TOKEN_2022) {
    if (disc === 22) return decodeBatch(buf, accountKeys);
    if (disc === 23) return decodeWithdrawExcessLamports(buf, accountKeys);
    if (disc === 12) return decodeUnwrapLamports(buf, accountKeys);
  }

  // Unknown: emit raw rather than silently drop
  return {
    instruction: "unknown",
    program: programId,
    discriminator: disc,
    data_b58: bs58.encode(buf).slice(0, 64) + (buf.length > 48 ? "..." : ""),
  };
}

// ---------- Main decoder ----------

function decodeTransaction(tx, signature) {
  const accountKeys = getAccountKeys(tx);
  const msg = tx.transaction.message;
  const decoded = [];

  // Helper: resolve programId by index
  function programIdAt(idx) {
    return accountKeys[idx] ?? "(unknown)";
  }

  // Outer instructions
  const outerIxs = msg.compiledInstructions ?? msg.instructions ?? [];
  for (const ix of outerIxs) {
    const buf = toBuffer(ix.data);
    const programId = programIdAt(ix.programIdIndex);
    if (programId === TOKEN_2022 || buf?.[0] >= 22) {
      decoded.push(decodeInstruction(buf, accountKeys, programId));
    }
  }

  // Inner instructions
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) {
      const buf = toBuffer(ix.data);
      const programId = programIdAt(ix.programIdIndex);
      if (programId === TOKEN_2022) {
        decoded.push(decodeInstruction(buf, accountKeys, programId));
      }
    }
  }

  // Token balance changes from meta
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

// ---------- Entry point ----------

async function main() {
  const useFixture = process.argv.includes("--fixture");
  let signature = process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]);

  let saved;
  if (!signature) {
    try {
      saved = JSON.parse(require("fs").readFileSync(".batch-sig.txt", "utf8"));
      signature = saved.signature;
      console.error(`ℹ️  Using saved signature: ${signature}\n`);
    } catch {
      console.error(
        "Usage: node decode-batch.js <signature>\n" +
          "  or:  node decode-batch.js --fixture   (use local mock tx)\n" +
          "  or:  run find-batch-tx.js first."
      );
      process.exit(1);
    }
  }

  let tx;
  // If fixture flag set OR saved fixture flag is true, load from .mock-tx.json
  if (useFixture || saved?.fixture) {
    try {
      tx = JSON.parse(require("fs").readFileSync(".mock-tx.json", "utf8"));
      // staticAccountKeys are plain strings in fixture — wrap with toBase58()
      if (tx.transaction.message.staticAccountKeys) {
        tx.transaction.message.staticAccountKeys =
          tx.transaction.message.staticAccountKeys.map((k) => {
            const addr = typeof k === "string" ? k : (k.toBase58?.() ?? String(k));
            return { toBase58: () => addr };
          });
      }
      // Restore compiledInstructions[].data from hex (Buffer.from drops cleanly)
      for (const ix of tx.transaction.message.compiledInstructions ?? []) {
        if (ix.dataHex) {
          ix.data = Buffer.from(ix.dataHex, "hex");
          delete ix.dataHex;
        } else if (ix.data && !Buffer.isBuffer(ix.data)) {
          // fallback: Buffer JSON serializes as {type:'Buffer',data:[...]}
          ix.data = Buffer.from(ix.data.data ?? Object.values(ix.data));
        }
      }
      console.error("ℹ️  Loaded fixture from .mock-tx.json\n");
    } catch (e) {
      console.error("❌  Fixture not found. Run: node make-fixture.js first.");
      process.exit(1);
    }
  } else {
    const conn = new Connection(RPC_URL, "confirmed");
    try {
      tx = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch (e) {
      await new Promise((r) => setTimeout(r, 500));
      tx = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    }
  }

  if (!tx) {
    console.error("❌  Transaction not found:", signature);
    process.exit(1);
  }

  const result = decodeTransaction(tx, signature);

  console.log("=".repeat(72));
  console.log("qidx DECODED OUTPUT");
  console.log("=".repeat(72));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
