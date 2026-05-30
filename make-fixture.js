const bs58 = require("bs58");
const fs = require("fs");

const ACCOUNTS = [
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
  "BVW5u7P2N5p6K3pNQnfMJ9C4RGm4nWEuMxGXJvQhb8Z",
  "3Xxh5FKPvByRCKLn2mTq5fR3v9UKH7RMHW2CKPHhS1Zp",
  "FZZ9AETR8TkZy4vNJGEH7JkHmMYv5B2JRBRPqbVxHC3k",
];

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
  { src: 4, dst: 5, amount: 1_000_000 },
  { src: 6, dst: 7, amount: 500_000_000 },
]);

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
      staticAccountKeys: ACCOUNTS,
      compiledInstructions: [
        {
          programIdIndex: 1,
          accountKeyIndexes: [0, 4, 5, 6, 7],
          dataHex: batchData.toString("hex"),
        },
      ],
    },
  },
};

const SIG = mockTx.transaction.signatures[0];
fs.writeFileSync(".batch-sig.txt", JSON.stringify({ signature: SIG, discriminator: 22, name: "Batch", fixture: true }));
fs.writeFileSync(".mock-tx.json", JSON.stringify(mockTx, null, 2));

console.log("✅ Fixture created. Run: node decode-batch.js");
