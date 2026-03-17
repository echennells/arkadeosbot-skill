---
name: arkadebot
description: Set up Arkade OS Bitcoin wallet capabilities for AI agents. Initialize wallets from mnemonic, transfer sats and assets, manage VTXOs and their expiry, handle deposits and withdrawals. Use when user mentions "Arkade wallet," "Ark protocol," "Arkade Bitcoin," "VTXO," "Arkade SDK," "Arkade payment," "Arkade transfer," "boarding address," "Bitcoin L2 wallet on Ark," "agent wallet on Arkade," "send sats," "receive sats," "Bitcoin wallet," "Bitcoin payment," "send Bitcoin," "receive Bitcoin," or wants Bitcoin/sats capabilities for an agent.
argument-hint: "[Optional: specify what to set up - wallet, payments, tokens, vtxo-management, or full]"
requires:
  env:
    - name: ARK_MNEMONIC
      description: 12 or 24 word BIP39 mnemonic for the Arkade wallet. This is a secret key that controls all funds -- never commit to git or expose in logs.
      sensitive: true
    - name: ARK_SERVER_URL
      description: Arkade server (ASP) URL
      default: https://arkade.computer
    - name: ARK_NETWORK
      description: Network to connect to (bitcoin, mutinynet, regtest)
      default: bitcoin
    - name: ARK_DELEGATOR_URL
      description: Delegator service URL for automatic VTXO renewal (free on mainnet)
      default: https://delegate.arkade.money
model-invocation: autonomous
model-invocation-reason: This skill enables agents to autonomously send and receive Bitcoin payments via the Ark protocol. Autonomous invocation is intentional -- agents need to pay invoices and respond to incoming transfers without human approval for each transaction. Use spending limits and separate wallets for production environments where you need guardrails.
---

# Arkade (Ark Protocol) Bitcoin L2 for AI Agents

You are an expert in setting up Arkade Bitcoin wallet capabilities for AI agents using `@arkade-os/sdk`.

Arkade is a Bitcoin Layer 2 built on the Ark protocol. It uses Virtual Transaction Outputs (VTXOs) for instant off-chain payments with batched on-chain settlement. Unlike Lightning, there are no channels to manage. Unlike Spark, VTXOs have expiry timestamps and must be renewed periodically. A single BIP39 mnemonic gives an agent identity, wallet access, and payment capabilities.

## For Production Use

**This skill gives the agent full custody of the wallet.** The agent holds the mnemonic and can send all funds without restriction. This is appropriate for:
- Development and testing (use regtest with no real funds)
- Trusted agents you fully control
- Small operational balances you're willing to lose

For production with real funds, implement application-level spending controls (per-transaction caps, daily budgets) in your agent logic since the SDK provides no built-in limits.

## Why Bitcoin for Agents

AI agents that transact need a monetary network that matches their nature: programmable, borderless, and available 24/7 without gatekeepers. Bitcoin is that network.

- **Hard-capped supply** -- 21 million coins. An agent accumulating value doesn't lose it to monetary expansion.
- **No account required** -- Generate a key and you're on the network. No sign-up, identity verification, or approval.
- **Irreversible settlement** -- Once confirmed, transactions cannot be reversed by a third party.
- **Open infrastructure** -- Open source protocol, public network, transparent fee market.
- **Proven reliability** -- Continuously operating since 2009 without a successful base protocol attack.

## What is Ark Protocol

Ark is a Bitcoin scaling protocol that uses:
- **VTXOs (Virtual Transaction Outputs)** -- Off-chain coins with expiry timestamps
- **Batched settlement** -- An operator (ASP/Ark Service Provider) collects transactions and settles them on-chain in batches
- **Unilateral exit** -- Users can always exit to L1 without operator cooperation (after timelock)
- **No channels** -- Unlike Lightning, no channels to open, close, or manage liquidity for

### How It Works

1. User holds their own keys (BIP39 mnemonic) -- fully self-custodial
2. User creates payment intents (signed messages proving VTXO ownership)
3. ASP collects intents from multiple users into a batch
4. MuSig2 cooperative signing round between user and ASP
5. Batch settles on-chain as a single Bitcoin transaction
6. Recipients get new VTXOs valid for a limited time (~30 days on arkade.computer)
7. Before expiry, VTXOs must be renewed by participating in a new batch

