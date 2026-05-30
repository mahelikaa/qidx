require("dotenv").config();

const { Connection } = require("@solana/web3.js");
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
  return msg.accountKeys.map((k) =>
    typeof k === "string" ? k : (k.toBase58?.() ?? String(k))
  );
}

function decodeBatch(buf, accountKeys) {
  if (buf.length < 3) return null;
  const nTransfers = buf.readUInt16LE(1);
  const transfers = [];
  let offset = 3;
  for (let i = 0; i < nTransfers; i++) {
    if (offset + 16 > buf.length) break;
    transfers.push({
      from: accountKeys[buf.readUInt32LE(offset)] ?? `account[${buf.readUInt32LE(offset)}]`,
      to: accountKeys[buf.readUInt32LE(offset + 4)] ?? `account[${buf.readUInt32LE(offset + 4)}]`,
      amount: buf.readBigUInt64LE(offset + 8).toString(),
    });
    offset += 16;
  }
  return { instruction: "batch", transfer_count: nTransfers, transfers };
}

function decodeWithdrawExcessLamports(buf, accountKeys) {
  if (buf.length < 9) return null;
  return {
    instruction: "withdraw_excess_lamports",
    source: accountKeys[buf.readUInt32LE(1)] ?? `account[${buf.readUInt32LE(1)}]`,
    destination: accountKeys[buf.readUInt32LE(5)] ?? `account[${buf.readUInt32LE(5)}]`,
  };
}

function decodeUnwrapLamports(buf, accountKeys) {
  if (buf.length < 9) return null;
  return {
    instruction: "unwrap_lamports",
    account: accountKeys[buf.readUInt32LE(1)] ?? `account[${buf.readUInt32LE(1)}]`,
    destination: accountKeys[buf.readUInt32LE(5)] ?? `account[${buf.readUInt32LE(5)}]`,
  };
}

function decodeInstruction(buf, accountKeys, programId) {
  if (!buf || buf.length === 0)
    return { instruction: "unknown", program: programId, reason: "empty data" };

  const disc = buf[0];
  if (programId === TOKEN_2022) {
    if (disc === 22) return decodeBatch(buf, accountKeys);
    if (disc === 23) return decodeWithdrawExcessLamports(buf, accountKeys);
    if (disc === 12) return decodeUnwrapLamports(buf, accountKeys);
  }

  return {
    instruction: "unknown",
    program: programId,
    discriminator: disc,
    data_b58: bs58.encode(buf).slice(0, 64) + (buf.length > 48 ? "..." : ""),
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
    if (programId === TOKEN_2022 || buf?.[0] >= 22) {
      decoded.push(decodeInstruction(buf, accountKeys, programId));
    }
  }

  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) {
      const buf = toBuffer(ix.data);
      const programId = programIdAt(ix.programIdIndex);
      if (programId === TOKEN_2022) {
        decoded.push(decodeInstruction(buf, accountKeys, programId));
      }
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
      console.error("Usage: node decode-batch.js <signature>\n  or:  node decode-batch.js --fixture");
      process.exit(1);
    }
  }

  let tx;
  if (useFixture || saved?.fixture) {
    try {
      tx = JSON.parse(require("fs").readFileSync(".mock-tx.json", "utf8"));
      if (tx.transaction.message.staticAccountKeys) {
        tx.transaction.message.staticAccountKeys =
          tx.transaction.message.staticAccountKeys.map((k) => {
            const addr = typeof k === "string" ? k : (k.toBase58?.() ?? String(k));
            return { toBase58: () => addr };
          });
      }
      for (const ix of tx.transaction.message.compiledInstructions ?? []) {
        if (ix.dataHex) {
          ix.data = Buffer.from(ix.dataHex, "hex");
          delete ix.dataHex;
        } else if (ix.data && !Buffer.isBuffer(ix.data)) {
          ix.data = Buffer.from(ix.data.data ?? Object.values(ix.data));
        }
      }
      console.error("ℹ️  Loaded fixture from .mock-tx.json\n");
    } catch {
      console.error("❌  Fixture not found. Run: node make-fixture.js first.");
      process.exit(1);
    }
  } else {
    const conn = new Connection(RPC_URL, "confirmed");
    try {
      tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    }
  }

  if (!tx) {
    console.error("❌  Transaction not found:", signature);
    process.exit(1);
  }

  console.log("=".repeat(72));
  console.log("qidx DECODED OUTPUT");
  console.log("=".repeat(72));
  console.log(JSON.stringify(decodeTransaction(tx, signature), null, 2));
}

main().catch(console.error);
