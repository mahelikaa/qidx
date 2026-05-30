# qidx — DEX Settlement Engine

A full-stack Solana DEX: atomic batch settlement on-chain + an order book matcher + a transaction indexer.

**Live on devnet** | Program: [`8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy`](https://explorer.solana.com/address/8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy?cluster=devnet)

**Live APIs:**
- qidx indexer: `https://qidx-production.up.railway.app`
- Matcher: `https://settlement-production-b250.up.railway.app`

---

## What it does

### settle_batch — Anchor program (Rust)
One instruction that atomically executes N token swaps in a single transaction. Either all trades settle or none do — no partial fills.

### Matcher — TypeScript REST API
Price-time priority order book. When a buy order crosses a sell order, it batches all pending matches into a single `settle_batch` transaction.

### qidx — Transaction indexer (Node.js REST API)
Decodes any `settle_batch` transaction and returns structured JSON: the exact trades, token accounts, amounts, and balance changes.

---

## Architecture

```
User (maker)             User (taker)
     │                        │
     │  POST /order (sell)     │  POST /order (buy)
     └─────────────┬───────────┘
                   │
           ┌───────▼────────┐
           │  Matcher API   │  TypeScript, port 4000
           │  Order Book    │  price-time priority matching
           └───────┬────────┘
                   │  settle_batch tx (Borsh-encoded)
                   ▼
           ┌───────────────┐
           │  Solana devnet │
           │  settle_batch  │  ← Anchor program (Rust)
           └───────┬────────┘
                   │  tx signature
                   ▼
           ┌───────────────┐
           │  qidx API     │  Node.js, port 3000
           │  GET /tx/:sig │  decode → structured JSON
           └───────────────┘
```

### Why batch settlement matters

Most DEXes settle one trade per transaction. `settle_batch` is atomic over N trades:

| Approach | Trades/tx | CUs used (measured) |
|---|---|---|
| One-by-one (anchor-spl) | 1 | 14,644 |
| settle_batch + raw p-token CPI | 1 | 6,214 |
| settle_batch N=8 (projected) | 8 | ~1,800/trade |
| settle_batch N=32 (projected) | 32 | ~460/trade |

**57% CU reduction** by replacing `anchor-spl::token::transfer` with raw CPI using the p-token (SIMD-0266) wire format directly. Measured live on devnet.

---

## Quick start

### Prerequisites
- Node.js 20+
- Rust + Anchor 1.0
- Solana CLI with a devnet keypair

### 1. Clone and install

```bash
git clone https://github.com/mahelikaa/qidx
cd qidx && npm install
```

### 2. Start the qidx indexer

```bash
# .env: RPC_URL=https://api.devnet.solana.com
#        SETTLEMENT_PROGRAM_ID=8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy
node index.js
# → http://localhost:3000
```

### 3. Clone the settlement repo and start the matcher

```bash
git clone https://github.com/mahelikaa/settlement
cd settlement && npm install && npm start
# → http://localhost:4000
```

### 4. Run the end-to-end demo

```bash
cd settlement
npx ts-node app/demo.ts
```

This creates mints and ATAs on devnet, mints tokens, places crossing orders, and settles on-chain. Watch the balances change.

---

## API

### qidx Indexer — `GET /tx/:signature`

```bash
curl https://qidx-production.up.railway.app/tx/55usB2Dp3A81YAriq1pwL4C5BHPU1MAHojESBNd8B3933Z6p1hxETqjgSKsQehbQpczd9zwUtpBE1aUTs1siEbVQ
```

```json
{
  "signature": "55usB2Dp...",
  "slot": 465788293,
  "timestamp": 1780081837,
  "fee": 5000,
  "compute_units_used": 6214,
  "instructions": [
    {
      "instruction": "settle_batch",
      "program": "8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy",
      "trade_count": 1,
      "trades": [
        {
          "base_amount": "1000000",
          "quote_amount": "500000",
          "maker_base": "5p9jHDeYK...",
          "taker_base": "CoGs7NHW...",
          "taker_quote": "4TSZQPT...",
          "maker_quote": "AbcvADq..."
        }
      ]
    }
  ],
  "token_balance_changes": [
    { "account": "5p9jHDeYK...", "mint": "84he3Lph...", "change": "-1000000" },
    { "account": "CoGs7NHW...", "mint": "84he3Lph...", "change": "1000000" }
  ]
}
```

### Matcher — `POST /order`

```bash
curl -X POST https://settlement-production-b250.up.railway.app/order \
  -H "Content-Type: application/json" \
  -d '{
    "side": "sell",
    "baseMint": "<mint>",
    "quoteMint": "<mint>",
    "baseAmount": "1000000",
    "quoteAmount": "500000",
    "makerBaseAccount": "<ATA>",
    "makerQuoteAccount": "<ATA>"
  }'
```

**`GET /orderbook`** — Open bids/asks  
**`GET /trades`** — Matched trade history  
**`GET /health`** — Engine pubkey, program, cluster

---

## On-chain program

```rust
pub fn settle_batch(ctx: Context<SettleBatch>, trades: Vec<Trade>) -> Result<()>

pub struct Trade {
    pub base_amount: u64,   // base tokens: maker → taker
    pub quote_amount: u64,  // quote tokens: taker → maker
}
```

**Remaining accounts per trade** (4 × N):
1. `maker_base_account` — maker sells this
2. `taker_base_account` — taker receives this
3. `taker_quote_account` — taker pays this
4. `maker_quote_account` — maker receives this

**On-chain validations:** batch not empty, ≤32 trades, amounts > 0, account count matches, token program must be SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).

### Why raw CPI over anchor-spl

`anchor-spl::token::transfer` allocates a `CpiContext` struct on every call. We build the 9-byte SPL Token Transfer instruction by hand instead:

```
[0]     u8   discriminator = 3
[1..8]  u64  amount (little-endian)
```

Then call `solana_program::invoke` directly. Same p-token wire format, zero framework overhead. **Result: 14,644 → 6,214 CUs (-57%) measured on devnet.**

---

## Decentralisation tradeoff

| Component | Decentralised? |
|---|---|
| Settlement (on-chain) | ✅ Yes — trustless, atomic |
| Matching (off-chain) | ❌ No — centralised server |

This is the standard CLOB (centralised limit order book with on-chain settlement) architecture used by dYdX, Drift, and early Serum. The trust assumption is on the matcher, not the settlement.

---

## Live proof

Settlement transaction on devnet:  
[`55usB2Dp3A81YAriq1pwL4C5BHPU1MAHojESBNd8B3933Z6p1hxETqjgSKsQehbQpczd9zwUtpBE1aUTs1siEbVQ`](https://explorer.solana.com/tx/55usB2Dp3A81YAriq1pwL4C5BHPU1MAHojESBNd8B3933Z6p1hxETqjgSKsQehbQpczd9zwUtpBE1aUTs1siEbVQ?cluster=devnet)

Balance changes confirmed:
- Maker: −1,000,000 base, +500,000 quote
- Taker: +1,000,000 base, −500,000 quote

---

Built for Solana Fellowship Q2 2025 | MIT License
