require("dotenv").config();

const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58").default;

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("❌  RPC_URL not set.");
  process.exit(1);
}

const TOKEN_2022 = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const DISC = { 255: "Batch", 38: "WithdrawExcessLamports", 45: "UnwrapLamports" };

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") {
    try { return Buffer.from(bs58.decode(data)); } catch { return null; }
  }
  return null;
}

function allInstructions(tx) {
  const ixs = [];
  const msg = tx.transaction.message;
  if (msg.compiledInstructions) ixs.push(...msg.compiledInstructions);
  if (msg.instructions) ixs.push(...msg.instructions);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    ixs.push(...(inner.instructions ?? []));
  }
  return ixs;
}

async function fetchWithRetry(conn, sig, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) return tx;
    } catch {
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

async function main() {
  console.log("Connecting...");
  const conn = new Connection(RPC_URL, "confirmed");
  const slot = await conn.getSlot();
  console.log("✅ Connected. Slot:", slot);

  let before = undefined;
  let totalChecked = 0;
  const BATCH_SIZE = 200;
  const MAX_TXS = 2000;

  console.log(`\nScanning up to ${MAX_TXS} Token-2022 txs...\n`);

  while (totalChecked < MAX_TXS) {
    const opts = { limit: BATCH_SIZE };
    if (before) opts.before = before;

    const sigs = await conn.getSignaturesForAddress(TOKEN_2022, opts);
    if (!sigs.length) break;

    before = sigs[sigs.length - 1].signature;

    for (const { signature } of sigs) {
      totalChecked++;
      const tx = await fetchWithRetry(conn, signature);
      if (!tx) continue;

      for (const ix of allInstructions(tx)) {
        const buf = toBuffer(ix.data);
        if (!buf || buf.length === 0) continue;
        const disc = buf[0];

        if (DISC[disc]) {
          console.log(`\n✅ FOUND ${DISC[disc]}! (discriminator ${disc})`);
          console.log("Signature:", signature);
          console.log("Explorer:  https://solscan.io/tx/" + signature);
          console.log("Raw data (hex):", buf.toString("hex").slice(0, 160) + (buf.length > 80 ? "..." : ""));
          require("fs").writeFileSync(
            ".batch-sig.txt",
            JSON.stringify({ signature, discriminator: disc, name: DISC[disc] })
          );
          console.log("\n💾 Saved to .batch-sig.txt");
          return;
        }
      }

      if (totalChecked % 100 === 0)
        process.stdout.write(`  ...checked ${totalChecked} txs\r`);
    }
  }

  console.log(`\n⚠️  No p-token Batch/Withdraw/Unwrap found in ${totalChecked} txs.`);
}

main().catch(console.error);
