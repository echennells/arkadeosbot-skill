---
name: arkadebot
description: Set up Arkade OS Bitcoin wallet capabilities for AI agents. Initialize wallets from mnemonic, transfer sats and assets, create/pay Lightning invoices via Boltz swaps, pay L402 paywalls, manage VTXOs and their expiry, handle deposits and withdrawals. Use when user mentions "Arkade wallet," "Ark protocol," "Arkade Bitcoin," "VTXO," "Arkade SDK," "Arkade payment," "Arkade transfer," "boarding address," "Bitcoin L2 wallet on Ark," "agent wallet on Arkade," "Lightning," "Lightning invoice," "BOLT11," "pay invoice," "send sats," "receive sats," "Bitcoin wallet," "Bitcoin payment," "send Bitcoin," "receive Bitcoin," or wants Bitcoin/Lightning/sats capabilities for an agent.
argument-hint: "[Optional: specify what to set up - wallet, payments, tokens, lightning, l402, vtxo-management, or full]"
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

You are an expert in setting up Arkade Bitcoin wallet capabilities for AI agents using `@arkade-os/sdk` and `@arkade-os/boltz-swap`.

Arkade is a Bitcoin Layer 2 built on the Ark protocol. It uses Virtual Transaction Outputs (VTXOs) for instant off-chain payments with batched on-chain settlement. Unlike Lightning, there are no channels to manage. Unlike Spark, VTXOs have expiry timestamps and must be renewed periodically. Lightning Network interoperability is provided through Boltz Exchange swaps. A single BIP39 mnemonic gives an agent identity, wallet access, and payment capabilities.

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
| Lightning | Via Boltz swaps | Built-in | Native | N/A |
| Setup | Mnemonic + ASP URL | Mnemonic only | Node or hosted | Keys only |

### Fee Structure

| Operation | Fee |
|-----------|-----|
| **Off-chain transfer (Ark-to-Ark)** | Free (offchain inputs/outputs currently 0 sats) |
| **Lightning receive (via Boltz)** | ~0.1% + 19 sats miner fee. **Min 100 sats, max 25M sats** |
| **Lightning send (via Boltz)** | ~0.1% + miner fee. **Min 333 sats, max ~2M sats** |
| **L1 deposit (boarding)** | On-chain tx fee (paid by user) |
| **Collaborative exit to L1** | 200 sats per on-chain output (set by ASP). Offchain change outputs are free. |
| **Unilateral exit to L1** | On-chain tx fee (user pays, higher than collaborative) |

**Boltz swap limits:** Lightning payments via Boltz have minimum amounts. Receiving requires at least 100 sats; sending requires at least 333 sats. Maximum is ~2,000,001 sats per swap.

**Collaborative exit cooldown:** VTXOs must be at least ~24 hours old before they can be used in a `settle()` (collaborative exit to L1). The ASP enforces a `minExpiryGap` of ~696 hours — since VTXOs have a ~720 hour (~30 day) lifetime, they need ~24 hours to age past this threshold. This does NOT affect Ark-to-Ark transfers, Lightning payments, or any other operation — only on-chain exits.

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
- **Lightning is indirect** -- Lightning payments require Boltz swaps (adds latency and fees vs native)
- **Boarding timelock** -- On-chain deposits take time to become fully available as VTXOs

## Tools Available

| Tool | Purpose |
|------|---------|
| @arkade-os/sdk | TypeScript wallet SDK for Ark protocol |
| @arkade-os/boltz-swap | Lightning integration via Boltz Exchange |
| Boltz Exchange | Submarine/reverse swap provider |

## Required Libraries

```bash
npm install @arkade-os/sdk@^0.4.4 @arkade-os/boltz-swap@^0.3.3 @scure/bip32 @scure/bip39 @scure/base dotenv eventsource
```