### Trust Model -- Important Tradeoffs

**ASP operator trust**: The ASP can see transaction amounts/participants and can temporarily censor transactions. However, the ASP cannot steal funds -- users can always unilaterally exit to L1 if the ASP goes offline or misbehaves.

**What the ASP CAN do**:
- View transaction metadata
- Temporarily delay or refuse transactions (censorship)
- Go offline (halting off-chain payments until recovery)

**What the ASP CANNOT do**:
- Move funds without user signatures
- Steal Bitcoin
- Reverse finalized on-chain settlements

**Unilateral exit as safety net**: If the ASP becomes unresponsive, users can broadcast pre-signed transactions to claim their funds on-chain. This takes time (default ~24 hour timelock) and costs on-chain fees, but guarantees fund recovery.

**VTXO expiry risk**: VTXOs expire. If not renewed before expiry, funds require a unilateral exit (on-chain transaction with timelock delay). Agents MUST implement automatic renewal.

### Ark vs Spark vs Lightning vs On-Chain

| Feature | Arkade (Ark) | Spark | Lightning | On-Chain |
|---------|-------------|-------|-----------|----------|
| Speed | Instant (preconfirmed) | Instant | Instant | 10+ min |
| Trust model | ASP + unilateral exit | 1-of-n operators | Fully trustless | Fully trustless |
| Fees | Per VTXO input/output | Zero (Spark-to-Spark) | ~1 sat routing | 200+ sats |
| Tokens | Arkade Assets (native) | BTKN/LRC20 | Not supported | Limited |
| Self-custody | Yes (mnemonic) | Yes (mnemonic) | Varies | Yes |
| Channels | Not required | Not required | Required | N/A |
| Coin expiry | VTXOs expire (~30 days) | No expiry | Channel lifetime | No expiry |
| Lightning | Not included (stateful) | Built-in | Native | N/A |
| Setup | Mnemonic + ASP URL | Mnemonic only | Node or hosted | Keys only |

### Fee Structure

| Operation | Fee |
|-----------|-----|
| **Off-chain transfer (Ark-to-Ark)** | Free (offchain inputs/outputs currently 0 sats) |
| **L1 deposit (boarding)** | On-chain tx fee (paid by user) |
| **Collaborative exit to L1** | 200 sats per on-chain output (set by ASP). Offchain change outputs are free. |
| **Unilateral exit to L1** | On-chain tx fee (user pays, higher than collaborative) |

**Collaborative exit cooldown:** VTXOs must be at least ~24 hours old before they can be used in a `settle()` (collaborative exit to L1). The ASP enforces a `minExpiryGap` of ~696 hours — since VTXOs have a ~720 hour (~30 day) lifetime, they need ~24 hours to age past this threshold. This does NOT affect Ark-to-Ark transfers or any other operation — only on-chain exits.

**On-chain dust limit:** On-chain outputs must be at least 330 sats (`utxoMinAmount`). If withdraw change would be below this, it is donated to fees.

### VTXO Lifecycle -- Critical Concept

**This is the most important difference from Spark and Lightning.** VTXOs are time-limited:

1. **Creation** -- VTXOs are created when you receive off-chain payments or board from L1
2. **Active period** -- VTXOs are spendable for their lifetime (~30 days on arkade.computer)
3. **Renewal** -- Before expiry, VTXOs must be renewed (via delegation or manual settle)
4. **Expiry** -- If not renewed, VTXOs can only be recovered via unilateral exit (on-chain, timelock delay)

### VTXO Renewal -- Delegation (Recommended)

**Use delegation for automatic VTXO renewal.** A delegator service renews VTXOs on your behalf at ~10% before expiry. This is free on mainnet and eliminates the need for renewal timers.

**How it works:**
- Pass `delegatorProvider` to `Wallet.create()` — enabled by default in ArkadeAgent on mainnet
- The wallet generates a **delegate address** with a 3-of-3 tapscript (user + delegator + ASP)
- The delegator can sign renewal transactions but **cannot steal funds** (requires user + ASP cooperation)
- Call `delegateVtxos()` on startup to register VTXOs for automatic renewal

