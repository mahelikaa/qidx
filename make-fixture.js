// make-fixture.js
// If no real Batch tx exists on mainnet yet (SIMD-0266 is brand new),
// this generates a realistic mock transaction object that mirrors
// exactly what Solana RPC returns, so decode-batch.js can be tested.
//
// The mock uses real-looking base58 addresses and correct binary layout.

const bs58 = require("bs58");
const fs = require("fs");

// Real-looking pubkeys (not actual accounts)
const ACCOUNTS = [
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", // fee payer
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  // Token-2022
  "So11111111111111111111111111111111111111112",   // native SOL mint
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5", // source ATA
  "BVW5u7P2N5p6K3pNQnfMJ9C4RGm4nWEuMxGXJvQhb8Z",  // dest ATA
  "3Xxh5FKPvByRCKLn2mTq5fR3v9UKH7RMHW2CKPHhS1Zp", // another source
  "FZZ9AETR8TkZy4vNJGEH7JkHmMYv5B2JRBRPqbVxHC3k",  // another dest
];

// Build Batch instruction data:
// byte 0: discriminator = 22
// bytes 1-2: u16LE number of transfers = 2
// then 2 × 16 bytes: u32LE srcIdx, u32LE dstIdx, u64LE amount
function buildBatchData(transfers) {
  const buf = Buffer.alloc(3 + transfers.length * 16);
  buf.writeUInt8(22, 0);
  buf.writeUInt16LE(transfers.length, 1);
  let offset = 3;
  for (const { src, dst, amount } of transfers) {
    buf.writeUInt32LE(src, offset);
    buf.writeUInt32LE(dst, offset + 4);
    buf.writeBigUInt64LE(BigInt(amount), offset + 8);
    offset += 16;
  }
  return buf;
}

const batchData = buildBatchData([
  { src: 4, dst: 5, amount: 1_000_000 },   // 1 USDC (6 decimals)
  { src: 6, dst: 7, amount: 500_000_000 },  // 0.5 SOL (9 decimals)
]);

// Store accounts as plain strings — JSON-safe, no .toBase58() loss
const mockTx = {
  slot: 422800000,
  blockTime: 1748400000,
  meta: {
    err: null,
    fee: 5000,
    computeUnitsConsumed: 12500,
    innerInstructions: [],
    preTokenBalances: [
      {
        accountIndex: 4,
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        uiTokenAmount: { amount: "5000000", decimals: 6, uiAmount: 5.0 },
      },
    ],
    postTokenBalances: [
      {
        accountIndex: 4,
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        uiTokenAmount: { amount: "4000000", decimals: 6, uiAmount: 4.0 },
      },
      {
        accountIndex: 5,
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        uiTokenAmount: { amount: "1000000", decimals: 6, uiAmount: 1.0 },
      },
    ],
    loadedAddresses: { writable: [], readonly: [] },
  },
  transaction: {
    signatures: ["5xBmRgHGgbK4Z3J9nRNsKcVt7yLqXjM8vDpEaFWnYhuTbCs2PiQeU6odhATgXzLkVNM1yR3CsEriwKoQfBPvjZ3"],
    message: {
      // Plain string accounts — reconstruct toBase58 wrappers in decode-batch.js
      staticAccountKeys: ACCOUNTS,
      compiledInstructions: [
        {
          programIdIndex: 1, // Token-2022
          accountKeyIndexes: [0, 4, 5, 6, 7],
          // Store as hex string for clean JSON serialization
          dataHex: batchData.toString("hex"),
        },
      ],
    },
  },
};

const SIG = mockTx.transaction.signatures[0];
fs.writeFileSync(
  ".batch-sig.txt",
  JSON.stringify({ signature: SIG, discriminator: 22, name: "Batch", fixture: true })
);
fs.writeFileSync(".mock-tx.json", JSON.stringify(mockTx, null, 2));

console.log("✅ Mock Batch transaction fixture created.");
console.log("   Signature:", SIG);
console.log("   Batch data (hex):", batchData.toString("hex"));
console.log("   .batch-sig.txt and .mock-tx.json written.");
console.log("\nRun: node decode-batch.js (it will use .batch-sig.txt)");