Multiple dependencies because key derivation is handled externally (unlike Spark SDK which bundles BIP39 internally).

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
import { Wallet, SingleKey, InMemoryWalletRepository, InMemoryContractRepository } from "@arkade-os/sdk";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";

const DERIVATION_PATH = "m/44'/1237'/0'";

function deriveKeyFromMnemonic(mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const key = master.derive(DERIVATION_PATH).deriveChild(0).deriveChild(0);
  return hex.encode(key.privateKey);
}

// Option A: Generate a new wallet
const mnemonic = generateMnemonic(wordlist);
// Save mnemonic securely -- NEVER log it in production

// Option B: Import existing wallet from mnemonic
const mnemonic = process.env.ARK_MNEMONIC;

// Create identity and wallet
const privateKeyHex = deriveKeyFromMnemonic(mnemonic);
const identity = SingleKey.fromHex(privateKeyHex);

import { RestDelegatorProvider } from "@arkade-os/sdk";

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

Note on derivation path: `m/44'/1237'/0'` uses BIP44 with coin type 1237 (Ark). The additional `.deriveChild(0).deriveChild(0)` gives external chain, first address.

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

## Lightning Interop (via Boltz)

Arkade does not have native Lightning support. All Lightning operations go through Boltz Exchange swaps. This adds latency and swap fees compared to Spark's native Lightning, but provides full BOLT11 compatibility.

### Create Lightning Invoice (Receive via Reverse Swap)

```javascript
const boltzUrl = process.env.BOLTZ_URL || "https://api.ark.boltz.exchange";
const arkAddress = await wallet.getAddress();

const response = await fetch(`${boltzUrl}/v2/swap/reverse`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    from: "BTC",
    to: "ARK",
    invoiceAmount: 1000,
    description: "Payment for AI service",
    claimAddress: arkAddress,
  }),
});

const swap = await response.json();
console.log("BOLT11:", swap.invoice);  // Share this with the payer
console.log("Swap ID:", swap.id);      // Monitor swap status
```

How it works: Boltz creates a Lightning invoice. When the payer pays it, Boltz sends the equivalent amount to your Ark address as a VTXO.

### Pay Lightning Invoice (Send via Submarine Swap)

```javascript
const response = await fetch(`${boltzUrl}/v2/swap/submarine`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    from: "ARK",
    to: "BTC",
    invoice: "lnbc...",  // BOLT11 invoice to pay
  }),
});

const swap = await response.json();

// Send VTXOs to Boltz swap address
const txid = await wallet.send({
  address: swap.address,
  amount: swap.expectedAmount,
});
console.log("Submarine swap sent:", txid);
```

How it works: You send VTXOs to Boltz's swap address. Boltz pays the Lightning invoice on your behalf.

### Monitor Swap Status

```javascript
const statusRes = await fetch(`${boltzUrl}/v2/swap/${swapId}`);
const status = await statusRes.json();
console.log("Swap status:", status.status);
// Possible: "swap.created", "transaction.mempool", "transaction.confirmed",
//           "transaction.claimed", "transaction.failed", "swap.expired"
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
// Sign
const message = new TextEncoder().encode("I am agent-007");
const signature = await wallet.identity.signMessage(message, "schnorr");

// Verify using the xOnly public key
const pubkey = hex.encode(new Uint8Array(await wallet.identity.compressedPublicKey()));
```

## Complete Agent Class

The full `ArkadeAgent` class is in **`examples/arkade-agent.js`** — a single-file, production-ready agent with all capabilities:

