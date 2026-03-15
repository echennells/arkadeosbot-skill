import "dotenv/config";
import { EventSource } from "eventsource";
if (typeof globalThis.EventSource === "undefined") {
  globalThis.EventSource = EventSource;
}
import {
  Wallet,
  SingleKey,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  RestDelegatorProvider,
} from "@arkade-os/sdk";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";
import { decode } from "light-bolt11-decoder";

const DERIVATION_PATH = "m/44'/1237'/0'";

const NETWORK_DEFAULTS = {
  bitcoin: {
    arkServerUrl: "https://arkade.computer",
    boltzUrl: "https://api.ark.boltz.exchange",
    delegatorUrl: "https://delegate.arkade.money",
  },
  mutinynet: {
    arkServerUrl: "https://mutinynet.arkade.sh",
    boltzUrl: "https://api.boltz.mutinynet.arkade.sh",
    delegatorUrl: "https://delegator.mutinynet.arkade.sh",
  },
  regtest: {
    arkServerUrl: "http://localhost:7070",
    boltzUrl: "http://localhost:9069",
    delegatorUrl: null,
  },
};

const VALID_NETWORKS = new Set(Object.keys(NETWORK_DEFAULTS));

function deriveKeyFromMnemonic(mnemonic) {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid BIP39 mnemonic: checksum failed or contains invalid words");
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const key = master.derive(DERIVATION_PATH).deriveChild(0).deriveChild(0);
  return hex.encode(key.privateKey);
}

function validateAmount(amountSats, label = "amount") {
  if (typeof amountSats !== "number" || !Number.isFinite(amountSats)) {
    throw new Error(`${label} must be a finite number (got ${amountSats})`);
  }
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error(`${label} must be a positive integer (got ${amountSats})`);
  }
}

export class ArkadeAgent {
  #wallet;
  #boltzUrl;

  constructor(wallet, boltzUrl) {
    this.#wallet = wallet;
    this.#boltzUrl = boltzUrl;
  }

  static async create(mnemonic, options = {}) {
    const network = options.network || process.env.ARK_NETWORK || "bitcoin";
    if (!VALID_NETWORKS.has(network)) {
      throw new Error(
        `Unknown network "${network}". Valid networks: ${[...VALID_NETWORKS].join(", ")}`,
      );
    }
    const defaults = NETWORK_DEFAULTS[network];
    const arkServerUrl =
      options.arkServerUrl ||
      process.env.ARK_SERVER_URL ||
      defaults.arkServerUrl;
    const boltzUrl =
      options.boltzUrl || process.env.BOLTZ_URL || defaults.boltzUrl;
    const delegatorUrl =
      options.delegatorUrl || process.env.ARK_DELEGATOR_URL || defaults.delegatorUrl;

    if (!mnemonic) {
      throw new Error("Mnemonic is required. Run wallet-setup.js first to generate one.");
    }

    const privateKeyHex = deriveKeyFromMnemonic(mnemonic);
    const identity = SingleKey.fromHex(privateKeyHex);

    const walletConfig = {
      identity,
      arkServerUrl,
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
    };

    if (delegatorUrl) {
      walletConfig.delegatorProvider = new RestDelegatorProvider(delegatorUrl);
    }

    const wallet = await Wallet.create(walletConfig);

    return new ArkadeAgent(wallet, boltzUrl);
  }

  // --- Identity ---

  async getIdentity() {
    const address = await this.#wallet.getAddress();
    const boardingAddress = await this.#wallet.getBoardingAddress();
    return { address, boardingAddress };
  }

  // --- Balance ---

  async getBalance() {
    const balance = await this.#wallet.getBalance();
    const rawAssets = balance.assets || [];
    const assets = await Promise.all(
      rawAssets.map(async (a) => {
        try {
          const details = await this.getAssetDetails(a.assetId);
          return { ...a, ...details.metadata };
        } catch {
          return a;
        }
      }),
    );
    return {
      total: balance.total.toString(),
      offchain: (balance.offchain || 0n).toString(),
      onchain: (balance.onchain || 0n).toString(),
      assets,
    };
  }

  // --- Deposits ---

  async getDepositAddress() {
    return await this.#wallet.getBoardingAddress();
  }

  // --- Ark Transfers (off-chain) ---

