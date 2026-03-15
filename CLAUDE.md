# arkadebot-skill

Claude Code skill for setting up Arkade (Ark protocol) Bitcoin wallet capabilities for AI agents.

**Installation:** Clone to `~/.claude/skills/arkadebot-skill`

## What This Skill Does

Teaches Claude Code how to give AI agents Bitcoin capabilities using the Ark protocol via Arkade:

1. **Initialize Wallet** -- Create or import a BIP39 mnemonic-based wallet
2. **Check Balance** -- Query BTC and asset balances
3. **Receive Deposits** -- Generate boarding addresses for on-chain Bitcoin deposits
4. **Transfer BTC** -- Off-chain VTXO-to-VTXO transfers via Ark protocol
5. **Lightning Invoices** -- Create and pay BOLT11 invoices via Boltz swaps
6. **Asset Operations** -- Transfer Arkade Assets (native colored coins)
7. **Withdraw to L1** -- Collaborative exit back to on-chain Bitcoin
8. **Message Signing** -- Sign and verify messages for identity proof
9. **VTXO Management** -- Renew expiring VTXOs, check expiry status

## Structure

```
skills/
  arkadebot/
    SKILL.md              # Main knowledge base
examples/
  wallet-setup.js         # Generate/import wallet
  balance-and-deposits.js # Balance + deposit addresses
  payment-flow.js         # Lightning + Ark payments
  token-operations.js     # Arkade Asset operations
  arkade-agent.js         # Complete ArkadeAgent class
  l402-paywalls.js        # L402 paywall client
.env.example              # Environment variable template
```

## Trigger Phrases

Activates when user mentions: "Arkade wallet", "Ark protocol", "Arkade Bitcoin", "VTXO", "Arkade SDK", "Arkade payment", "Arkade transfer", "boarding address", "Bitcoin L2 wallet on Ark", "agent wallet on Arkade", "Lightning", "Lightning invoice", "BOLT11", "pay invoice", "send sats", "receive sats", "Bitcoin wallet", "Bitcoin payment", "send Bitcoin", "receive Bitcoin"

## Dependencies

```bash
npm install @arkade-os/sdk @arkade-os/boltz-swap @scure/bip32 @scure/bip39 @scure/base dotenv
```

## Environment Variables

```bash
ARK_MNEMONIC=<BIP39 mnemonic>
ARK_SERVER_URL=https://arkade.computer
ARK_NETWORK=bitcoin
```

## Security Note

An Ark mnemonic grants full wallet access (no permission scoping). Use dedicated wallets with limited funds for agents. VTXOs expire and must be renewed -- failure to renew risks funds requiring an on-chain unilateral exit. See SKILL.md for full security guidance.