| Method | Description |
|--------|-------------|
| `ArkadeAgent.create(mnemonic, options)` | Static factory — sets up wallet with delegation, network defaults |
| `getIdentity()` | Ark address + boarding address |
| `getBalance()` | BTC balance + asset balances with metadata |
| `getDepositAddress()` | Boarding address for on-chain deposits |
| `transfer(address, amount)` | Off-chain Ark-to-Ark transfer |
| `createLightningInvoice(amount, memo)` | Receive via Boltz reverse swap (min 100 sats) |
| `payLightningInvoice(bolt11, maxFee)` | Send via Boltz submarine swap (min 333 sats) |
| `withdraw(onchainAddress, amount)` | Collaborative exit to L1 (200 sat fee per on-chain output) |
| `consolidateVtxos()` | Merge multiple VTXOs into one |
| `delegateVtxos()` | Register VTXOs for automatic renewal |
| `renewVtxos(thresholdMs)` | Manual renewal fallback |
| `getVtxoStatus()` | VTXO expiry details |
| `transferAssets(address, assets, amount)` | Send Arkade Assets |
| `getAssetDetails(assetId)` | Asset metadata |
| `fetchL402(url, options)` | Pay L402 paywalls automatically |
| `previewL402(url)` | Check L402 cost without paying |
| `signMessage(text)` | Schnorr signature for identity proof |
| `getTransactionHistory()` | Transaction log |

**Usage:**

```javascript
import { ArkadeAgent } from "./examples/arkade-agent.js";

const agent = await ArkadeAgent.create(process.env.ARK_MNEMONIC);
const { address } = await agent.getIdentity();
const { total } = await agent.getBalance();

// Delegate VTXOs on startup (recommended)
await agent.delegateVtxos();
```

See also: `examples/l402-paywalls.js` for a standalone L402 client with token caching.

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
- **Boltz swap failure** -- Swap expired, insufficient liquidity, or network issues

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

## L402 Protocol (Lightning Paywalls)

L402 works the same as with Spark, except the Lightning payment step goes through a Boltz submarine swap instead of a native SDK call. This adds latency (~10-60 seconds for swap completion) but is functionally equivalent.

### How L402 Works with Arkade

1. **Request** -- Client fetches protected URL
2. **402 Response** -- Server returns invoice + macaroon
3. **Boltz Submarine Swap** -- Client creates swap, sends VTXOs to Boltz, Boltz pays the Lightning invoice
4. **Get Preimage** -- Poll Boltz swap status for the payment preimage
5. **Retry with Auth** -- Client retries with `Authorization: L402 <macaroon>:<preimage>`
6. **200 Response** -- Server returns protected content

### L402 Implementation

See `fetchL402()` and `previewL402()` in `examples/arkade-agent.js`, or the standalone `examples/l402-paywalls.js` for a client with domain-based token caching.

### L402 Limitations

**Minimum 333 sats.** L402 payments go through Boltz submarine swaps, which have a 333 sat minimum. Paywalls charging less than 333 sats cannot be paid via Arkade.

**Slower than Spark.** Because Lightning payments go through Boltz swaps, L402 requests take longer:
- **Spark L402**: ~1-3 seconds (native Lightning payment)
- **Arkade L402**: ~10-60 seconds (Boltz submarine swap + settlement)

Cache L402 tokens by domain to avoid paying for repeat requests.

## Network Configuration

| Network | ARK Server | Boltz API | Delegator | Notes |
|---------|-----------|-----------|-----------|-------|
| bitcoin | `https://arkade.computer` | `https://api.ark.boltz.exchange` | `https://delegate.arkade.money` | Production mainnet |
| mutinynet | `https://mutinynet.arkade.sh` | `https://api.boltz.mutinynet.arkade.sh` | `https://delegator.mutinynet.arkade.sh` | Testing |
| regtest | `http://localhost:7070` | `http://localhost:9069` | N/A | Local development |

## Environment Variables

```bash
# Required
ARK_MNEMONIC=           # 12/24 word BIP39 mnemonic
ARK_SERVER_URL=         # Arkade server URL (default: https://arkade.computer)

# Optional
ARK_NETWORK=bitcoin     # bitcoin | mutinynet | regtest
BOLTZ_URL=              # Boltz API (auto-detected from network)
ARK_DELEGATOR_URL=      # Delegator URL (default: https://delegate.arkade.money for mainnet)
```