  async transfer(recipientAddress, amountSats) {
    validateAmount(amountSats, "transfer amount");
    return await this.#wallet.send({
      address: recipientAddress,
      amount: amountSats,
    });
  }

  // --- Lightning (via Boltz) ---

  async createLightningInvoice(amountSats, memo) {
    validateAmount(amountSats, "invoice amount");
    if (amountSats < 100) {
      throw new Error(`Boltz reverse swap minimum is 100 sats (requested ${amountSats})`);
    }
    const response = await fetch(`${this.#boltzUrl}/v2/swap/reverse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "BTC",
        to: "ARK",
        invoiceAmount: amountSats,
        description: memo || "",
        claimAddress: await this.#wallet.getAddress(),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Boltz reverse swap failed: ${err}`);
    }

    const swap = await response.json();
    return {
      invoice: swap.invoice,
      swapId: swap.id,
      swap,
    };
  }

  async payLightningInvoice(bolt11, maxFeeSats = 100) {
    const decoded = decode(bolt11);
    const amountSection = decoded.sections.find((s) => s.name === "amount");
    if (!amountSection?.value) {
      throw new Error("Zero-amount invoices are not supported — the invoice must specify an amount");
    }
    const amountSats = Math.ceil(Number(amountSection.value) / 1000);

    if (amountSats < 333) {
      throw new Error(`Boltz submarine swap minimum is 333 sats (invoice is ${amountSats})`);
    }

    const cpk = await this.#wallet.identity.compressedPublicKey();
    const refundPublicKey = hex.encode(new Uint8Array(cpk));

    const response = await fetch(`${this.#boltzUrl}/v2/swap/submarine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "ARK",
        to: "BTC",
        invoice: bolt11,
        refundPublicKey,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Boltz submarine swap failed: ${err}`);
    }

    const swap = await response.json();

    // Enforce fee cap
    const fee = swap.expectedAmount - amountSats;
    if (fee > maxFeeSats) {
      throw new Error(
        `Boltz swap fee ${fee} sats exceeds maxFeeSats ${maxFeeSats} (invoice: ${amountSats}, swap expects: ${swap.expectedAmount})`,
      );
    }

    // Send VTXOs to Boltz swap address
    const txid = await this.#wallet.send({
      address: swap.address,
      amount: swap.expectedAmount,
    });

    const fee = swap.expectedAmount - amountSats;
    return { txid, swapId: swap.id, amountSats, fee, swap };
  }

  // --- Withdrawal (Collaborative Exit to L1) ---

  async withdraw(onchainAddress, amountSats) {
    validateAmount(amountSats, "withdrawal amount");
    const FEE_PER_OUTPUT = 200; // ASP charges 200 sats per on-chain output
    const DUST_LIMIT = 330; // minimum VTXO amount

    const vtxos = await this.#wallet.getVtxos();
    const sorted = vtxos.sort(
      (a, b) =>
        (a.virtualStatus?.batchExpiry ?? 0) -
        (b.virtualStatus?.batchExpiry ?? 0),
    );

    // Only the on-chain withdrawal output costs 200 sats.
    // Change goes to an Ark address (offchain) which is free.
    const minTarget = amountSats + FEE_PER_OUTPUT;
    let selected = [];
    let selectedAmount = 0;
    for (const vtxo of sorted) {
      selected.push(vtxo);
      selectedAmount += vtxo.value;
      if (selectedAmount >= minTarget) break;
    }

    if (selectedAmount < minTarget) {
      throw new Error(
        `Insufficient funds: have ${selectedAmount}, need ${minTarget} (includes ${FEE_PER_OUTPUT} sat fee)`,
      );
    }

    const change = selectedAmount - amountSats - FEE_PER_OUTPUT;

    const outputs = [{ address: onchainAddress, amount: BigInt(amountSats) }];

    // Change goes back as an offchain VTXO (no extra fee), but must meet dust limit
    if (change >= DUST_LIMIT) {
      const arkAddr = await this.#wallet.getAddress();
      outputs.push({ address: arkAddr, amount: BigInt(change) });
    }
    // else: remainder is donated to fees (too small for a change output)

    return await this.#wallet.settle({ inputs: selected, outputs });
  }

  // --- VTXO Management ---

  async getVtxoStatus() {
    const vtxos = await this.#wallet.getVtxos();
    const now = Date.now();
    return vtxos.map((v) => ({
      txid: v.txid,
      value: v.value,
      expiresAt: v.virtualStatus?.batchExpiry,
      expiresIn: v.virtualStatus?.batchExpiry
        ? v.virtualStatus.batchExpiry - now
        : null,
      state: v.virtualStatus?.state,
    }));
  }

  async consolidateVtxos() {
    const vtxos = await this.#wallet.getVtxos();
    if (vtxos.length <= 1) return { consolidated: false, reason: "already 1 or 0 VTXOs" };

    const beforeTotal = vtxos.reduce((sum, v) => sum + v.value, 0);
    // settle() with no params merges all VTXOs into one, deducting fees
    const txid = await this.#wallet.settle();
    const afterVtxos = await this.#wallet.getVtxos();
    const afterTotal = afterVtxos.reduce((sum, v) => sum + v.value, 0);

    return {
      consolidated: true,
      txid,
      before: { count: vtxos.length, total: beforeTotal },
      after: { count: afterVtxos.length, total: afterTotal },
      feePaid: beforeTotal - afterTotal,
    };
  }

  /**
   * Delegate VTXOs to the delegator service for automatic renewal.
   * The delegator renews VTXOs on your behalf at ~10% before expiry.
   * Requires delegatorUrl to be configured (enabled by default on mainnet).
   */
  async delegateVtxos() {
    const dm = await this.#wallet.getDelegatorManager();
    if (!dm) {
      throw new Error("Delegation not available — no delegatorUrl configured");
    }

    const vtxos = await this.#wallet.getVtxos();
    if (vtxos.length === 0) return { delegated: 0, failed: 0 };

    const destination = await this.#wallet.getAddress();
    const result = await dm.delegate(vtxos, destination);

    return {
      delegated: result.delegated.length,
      failed: result.failed.length,
      failures: result.failed.length > 0 ? result.failed : undefined,
    };
  }

  /**
   * Manually renew expiring VTXOs. Prefer delegateVtxos() for automatic renewal.
   * Only needed if delegation is unavailable or as a fallback.
   */
  async renewVtxos(thresholdMs = 86400000) {
    if (typeof thresholdMs !== "number" || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      throw new Error(`thresholdMs must be a positive number (got ${thresholdMs})`);
    }

    const vtxos = await this.#wallet.getVtxos();
    const now = Date.now();
    const expiring = vtxos.filter(
      (v) =>
        v.virtualStatus?.batchExpiry &&
        v.virtualStatus.batchExpiry - now < thresholdMs,
    );

    if (expiring.length === 0) return { renewed: 0 };

    // Use settle() with no params — the SDK auto-selects all VTXOs,
    // sends them back to self, and handles fee deduction correctly.
    const txid = await this.#wallet.settle();

    return { renewed: expiring.length, txid };
  }

  // --- Assets ---

  async getAssetDetails(assetId) {
    return await this.#wallet.assetManager.getAssetDetails(assetId);
  }

  async transferAssets(recipientAddress, assets, amountSats = 0) {
    if (amountSats < 0 || !Number.isFinite(amountSats)) {
      throw new Error(`amount must be a non-negative finite number (got ${amountSats})`);
    }
    if (!assets || !Array.isArray(assets) || assets.length === 0) {
      throw new Error("assets must be a non-empty array");
    }
    return await this.#wallet.send({
      address: recipientAddress,
      amount: amountSats,
      assets,
    });
  }

  // --- Message Signing ---

  async signMessage(text) {
    const message = new TextEncoder().encode(text);
    return await this.#wallet.identity.signMessage(message, "schnorr");
  }

  // --- L402 Paywalls ---

  async fetchL402(url, options = {}) {
    const { method = "GET", headers = {}, body, maxFeeSats = 100 } = options;
    const reqHeaders = { "Content-Type": "application/json", ...headers };
    const reqBody = body ? JSON.stringify(body) : undefined;

    const initialResponse = await fetch(url, {
      method,
      headers: reqHeaders,
      body: reqBody,
    });

    if (initialResponse.status !== 402) {
      const ct = initialResponse.headers.get("content-type") || "";
      const data = ct.includes("json")
        ? await initialResponse.json()
        : await initialResponse.text();
      return { paid: false, data };
    }

    // Parse L402 challenge
    let invoice, macaroon;
    const wwwAuth = initialResponse.headers.get("www-authenticate") || "";
    const l402Header =
      wwwAuth.split('L402 macaroon="')[1] ||
      wwwAuth.split('LSAT macaroon="')[1];
    if (l402Header) {
      macaroon = l402Header.split('"')[0];
      invoice = l402Header.split('invoice="')[1]?.split('"')[0];
    }
    if (!invoice || !macaroon) {
      const ct = initialResponse.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const challenge = await initialResponse.json();
        invoice = invoice || challenge.invoice || challenge.payment_request || challenge.pr;
        macaroon = macaroon || challenge.macaroon || challenge.token;
      }
    }
    if (!invoice || !macaroon) {
      throw new Error("Invalid L402 response: missing invoice or macaroon");
    }

    const decoded = decode(invoice);
    const amountSection = decoded.sections.find((s) => s.name === "amount");
    const amountSats = amountSection
      ? Math.ceil(Number(amountSection.value) / 1000)
      : 0;

    // Pay via Boltz submarine swap
    const payResult = await this.payLightningInvoice(invoice, maxFeeSats);

    // Retry with auth (use swap preimage once available)
    // Note: Boltz submarine swaps reveal the preimage on completion.
    // For now, we poll the swap status.
    let preimage = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(
        `${this.#boltzUrl}/v2/swap/${payResult.swapId}`,
      );
      if (statusRes.ok) {
        const status = await statusRes.json();
        if (status.status === "transaction.claimed") {
          if (!status.preimage) {
            throw new Error("Boltz swap claimed but no preimage returned");
          }
          preimage = status.preimage;
          break;
        }
        if (
          status.status === "transaction.failed" ||
          status.status === "swap.expired"
        ) {
          throw new Error(`L402 payment failed: ${status.status}`);
        }
      }
    }

    if (!preimage) {
      throw new Error("L402 payment timed out waiting for preimage");
    }

    const finalResponse = await fetch(url, {
      method,
      headers: {
        ...reqHeaders,
        Authorization: `L402 ${macaroon}:${preimage}`,
      },
      body: reqBody,
    });

    const ct = finalResponse.headers.get("content-type") || "";
    const data = ct.includes("json")
      ? await finalResponse.json()
      : await finalResponse.text();

    return { paid: true, amountSats, preimage, data };
  }

  async previewL402(url) {
    const response = await fetch(url);
    if (response.status !== 402) return { requiresPayment: false };

    let invoice;
    const wwwAuth = response.headers.get("www-authenticate") || "";
    const l402Header =
      wwwAuth.split('L402 macaroon="')[1] ||
      wwwAuth.split('LSAT macaroon="')[1];
    if (l402Header) {
      invoice = l402Header.split('invoice="')[1]?.split('"')[0];
    }
    if (!invoice) {
      const ct = response.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const body = await response.json();
        invoice = body.invoice || body.payment_request || body.pr;
      }
    }
    if (!invoice) return { requiresPayment: true, amountSats: null };

    const decoded = decode(invoice);
    const amountSection = decoded.sections.find((s) => s.name === "amount");
    const amountSats = amountSection
      ? Math.ceil(Number(amountSection.value) / 1000)
      : null;

    return { requiresPayment: true, amountSats, invoice };
  }

  // --- Transaction History ---

  async getTransactionHistory() {
    return await this.#wallet.getTransactionHistory();
  }

  // --- Lifecycle ---

  cleanup() {
    // Wallet cleanup if needed
  }
}

