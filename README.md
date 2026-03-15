# arkadeosbot-skill

Claude Code skill for setting up Arkade (Ark protocol) Bitcoin wallet capabilities for AI agents.

## What is Arkade?

[Arkade](https://arkade.computer) is a Bitcoin Layer 2 built on the [Ark protocol](https://arkdev.info). It uses Virtual Transaction Outputs (VTXOs) for instant off-chain payments with batched on-chain settlement. It is fully self-custodial -- you hold your own keys via a BIP39 mnemonic. Lightning Network interop is provided through [Boltz Exchange](https://boltz.exchange) swaps. An operator (ASP/Ark Service Provider) batches transactions and settles them on-chain, but cannot steal funds -- users can always exit to L1 unilaterally.

**Key tradeoff vs Spark:** VTXOs expire (~30 days on mainnet). They must be renewed before expiry or recovered via an on-chain unilateral exit. Arkade provides a free delegation service that handles renewal automatically.

## Why Arkade for Agents?

- **Simple setup** -- Generate a mnemonic and you have a wallet. No accounts, no API keys, no approval process.
- **No channels** -- Unlike Lightning, there are no channels to open, fund, or rebalance. Just send and receive.
- **Self-custodial** -- The ASP cannot move funds without your signature. If the ASP goes offline, you can exit to L1.
- **Low fees** -- Ark-to-Ark transfers are free. Lightning via Boltz costs ~0.1%. On-chain exit costs 200 sats per output.
- **Native assets** -- Arkade Assets (colored coins) travel as VTXO payloads, no separate token infrastructure needed.
- **Automatic renewal** -- Free delegation service renews VTXOs before expiry. Set it and forget it.

## Capabilities

- **Wallet Setup** -- Generate or import wallets from a BIP39 mnemonic
- **BTC Balance & Deposits** -- Check balance, generate boarding addresses for on-chain deposits
- **Ark Transfers** -- Instant, free off-chain VTXO-to-VTXO transfers
- **Lightning Invoices** -- Create and pay BOLT11 invoices via Boltz swaps
- **Asset Operations** -- Transfer Arkade Assets (native colored coins)
- **Withdrawal** -- Collaborative exit back to L1 Bitcoin (200 sats per on-chain output)
- **VTXO Management** -- Automatic renewal via delegation, manual renewal, consolidation
- **Message Signing** -- Prove identity via Schnorr signatures
- **L402 Paywalls** -- Pay-per-request APIs via Lightning. Preview costs, pay invoices automatically.

## Installation

Clone into your Claude Code skills directory:

```bash
git clone https://github.com/echennells/arkadeosbot-skill.git ~/.claude/skills/arkadeosbot-skill
```

Or add the path to your Claude Code configuration.

## Quick Start

```bash
# Install dependencies (in the skill directory)
cd ~/.claude/skills/arkadeosbot-skill
npm install

# Copy env template
cp .env.example .env

# Generate a new wallet
node examples/wallet-setup.js

# Add the generated mnemonic to .env, then:
node examples/balance-and-deposits.js
node examples/payment-flow.js
```

## Example Scripts

| Script | Purpose |
|--------|---------|
| `wallet-setup.js` | Generate new wallet or import from mnemonic |
| `balance-and-deposits.js` | Check balance (BTC + assets), get boarding/deposit addresses |
| `payment-flow.js` | Lightning invoices, Ark transfers, fee estimation |
| `token-operations.js` | Arkade Asset balances, transfers |
| `l402-paywalls.js` | Access L402 pay-per-request APIs via Lightning |
| `arkade-agent.js` | Complete ArkadeAgent class with all capabilities |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ARK_MNEMONIC` | Yes* | BIP39 mnemonic (12 or 24 words). *`wallet-setup.js` can generate one. |
| `ARK_SERVER_URL` | No | ASP URL. Default: `https://arkade.computer` |
| `ARK_NETWORK` | No | `bitcoin` (default), `mutinynet`, `regtest` |
| `ARK_DELEGATOR_URL` | No | Delegator for auto VTXO renewal. Default: `https://delegate.arkade.money` |
| `BOLTZ_URL` | No | Boltz API. Auto-detected from network. |
| `ESPLORA_URL` | No | Block explorer API. Auto-detected from network. |

## Network Configuration

| Network | ASP Server | Boltz API | Delegator |
|---------|-----------|-----------|-----------|
| bitcoin | `https://arkade.computer` | `https://api.ark.boltz.exchange` | `https://delegate.arkade.money` |
| mutinynet | `https://mutinynet.arkade.sh` | `https://api.boltz.mutinynet.arkade.sh` | `https://delegator.mutinynet.arkade.sh` |
| regtest | `http://localhost:7070` | `http://localhost:9069` | N/A |

## Dependencies

```bash
npm install @arkade-os/sdk @arkade-os/boltz-swap @scure/bip32 @scure/bip39 @scure/base dotenv eventsource light-bolt11-decoder
```

## Security

**Mnemonic = full wallet access.** An Ark mnemonic can do everything: check balance, create invoices, send payments, and withdraw to L1. There is no permission scoping, no spending limits, no read-only mode.

**VTXO expiry is a real risk.** VTXOs expire after ~30 days. If not renewed, the only recovery path is a unilateral exit (on-chain transaction with timelock delay and miner fees). Always enable delegation for automatic renewal.

**Recommendations:**
- Never expose the mnemonic in code, logs, or version control
- Use environment variables for secrets
- Use a dedicated wallet with limited funds for each agent
- Enable VTXO delegation on startup (`delegateVtxos()`)
- Sweep earned funds to a more secure wallet regularly
- Back up the mnemonic offline

## Resources

- [Arkade Wallet](https://arkade.computer)
- [Ark Protocol Docs](https://arkdev.info)
- [@arkade-os/sdk (npm)](https://www.npmjs.com/package/@arkade-os/sdk)
- [Boltz Exchange](https://boltz.exchange)

## License

MIT