**Important:** Enabling delegation changes your Ark address. VTXOs on the old non-delegate address remain spendable but won't be auto-renewed. **Decide delegation at wallet setup time** — don't toggle it after receiving funds.

**Delegator URLs:**
| Network | URL |
|---------|-----|
| bitcoin | `https://delegate.arkade.money` |
| mutinynet | `https://delegator.mutinynet.arkade.sh` |

**What happens without delegation:** If VTXOs are not renewed before expiry (~30 days), they can no longer be spent off-chain. The only recovery path is a **unilateral exit** — an on-chain Bitcoin transaction that requires waiting out a timelock (~7 days) and paying on-chain miner fees. During high-fee periods this can be expensive. If the agent is offline or fails to broadcast the exit transaction, **funds can be lost**. Delegation eliminates this risk entirely.

**Manual renewal fallback:** If delegation is unavailable, use `renewVtxos()` with a timer (e.g., every 6 hours, 24-hour threshold). This calls `wallet.settle()` to merge all VTXOs into a fresh one. This requires the agent to be online and running — if it goes down for extended periods, VTXOs may expire.

### Limitations

- **ASP liveness dependency** -- If the ASP goes offline, off-chain payments halt until recovery
- **Batch timing** -- Transactions participate in ASP batch cycles, not individually instant
- **Boarding timelock** -- On-chain deposits take time to become fully available as VTXOs

## Tools Available

| Tool | Purpose |
|------|---------|
| @arkade-os/sdk | TypeScript wallet SDK for Ark protocol |

## Required Libraries

```bash
npm install @arkade-os/sdk@^0.4.4 @scure/bip32 @scure/bip39 @scure/base dotenv eventsource
```

The SDK's `MnemonicIdentity` handles BIP-86 derivation for new wallets. The `@scure/bip32` and `@scure/base` libraries are needed for legacy path fallback when importing wallets that may have been created with an older derivation path.

**Node.js polyfill required:** The SDK uses `EventSource` (browser SSE API) internally. In Node.js, you must polyfill it before importing the SDK:

```javascript
import { EventSource } from "eventsource";
if (typeof globalThis.EventSource === "undefined") {
  globalThis.EventSource = EventSource;
}
// Now import @arkade-os/sdk
```

## Setup Instructions

### Step 1: Generate or Import Wallet

```javascript
import { Wallet, SingleKey, MnemonicIdentity, RestDelegatorProvider, InMemoryWalletRepository, InMemoryContractRepository } from "@arkade-os/sdk";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";

// Option A: Generate a new wallet (always BIP-86)
const mnemonic = generateMnemonic(wordlist);
// Save mnemonic securely -- NEVER log it in production

// Option B: Import existing wallet from mnemonic
const mnemonic = process.env.ARK_MNEMONIC;

// Create identity using BIP-86 derivation (m/86'/0'/0'/0/0)
// Use { isMainnet: false } for testnet/regtest
const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: true });

const wallet = await Wallet.create({
  identity,
  arkServerUrl: process.env.ARK_SERVER_URL || "https://arkade.computer",
  delegatorProvider: new RestDelegatorProvider("https://delegate.arkade.money"),
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
});
```

The SDK's `MnemonicIdentity` handles BIP-86 key derivation internally (`m/86'/0'/0'/0/0` for mainnet, `m/86'/1'/0'/0/0` for testnet). This is compatible with NArk, BTCPay Server's Arkade plugin, and the SDK's own recommended approach. For new wallets, always use BIP-86. For imports, use dual-path scanning (see below).

### Wallet Import: Dual-Path Scanning

When importing an existing mnemonic, funds may exist under either of two derivation paths depending on which tool originally created the wallet:

- **BIP-86 (current standard):** `m/86'/0'/0'/0/0` -- used by SDK `MnemonicIdentity`, NArk, BTCPay plugin
- **Legacy custom path:** `m/44'/1237'/0'/0/0` -- used by older arkade.money wallet and earlier bot versions

The `ArkadeAgent.create()` method always uses BIP-86 as the primary wallet but also checks the legacy path. If legacy funds are detected, it warns the user and makes them available for migration. **It never silently switches to the legacy wallet** -- this prevents "wallet flipping" where the active wallet changes depending on which path has funds.

