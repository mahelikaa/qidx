// find-batch-tx.js
// Scans Token-2022 (p-token / SIMD-0266) transactions on mainnet
// looking for discriminators 22 = Batch, 23 = WithdrawExcessLamports, 24 = UnwrapLamports
//
// Handles BOTH transaction formats:
//   - Versioned (v0):  message.compiledInstructions[].data  → Uint8Array
//   - Legacy:          message.instructions[].data           → base58 string
//   - Inner instructions: meta.innerInstructions[].instructions[].data → base58 string
require("dotenv").config();

const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58").default;

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("❌  RPC_URL not set. Add it to your .env file.");
  process.exit(1);
}

// p-token extends Token-2022, NOT the old SPL token program
const TOKEN_2022 = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const DISC = { 255: "Batch", 38: "WithdrawExcessLamports", 45: "UnwrapLamports" };

// Normalize any instruction data to a Buffer, regardless of encoding
function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") {
    try { return Buffer.from(bs58.decode(data)); } catch { return null; }
  }
  return null;
}

// Extract all instructions (outer + inner) from a fetched transaction
function allInstructions(tx) {
  const ixs = [];
  const msg = tx.transaction.message;

  // Versioned transactions have compiledInstructions
  if (msg.compiledInstructions) {
    ixs.push(...msg.compiledInstructions);
  }
  // Legacy transactions have instructions with base58 data
  if (msg.instructions) {
    ixs.push(...msg.instructions);
  }

  // Inner instructions always have base58-encoded data
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
    } catch (e) {
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

async function main() {
  console.log("Connecting to mainnet via Helius RPC...");
  const conn = new Connection(RPC_URL, "confirmed");
  const slot = await conn.getSlot();
  console.log("✅ Connected. Current slot:", slot);

  let before = undefined;
  let totalChecked = 0;
  const BATCH_SIZE = 200;
  const MAX_TXS = 2000;

  console.log(`\nScanning up to ${MAX_TXS} Token-2022 txs for discriminators 22/23/24...\n`);

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
          console.log("Slot:      ", tx.slot);
          console.log(
            "Raw data (hex):",
            buf.toString("hex").slice(0, 160) +
              (buf.length > 80 ? "..." : "")
          );
          // Save for use by other scripts
          require("fs").writeFileSync(
            ".batch-sig.txt",
            JSON.stringify({ signature, discriminator: disc, name: DISC[disc] })
          );
          console.log(
            "\n💾 Signature saved to .batch-sig.txt for use by other scripts."
          );
          return;
        }
      }

      if (totalChecked % 100 === 0)
        process.stdout.write(`  ...checked ${totalChecked} txs\r`);
    }
  }

  console.log(
    `\n⚠️  No p-token Batch/Withdraw/Unwrap found in ${totalChecked} txs.`
  );
  console.log(
    "SIMD-0266 is 2 weeks old — these instructions are rare on mainnet."
  );
  console.log(
    "Trying fallback: searching Helius enhanced API for known p-token batch txs..."
  );
  await tryHeliusFallback();
}

// Fallback: use Helius /v0/addresses/:address/transactions which supports type filtering
async function tryHeliusFallback() {
  const axios = require("axios");
  const key = process.env.HELIUS_API_KEY || process.env.RPC_URL?.match(/api-key=([^&]+)/)?.[1];
  if (!key) { console.log("No HELIUS_API_KEY found, can't use fallback."); return; }

  const url = `https://api.helius.xyz/v0/addresses/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb/transactions?api-key=${key}&limit=100`;
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    console.log(`\nHelius enhanced API returned ${data.length} txs.`);
    for (const tx of data) {
      console.log("  sig:", tx.signature, "| type:", tx.type, "| desc:", tx.description?.slice(0, 80));
    }
  } catch (e) {
    console.log("Helius fallback failed:", e.message);
  }
}

main().catch(console.error);
