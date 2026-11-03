# XMR Tap — merchant beta

A starter beta for **direct, private Monero point-of-sale payments**.

The product idea is simple: a merchant rings up a USD-priced purchase, XMR Tap converts the sticker price to XMR, creates a unique Monero invoice, and lets a customer pay from a compatible wallet without a prepaid debit-card balance or card network.

## Included in this beta

- Mobile-first merchant checkout UI
- Live XMR/USD quote with fallback demo quote
- 1% merchant processing-fee accounting
- Customer pays the full USD sticker price; merchant net is 99%
- Unique invoice IDs + invoice nonces
- Monero payment URI + QR fallback
- Draft NFC invoice payload preview
- No customer reusable XMR address requested or stored
- Demo payment simulator
- Merchant-signed digital receipt using Web Crypto
- Transaction/activity ledger and CSV export
- USD-denominated refunds converted to XMR at the **refund-time** quote
- Fresh refund-address flow
- Optional Node backend with Monero Wallet RPC hooks
- PWA/service-worker shell

## Run the frontend

Any static web server works. For example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

The frontend works in demo mode with no backend.

## Run the beta backend

Requires Node 20+.

```bash
node server.js
```

Default: `DEMO_MODE=true`, so no real XMR moves.

Set the frontend backend URL under **Settings** to `http://localhost:8787`.

### Real Wallet RPC mode (experimental)

Run a secured `monero-wallet-rpc` instance locally, then start:

```bash
DEMO_MODE=false \
WALLET_RPC_URL=http://127.0.0.1:18082/json_rpc \
XMR_ACCOUNT_INDEX=0 \
node server.js
```

The beta backend implements these Monero Wallet RPC ideas:

- `create_address` — fresh invoice subaddress
- `get_transfers` — detect incoming payment to the subaddress
- `transfer` — send a refund to a fresh customer refund address

> **Do not expose `monero-wallet-rpc` to the browser or public internet.** This beta needs security hardening before real merchant funds are used.

## Merchant fee model

The beta fee is fixed at **1% of the USD sale amount** and is paid by the merchant.

Example:

- Sticker price: $100
- Customer payment: $100 worth of XMR
- XMR Tap merchant fee: $1
- Merchant net accounting: $99

The recommended noncustodial architecture is to let XMR settle directly to the merchant and bill/settle the 1% platform fee separately rather than taking custody of customer payments.

## Refund model

Refunds use the **USD purchase value**, not the original XMR amount.

If a customer paid $100 when XMR was $600 and later receives a $100 refund when XMR is $800, the refund is $100 / $800 = **0.125 XMR** (before any network fee policy).

## Important beta limitations

This is an early technical/product beta:

- QR requests are functional as a Monero URI format; actual payment detection requires the backend + wallet RPC.
- The NFC panel is a protocol preview/simulator. Third-party wallets must implement the XMR Tap NFC payload (or a future finalized standard) for true native tap-to-pay.
- Demo addresses and TXIDs are synthetic and must never be used as real payment destinations.
- Browser localStorage is used for demo state. Production requires authenticated accounts and a database.
- The dependency-free RPC server does not implement Wallet RPC HTTP Digest authentication. Put Wallet RPC behind a private local proxy or add a proper digest-auth client before production.

## Protocol draft

See [`docs/protocol.md`](docs/protocol.md).

## Privacy model

XMR Tap should never need the customer's reusable sender address. The merchant needs to know **which invoice was paid**, not the customer's wallet identity. A unique receiving subaddress ties an incoming payment to an invoice, while Monero's protocol protects the sender's reusable address.

## Disclaimer

XMR Tap is an independent beta project and is not affiliated with or endorsed by the Monero Project.