**Migration:** Call `agent.migrateLegacyFunds()` to automatically send all legacy funds (sats and assets) to the BIP-86 wallet via off-chain Ark transfers. Check `agent.getLegacyBalance()` to see if migration is needed — it reports both sat balances and any assets on the legacy path.

### Wallet Import: HD Index Scanning -- Critical for Imported Mnemonics

**Problem:** The Arkade SDK uses HD key derivation to generate a sequence of contract scripts at indexes 0, 1, 2, 3, etc. Each time a wallet receives funds or participates in a round, the SDK may rotate to the next index. The taproot script at each index is deterministic (user pubkey at that index + ASP server pubkey + CSV timelock). With `InMemoryWalletRepository` (stateless), the SDK only derives index 0 and queries the operator for VTXOs matching that single script. Funds at higher indexes are invisible.

Unlike on-chain BIP-44/84/86 wallets which do gap-limit address discovery, the Ark SDK assumes persisted state will track which indexes have been used. With in-memory storage there's no persisted state, so previously-used wallets appear to have zero balance.

**Solution:** Call `agent.scanIndexes()` after creating an agent from an imported mnemonic. This:

1. Derives the user's x-only pubkey at each BIP-86 child index (`m/86'/0'/0'/0/{index}`)
2. Creates a `SingleKey` wallet at each index and queries the operator for VTXOs
3. Stops after 20 consecutive empty indexes (standard gap limit)
4. Stores funded index wallets for balance aggregation and migration

**Spending limitation:** The primary wallet (MnemonicIdentity) signs with the index 0 key. It cannot sign for VTXOs at other indexes. The agent creates separate `SingleKey` wallet instances for each funded index, which can sign their own transactions. Call `agent.migrateIndexFunds()` to send all rotated-index funds to the primary wallet (index 0) via off-chain transfers.

**Usage:**

```javascript
// For imported mnemonics, always scan
const agent = await ArkadeAgent.create(mnemonic);
const scan = await agent.scanIndexes();
console.log(`Found funds at indexes: ${scan.fundedIndexes.map(f => f.index).join(", ")}`);
console.log(`Total: ${scan.totalSats} sats`);

// Consolidate to primary wallet
if (scan.fundedIndexes.some(f => f.index > 0)) {
  const result = await agent.migrateIndexFunds();
  console.log(`Migrated from ${result.indexes.length} indexes`);
}

// Or use the convenience option:
const agent = await ArkadeAgent.create(mnemonic, { scan: true });
```

**Performance:** Each index check requires a `Wallet.create()` + `getBalance()` network round-trip (~200-500ms). Scanning 20 empty indexes takes several seconds. Only scan when importing an existing mnemonic -- for freshly generated mnemonics it is unnecessary.

**When to scan:** Scan if the mnemonic was previously used with Arkade (via the web wallet, another agent, NArk, etc.). If `getBalance()` returns 0 but you expect funds, scanning will find them. After migration, all funds are at index 0 and future operations work normally.

### Step 2: Store Mnemonic

Add to your project's `.env`:
```
ARK_MNEMONIC=word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
ARK_SERVER_URL=https://arkade.computer
ARK_NETWORK=bitcoin
```

**Security warnings:**
- **Never log the mnemonic** -- not even during development
- **Never commit `.env`** -- add it to `.gitignore` before your first commit
- **Use a secrets manager in production** -- `.env` files are plaintext
- **Test with regtest first** -- use a throwaway mnemonic before touching real funds

### Step 3: Verify Wallet

```javascript
const arkAddress = await wallet.getAddress();
const boardingAddress = await wallet.getBoardingAddress();
const balance = await wallet.getBalance();

console.log("Ark Address:", arkAddress);
console.log("Boarding Address:", boardingAddress);
console.log("Balance:", balance.total.toString(), "sats");
```

## Wallet Operations

### Check Balance

When checking balances on an unknown or previously-used mnemonic, scan all address variants (with and without delegation) since you may not know how the wallet was originally configured.

```javascript
const balance = await wallet.getBalance();
console.log("Total:", balance.total.toString(), "sats");
console.log("Off-chain:", (balance.offchain || 0n).toString(), "sats");
console.log("On-chain:", (balance.onchain || 0n).toString(), "sats");

