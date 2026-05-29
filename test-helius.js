// test-helius.js
// Calls Helius Enhanced Transactions API on a p-token Batch transaction
// and dumps exactly what Helius returns — raw, unfiltered.
// Purpose: show the gap between Helius's output and qidx's structured decode.
require("dotenv").config();

const axios = require("axios");

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  console.error(
    "❌  HELIUS_API_KEY not set. Add it to your .env file.\n" +
      "    Get a free key at: https://helius.dev"
  );
  process.exit(1);
}

async function main() {
  // Accept signature as CLI arg or fall back to saved file
  let signature = process.argv[2];
  if (!signature) {
    try {
      const saved = JSON.parse(require("fs").readFileSync(".batch-sig.txt", "utf8"));
      signature = saved.signature;
      console.log(`ℹ️  No signature arg — using saved: ${signature}\n`);
    } catch {
      console.error(
        "Usage: node test-helius.js <signature>\n" +
          "Or run find-batch-tx.js first to save a signature."
      );
      process.exit(1);
    }
  }

  console.log("=".repeat(72));
  console.log("HELIUS ENHANCED TRANSACTIONS API — RAW OUTPUT");
  console.log("=".repeat(72));
  console.log("Signature:", signature);
  console.log();

  const url = `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_API_KEY}`;

  try {
    const { data } = await axios.post(
      url,
      { transactions: [signature] },
      { timeout: 15000 }
    );

    if (!data || data.length === 0) {
      console.log("⚠️  Helius returned empty array — transaction not found or not indexed.");
      return;
    }

    const tx = data[0];

    // Print the full response so we can see exactly what Helius gives us
    console.log("Helius tx type:         ", tx.type ?? "UNKNOWN");
    console.log("Helius description:     ", tx.description ?? "(empty)");
    console.log("Fee payer:              ", tx.feePayer ?? "(none)");
    console.log("Slot:                   ", tx.slot ?? "(none)");
    console.log("Timestamp:              ", tx.timestamp ?? "(none)");
    console.log();

    if (tx.tokenTransfers?.length) {
      console.log("Token transfers Helius decoded:", tx.tokenTransfers.length);
      for (const t of tx.tokenTransfers) {
        console.log("  ", JSON.stringify(t));
      }
    } else {
      console.log("⚠️  tokenTransfers: [] — Helius decoded 0 token transfers.");
    }

    console.log();
    console.log("Raw instructions from Helius:");
    if (tx.instructions?.length) {
      for (const ix of tx.instructions) {
        console.log(" Program:", ix.programId);
        console.log("  data:  ", ix.data ?? "(null)");
        if (ix.innerInstructions?.length) {
          console.log("  inner instructions:", ix.innerInstructions.length);
        }
      }
    } else {
      console.log("  (no instructions field in response)");
    }

    console.log();
    console.log("Full Helius JSON response:");
    console.log(JSON.stringify(tx, null, 2));
  } catch (e) {
    if (e.response) {
      console.error("Helius API error:", e.response.status, e.response.data);
    } else {
      console.error("Request failed:", e.message);
    }
  }
}

main().catch(console.error);
