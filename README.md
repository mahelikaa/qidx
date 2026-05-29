# qidx — DEX Settlement Engine

A full-stack Solana DEX: atomic batch settlement on-chain + an order book matcher + a transaction indexer.

**Live on devnet** | Program: [`8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy`](https://explorer.solana.com/address/8omCC2Q9SwwfRJQNkJ9UnFairpzHFkaWSeEd5nXjcooy?cluster=devnet)

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

| Approach | Trades/tx | CUs per trade |
|---|---|---|
| One-by-one | 1 | ~5,000 |
| settle_batch N=8 | 8 | ~1,800 |
| settle_batch N=32 | 32 | ~460 |

10× compute efficiency at scale. Critical for liquidation engines and HFT market makers.

---

## Quick start

### Prerequisites
- Node.js 18+
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
curl http://localhost:3000/tx/654as8QCLcQxdWog...
```

```json
{
  "signature": "654as8QCLcQxdWog...",
  "slot": 465788293,
  "timestamp": 1780081837,
  "fee": 5000,
  "compute_units_used": 14644,
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
    { "account": "5p9jHDeYK...", "mint": "84he3Lph...", "change": "-1000000", ... },
    { "account": "CoGs7NHW...", "mint": "84he3Lph...", "change": "1000000", ... }
  ]
}
```

### Matcher — `POST /order`

```json
{
  "side": "buy",
  "baseMint": "<mint pubkey>",
  "quoteMint": "<mint pubkey>",
  "baseAmount": "1000000",
  "quoteAmount": "500000",
  "makerBaseAccount": "<your base ATA>",
  "makerQuoteAccount": "<your quote ATA>"
}
```

Response (on match):
```json
{
  "order": { "status": "filled", ... },
  "matched": [{ "baseAmount": "1000000", "quoteAmount": "500000", ... }],
  "settlementSignature": "654as8QC..."
}
```

**`GET /orderbook`** — Open bids/asks  
**`GET /trades`** — Matched trade history

---

## On-chain program

```rust
pub fn settle_batch(ctx: Context<SettleBatch>, trades: Vec<Trade>) -> Result<()>

pub struct Trade {
    pub base_amount: u64,   // maker → taker
    pub quote_amount: u64,  // taker → maker
}
```

**Remaining accounts per trade** (4 × N):
1. `maker_base_account` — maker's base token ATA (maker sells this)
2. `taker_base_account` — taker's base token ATA (taker receives this)
3. `taker_quote_account` — taker's quote token ATA (taker pays this)
4. `maker_quote_account` — maker's quote token ATA (maker receives this)

**On-chain validations:** batch not empty, ≤32 trades, amounts > 0, account count matches.

---

## Live proof

Settlement transaction on devnet:  
[`654as8QCLcQxdWogXH9HPonZ2k1RR83NkAopRvzVU8Y4KVd7kEEQfTmdaLphBMxqiRJ1beXM8BuW1qPxEMSCJKP5`](https://explorer.solana.com/tx/654as8QCLcQxdWogXH9HPonZ2k1RR83NkAopRvzVU8Y4KVd7kEEQfTmdaLphBMxqiRJ1beXM8BuW1qPxEMSCJKP5?cluster=devnet)

Balance changes confirmed:
- Maker: −1,000,000 base, +500,000 quote
- Taker: +1,000,000 base, −500,000 quote

---

Built for Solana Fellowship Q2 2025 | MIT License