// Asset balances
for (const asset of balance.assets) {
  console.log(`Asset ${asset.assetId}: ${asset.amount}`);
}
```

### Generate Deposit Address (Boarding)

```javascript
const boardingAddress = await wallet.getBoardingAddress();
// Bitcoin address for on-chain deposits
// Funds become VTXOs after boarding through ASP batch
```

The boarding address is a time-locked Bitcoin address. Send BTC to it, and after on-chain confirmation, the funds can be onboarded to Ark as VTXOs through the ASP batch process.

### Transfer Bitcoin (Ark-to-Ark)

```javascript
const txid = await wallet.send({
  address: "ark1...",  // Recipient's Ark address
  amount: 1000,        // Satoshis
});
console.log("Transfer:", txid);
```

Off-chain VTXO-to-VTXO transfers. Preconfirmed instantly, settled on-chain in the next ASP batch.

### Send to Multiple Recipients

```javascript
const txid = await wallet.send(
  { address: "ark1...", amount: 500 },
  { address: "ark1...", amount: 500 },
);
```

### Transaction History

```javascript
const txs = await wallet.getTransactionHistory();
for (const tx of txs) {
  console.log(`${tx.type}: ${tx.amount} sats (${tx.settled ? "settled" : "pending"})`);
}
```

## VTXO Management

### Check VTXO Expiry Status

```javascript
const vtxos = await wallet.getVtxos();
const now = Date.now();

for (const v of vtxos) {
  const expiry = v.virtualStatus?.batchExpiry;
  const hoursLeft = expiry ? ((expiry - now) / 3600000).toFixed(1) : "unknown";
  console.log(`${v.txid.slice(0, 16)}... ${v.value} sats (expires in ${hoursLeft}h)`);
}
```

### Renew Expiring VTXOs

```javascript
const RENEWAL_THRESHOLD_MS = 86400000; // 24 hours
const vtxos = await wallet.getVtxos();
const now = Date.now();

const expiring = vtxos.filter(
  (v) => v.virtualStatus?.batchExpiry && v.virtualStatus.batchExpiry - now < RENEWAL_THRESHOLD_MS
);

if (expiring.length > 0) {
  const totalAmount = expiring.reduce((sum, v) => sum + v.value, 0);
  const arkAddr = await wallet.getAddress();

  const txid = await wallet.settle({
    inputs: expiring,
    outputs: [{ address: arkAddr, amount: BigInt(totalAmount) }],
  });
  console.log(`Renewed ${expiring.length} VTXOs:`, txid);
}
```

**Recommended:** Use `delegateVtxos()` on startup for automatic renewal (see "VTXO Renewal -- Delegation" section above). The manual approach above is only needed if delegation is unavailable. If a VTXO expires, the only recovery path is a unilateral exit (on-chain transaction with timelock delay and higher fees).

## Asset Operations (Arkade Assets)

Arkade supports native colored coins using OP_RETURN encoding. Assets travel as VTXO payloads off-chain.

### Check Asset Balances

```javascript
const balance = await wallet.getBalance();
for (const asset of balance.assets) {
  console.log(`Asset ${asset.assetId}: ${asset.amount}`);
}
```

### Transfer Assets

```javascript
const txid = await wallet.send({
  address: "ark1...",
  amount: 0,  // Can be 0 for pure asset transfer
  assets: [{ assetId: "hex...", amount: 100 }],
});
```

Assets can only be transferred off-chain (VTXO-to-VTXO). There is no Lightning support for assets.

## Withdrawal (Collaborative Exit to L1)

Move funds from Ark back to a regular Bitcoin L1 address. The ASP charges **200 sats per on-chain output**. Change sent back to an Ark address (offchain) is free. On-chain outputs must be at least 330 sats (dust limit).

```javascript
const FEE_PER_OUTPUT = 200; // ASP fee per on-chain output
const DUST_LIMIT = 330;
const vtxos = await wallet.getVtxos();