// --- Demo ---

async function main() {
  if (!process.env.ARK_MNEMONIC) {
    console.error("ARK_MNEMONIC not set. Run wallet-setup.js first.");
    process.exit(1);
  }

  const network = process.env.ARK_NETWORK || "bitcoin";
  const agent = await ArkadeAgent.create(process.env.ARK_MNEMONIC, { network });

  const identity = await agent.getIdentity();
  console.log("=== Agent Identity ===");
  console.log("Ark Address:     ", identity.address);
  console.log("Boarding Address:", identity.boardingAddress);

  const balance = await agent.getBalance();
  console.log("\n=== Balance ===");
  console.log("Total:    ", balance.total, "sats");
  console.log("Off-chain:", balance.offchain, "sats");
  console.log("On-chain: ", balance.onchain, "sats");

  if (balance.assets.length > 0) {
    console.log("\n=== Assets ===");
    for (const asset of balance.assets) {
      const label = asset.name || asset.ticker || asset.assetId;
      console.log(`  ${label}: ${asset.amount}${asset.ticker ? ` ${asset.ticker}` : ""}`);
    }
  }

  const vtxoStatus = await agent.getVtxoStatus();
  if (vtxoStatus.length > 0) {
    console.log("\n=== VTXOs ===");
    for (const v of vtxoStatus) {
      const hoursLeft = v.expiresIn
        ? (v.expiresIn / 3600000).toFixed(1)
        : "unknown";
      console.log(
        `  ${v.txid.slice(0, 12)}... ${v.value} sats (expires in ${hoursLeft}h)`,
      );
    }
  }

  // Delegate VTXOs for automatic renewal (free, runs on startup)
  console.log("\n=== Delegation ===");
  try {
    const result = await agent.delegateVtxos();
    console.log(`Delegated: ${result.delegated}, Failed: ${result.failed}`);
  } catch (err) {
    console.log("Delegation unavailable:", err.message);
  }

  agent.cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
