# qidx

A Solana indexer that correctly decodes p-token instructions and Quasar program events.

Every major indexer was built before p-token. When a `batch` transfer hits the chain today, they return raw bytes or drop it silently. qidx fixes that.

## What it does

- Decodes all 3 new p-token instructions: `batch`, `withdraw_excess_lamports`, `unwrap_lamports`
- Auto-generates typed event streams from Quasar program IDLs
- CLI for decoding and live-watching any program
- REST API + SSE stream for browser dashboards

## Quickstart

```bash
export HELIUS_API_KEY=your_key_here

git clone https://github.com/YOUR_USERNAME/qidx
cd qidx
cargo build --release

./target/release/qidx decode <signature>
./target/release/qidx watch <program-id>
./target/release/qidx serve --port 8080
```

## Status

Core p-token decoder working. CLI and REST API in progress. Built for the Solana Fellowship 2.0 (India, 2026).

## License

MIT