// Select VTXOs, prioritizing soonest-expiring
const sorted = vtxos.sort((a, b) =>
  (a.virtualStatus?.batchExpiry ?? 0) - (b.virtualStatus?.batchExpiry ?? 0)
);
const amountSats = 50000;
const minTarget = amountSats + FEE_PER_OUTPUT; // only on-chain output costs 200
let selected = [], selectedAmount = 0;
for (const vtxo of sorted) {
  selected.push(vtxo);
  selectedAmount += vtxo.value;
  if (selectedAmount >= minTarget) break;
}

const change = selectedAmount - amountSats - FEE_PER_OUTPUT;
const outputs = [{ address: "bc1q...", amount: BigInt(amountSats) }];
if (change >= DUST_LIMIT) {
  outputs.push({ address: await wallet.getAddress(), amount: BigInt(change) });
}
// else: sub-dust change is donated to fees

const txid = await wallet.settle({ inputs: selected, outputs });
```

**Note:** Collaborative exit requires ASP cooperation and VTXOs must be at least ~24 hours old (see collaborative exit cooldown above). If the ASP is offline, use unilateral exit (slower, higher fees, but trustless). See `withdraw()` in `examples/arkade-agent.js` for the full implementation.

## Message Signing

Sign messages with the wallet's identity key for proving identity or authenticating between agents.

```javascript
// Sign (returns hex string via ArkadeAgent.signMessage())
const signature = await agent.signMessage("I am agent-007");

// Or using the SDK directly (returns Uint8Array, encode it yourself)
const message = new TextEncoder().encode("I am agent-007");
const rawSig = await wallet.identity.signMessage(message, "schnorr");
const sigHex = hex.encode(new Uint8Array(rawSig));

// Public key for verification
const pubkey = hex.encode(new Uint8Array(await wallet.identity.compressedPublicKey()));
```

## Complete Agent Class

The full `ArkadeAgent` class is in **`examples/arkade-agent.js`** — a single-file, production-ready agent with all capabilities:

| Method | Description |
|--------|-------------|
| `ArkadeAgent.create(mnemonic, options)` | Static factory — sets up BIP-86 wallet, checks legacy path. Pass `{ scan: true }` to auto-scan HD indexes |
| `scanIndexes(options?)` | Scan BIP-86 child indexes for funds at rotated HD positions. Options: `{ gapLimit, onProgress }` |
| `migrateIndexFunds()` | Send all rotated-index funds to the primary wallet (index 0) via off-chain transfers |
| `getLegacyBalance()` | Check for funds and assets stranded on legacy m/44'/1237'/0' path (null if none) |
| `migrateLegacyFunds()` | Send all legacy-path funds and assets to the BIP-86 wallet automatically |
| `getIdentity()` | Ark address + boarding address |
| `getBalance()` | BTC balance + asset balances with metadata |
| `getDepositAddress()` | Boarding address for on-chain deposits |
| `transfer(address, amount)` | Off-chain Ark-to-Ark transfer |
| `withdraw(onchainAddress, amount)` | Collaborative exit to L1 (200 sat fee per on-chain output) |
| `consolidateVtxos()` | Merge multiple VTXOs into one |
| `delegateVtxos()` | Register VTXOs for automatic renewal |
| `renewVtxos(thresholdMs)` | Manual renewal fallback |
| `getVtxoStatus()` | VTXO expiry details |
| `transferAssets(address, assets, amount)` | Send Arkade Assets |
| `getAssetDetails(assetId)` | Asset metadata |
| `signMessage(text)` | Schnorr signature for identity proof |
| `getTransactionHistory()` | Transaction log |

**Lightning is not included.** Arkade supports Lightning via Boltz Exchange swaps (`@arkade-os/boltz-swap`), but the swap lifecycle is stateful and not suitable for an agent skill:

- **Receiving** requires generating a preimage and claim keypair, monitoring a WebSocket for payment, then constructing and broadcasting a VHTLC claim transaction before a timeout expires.
- **Sending** blocks while the swap settles through Boltz's submarine swap flow, requiring the agent to stay online and poll for completion.
- Both paths require persistent state tracking across multiple asynchronous steps. If the agent crashes or restarts mid-swap, funds can be lost or stuck.

If you need Lightning, consider [sparkbtcbot-skill](https://github.com/echennells/sparkbtcbot-skill) which has built-in stateless Lightning support via Spark's native integration. Alternatively, use `@arkade-os/boltz-swap` directly in a long-running process with proper swap state persistence (e.g., a database-backed `SwapRepository`).

**Usage:**

```javascript
import { ArkadeAgent } from "./examples/arkade-agent.js";

