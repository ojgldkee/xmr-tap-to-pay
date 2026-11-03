# XMR Tap protocol draft v0.1

This repository includes a **beta protocol sketch**, not a finalized Monero standard.

## Goal

Let a merchant terminal hand a Monero invoice to a compatible wallet over NFC (with QR as fallback) **without requiring the customer to reveal a reusable sender address, name, home address, or card details**.

Monero already hides the sender's reusable address at the protocol level. XMR Tap must avoid re-introducing identity leakage in the application layer.

## Invoice lifecycle

1. Merchant POS prices goods/services in USD.
2. POS captures a USD/XMR quote and creates an invoice.
3. Merchant wallet creates a fresh Monero subaddress for the invoice (`create_address`).
4. POS builds the official Monero payment URI (equivalent to Wallet RPC `make_uri`).
5. POS displays a QR fallback and exposes the XMR Tap invoice payload for NFC-aware wallets.
6. Compatible customer wallet confirms merchant name, USD amount, XMR amount, and quote before signing/broadcasting.
7. Merchant backend watches the invoice subaddress (`get_transfers`, including mempool/pool when desired).
8. Once detected, merchant POS records the TXID and issues a merchant-signed digital receipt.

## Draft NFC payload

Recommended MIME type:

`application/vnd.xmrtap.invoice+json`

Example:

```json
{
  "protocol": "xmrtap",
  "version": 1,
  "type": "invoice",
  "merchantName": "Example Coffee",
  "invoiceId": "XRT-ABC123",
  "fiat": { "currency": "USD", "amountMinor": 1842 },
  "monero": {
    "amountAtomic": 29587000000,
    "amountXmr": 0.029587,
    "quoteUsdPerXmr": 622.56,
    "paymentUri": "monero:..."
  },
  "invoiceNonce": "random-128-bit-value",
  "expiresAt": "2026-11-03T19:00:00.000Z",
  "receipt": {
    "customerPublicKey": { "kty": "EC", "crv": "P-256", "...": "..." }
  }
}
```

## Customer privacy rule

A compatible wallet **must not send the customer's reusable Monero receiving address** as part of the purchase handshake.

The customer may optionally supply a one-time receipt-credential public key. That key is scoped to this purchase and is not a Monero wallet address.

## Merchant fee

XMR Tap beta sets the platform fee at **1% of the USD sale amount**, paid by the merchant.

The customer pays the USD sticker price converted to XMR. To keep the settlement path noncustodial, the recommended beta model is:

- XMR payment goes directly customer wallet → merchant wallet.
- XMR Tap records a 1% merchant fee in the merchant ledger.
- Platform fees can be invoiced to the merchant separately rather than intercepting customer funds.

## Refunds

Refunds are denominated in **USD**, not the original XMR quantity.

Example: a customer buys a $100 item and sends 0.16 XMR. If they return it later, the merchant refunds **$100 worth of XMR at the refund-time quote**, subject to the merchant's return policy.

Flow:

1. Customer presents the signed receipt / receipt credential.
2. POS verifies the receipt belongs to a previously paid invoice and has not exceeded its refundable USD balance.
3. Customer wallet supplies a **fresh XMR refund address**.
4. POS converts the USD refund value to XMR using the current quote.
5. Merchant backend sends a new XMR transaction with Wallet RPC `transfer`.
6. Refund TXID is attached to the original invoice.

## NFC implementation note

The web beta only previews the NFC payload. True phone-to-terminal contactless behavior varies by platform and generally requires native wallet/POS integration. Do not claim that Web NFC alone provides universal Apple Pay-style peer-to-peer NFC.

## Security notes before production

- Keep `monero-wallet-rpc` on a private network. Never expose it directly to the public internet or frontend JavaScript.
- Authenticate merchant users and terminals.
- Use a durable database instead of in-memory state/localStorage.
- Encrypt sensitive operational metadata at rest.
- Use a dedicated merchant signing key protected by an HSM/secure enclave where practical.
- Validate Monero addresses server-side before refunds.
- Add replay protection and invoice expiry checks.
- Add quote-source redundancy and signed quote snapshots.
- Audit the receipt credential and NFC protocol before asking third-party wallets to implement it.
- Decide merchant zero-confirmation policy based on transaction value/risk.
