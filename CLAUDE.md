# arkadebot-skill

Claude Code skill for setting up Arkade OS Bitcoin wallet capabilities for AI agents.

**Installation:** Clone to `~/.claude/skills/arkadebot-skill`

## What This Skill Does

Teaches Claude Code how to give AI agents Bitcoin capabilities using the Ark protocol via Arkade:

1. **Initialize Wallet** -- Create or import a BIP39 mnemonic-based wallet
2. **Check Balance** -- Query BTC and asset balances
3. **Receive Deposits** -- Generate boarding addresses for on-chain Bitcoin deposits
4. **Transfer BTC** -- Off-chain VTXO-to-VTXO transfers via Ark protocol
5. **Asset Operations** -- Transfer Arkade Assets (native colored coins)
6. **Withdraw to L1** -- Collaborative exit back to on-chain Bitcoin
7. **Message Signing** -- Sign and verify messages for identity proof
8. **VTXO Management** -- Renew expiring VTXOs, check expiry status

## Structure

```
skills/
  arkadebot/
    SKILL.md              # Main knowledge base
examples/
  wallet-setup.js         # Generate/import wallet
  balance-and-deposits.js # Balance + deposit addresses
  token-operations.js     # Arkade Asset operations
  arkade-agent.js         # Complete ArkadeAgent class
.env.example              # Environment variable template
```

## Trigger Phrases

Activates when user mentions: "Arkade wallet", "Ark protocol", "Arkade Bitcoin", "VTXO", "Arkade SDK", "Arkade payment", "Arkade transfer", "boarding address", "Bitcoin L2 wallet on Ark", "agent wallet on Arkade", "send sats", "receive sats", "Bitcoin wallet", "Bitcoin payment", "send Bitcoin", "receive Bitcoin"

## Dependencies

```bash
npm install @arkade-os/sdk @scure/bip32 @scure/bip39 @scure/base dotenv eventsource
```

## Environment Variables

```bash
ARK_MNEMONIC=<BIP39 mnemonic>
ARK_SERVER_URL=https://arkade.computer
ARK_NETWORK=bitcoin
```

## Security Note

An Ark mnemonic grants full wallet access (no permission scoping). Use dedicated wallets with limited funds for agents. VTXOs expire and must be renewed -- failure to renew risks funds requiring an on-chain unilateral exit. See SKILL.md for full security guidance.