const agent = await ArkadeAgent.create(process.env.ARK_MNEMONIC);

// For imported mnemonics: scan for funds at rotated HD indexes
const scan = await agent.scanIndexes();
if (scan.fundedIndexes.some(f => f.index > 0)) {
  await agent.migrateIndexFunds(); // consolidate to primary wallet
}

const { address } = await agent.getIdentity();
const { total } = await agent.getBalance();

// Delegate VTXOs on startup (recommended)
await agent.delegateVtxos();
```

## Error Handling

```javascript
try {
  await wallet.send({ address: "ark1...", amount: 1000 });
} catch (error) {
  if (error.message.includes("insufficient")) {
    console.log("Not enough funds:", error.message);
  } else if (error.message.includes("network") || error.message.includes("connect")) {
    console.log("Network issue:", error.message);
  } else if (error.message.includes("invalid") || error.message.includes("address")) {
    console.log("Invalid input:", error.message);
  } else {
    console.log("Error:", error.message);
  }
}
```

Common error scenarios:
- **Insufficient funds** -- Not enough VTXO value to cover transfer + fees
- **ASP unreachable** -- Network connectivity or ASP downtime
- **Invalid address** -- Malformed Ark address
- **VTXO expired** -- Attempting to spend an expired VTXO (renew first)
- **Batch timing** -- ASP not currently accepting intents (wait for next batch window)

## Security Best Practices

### The Agent Has Full Wallet Access

Any agent or process with the mnemonic has **unrestricted control** over the wallet. There is no permission scoping, no spending limits, no read-only mode in the SDK.

This means:
- If the mnemonic leaks, all funds are at risk immediately
- If an agent is compromised, the attacker has full access
- There is no way to revoke access without sweeping funds to a new wallet

### Protect the Mnemonic

1. **Back up the seed phrase offline** -- write it down. If you lose the mnemonic, funds are gone permanently
2. **Never expose the mnemonic** in code, logs, git history, or error messages
3. **Use environment variables** -- never hardcode the mnemonic in source files
4. **Add `.env` to `.gitignore`** -- prevent accidental commits

### Sweep Funds to a Safer Wallet

**Do not accumulate large balances in an agent wallet.** The mnemonic sits in an environment variable -- treat it as a hot wallet.

- Regularly sweep earned funds to a more secure wallet
- Only keep the minimum operational balance
- Consider automating sweeps when the balance exceeds a threshold

### VTXO Renewal is Security-Critical

If VTXOs expire, funds require an on-chain unilateral exit:
- This costs on-chain fees (potentially high during congestion)
- There is a timelock delay (typically ~24 hours)
- The agent must monitor and broadcast the exit transaction

**Always enable VTXO renewal.** Use `delegateVtxos()` on startup (recommended) or fall back to `renewVtxos()` on a timer (24-hour threshold, 6-hour check intervals).

### Operational Security

1. **Use separate mnemonics** for different agents
2. **Monitor VTXO expiry** -- set up alerts for VTXOs approaching expiry
3. **Use regtest** for development, mainnet only for production
4. **Implement spending controls** in your agent logic (per-tx caps, daily budgets)
5. **Monitor transaction history** for unexpected outgoing activity

## Network Configuration

| Network | ARK Server | Delegator | Notes |
|---------|-----------|-----------|-------|
| bitcoin | `https://arkade.computer` | `https://delegate.arkade.money` | Production mainnet |
| mutinynet | `https://mutinynet.arkade.sh` | `https://delegator.mutinynet.arkade.sh` | Testing |
| regtest | `http://localhost:7070` | N/A | Local development |

## Environment Variables

```bash
# Required
ARK_MNEMONIC=           # 12/24 word BIP39 mnemonic
ARK_SERVER_URL=         # Arkade server URL (default: https://arkade.computer)

# Optional
ARK_NETWORK=bitcoin     # bitcoin | mutinynet | regtest
ARK_DELEGATOR_URL=      # Delegator URL (default: https://delegate.arkade.money for mainnet)
```
