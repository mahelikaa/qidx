require("dotenv").config();

const axios = require("axios");

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error("❌  HELIUS_API_KEY not set.");
  process.exit(1);
}

async function main() {
  let signature = process.argv[2];
  if (!signature) {
    try {
      const saved = JSON.parse(require("fs").readFileSync(".batch-sig.txt", "utf8"));
      signature = saved.signature;
      console.log(`ℹ️  Using saved signature: ${signature}\n`);
    } catch {
      console.error("Usage: node test-helius.js <signature>");
      process.exit(1);
    }
  }

  console.log("=".repeat(72));
  console.log("HELIUS ENHANCED TRANSACTIONS — RAW OUTPUT");
  console.log("=".repeat(72));
  console.log("Signature:", signature, "\n");

  const url = `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_API_KEY}`;

  try {
    const { data } = await axios.post(url, { transactions: [signature] }, { timeout: 15000 });

    if (!data || data.length === 0) {
      console.log("⚠️  Helius returned empty — transaction not found or not indexed.");
      return;
    }

    const tx = data[0];
    console.log("type:       ", tx.type ?? "UNKNOWN");
    console.log("description:", tx.description ?? "(empty)");
    console.log("feePayer:   ", tx.feePayer ?? "(none)");
    console.log("slot:       ", tx.slot ?? "(none)");
    console.log();

    if (tx.tokenTransfers?.length) {
      console.log("tokenTransfers:", tx.tokenTransfers.length);
      for (const t of tx.tokenTransfers) console.log(" ", JSON.stringify(t));
    } else {
      console.log("⚠️  tokenTransfers: [] — Helius decoded 0.");
    }

    console.log("\nFull response:");
    console.log(JSON.stringify(tx, null, 2));
  } catch (e) {
    if (e.response) console.error("Helius API error:", e.response.status, e.response.data);
    else console.error("Request failed:", e.message);
  }
}

main().catch(console.error);
