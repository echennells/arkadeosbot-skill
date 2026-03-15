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
import { ArkadeSwaps, getInvoiceSatoshis, decodeInvoice } from "@arkade-os/boltz-swap";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";

const DERIVATION_PATH = "m/44'/1237'/0'";

const NETWORK_DEFAULTS = {
  bitcoin: {
    arkServerUrl: "https://arkade.computer",
    delegatorUrl: "https://delegate.arkade.money",
  },
  mutinynet: {
    arkServerUrl: "https://mutinynet.arkade.sh",
    delegatorUrl: "https://delegator.mutinynet.arkade.sh",
  },
  regtest: {
    arkServerUrl: "http://localhost:7070",
    delegatorUrl: null,
  },
};

const VALID_NETWORKS = new Set(Object.keys(NETWORK_DEFAULTS));

/**
 * In-memory SwapRepository for Node.js (the default IndexedDbSwapRepository
 * only works in browsers). Swap state is ephemeral — fine for agent use
 * since swaps complete within seconds/minutes.
 */
class InMemorySwapRepository {
  version = 1;
  #swaps = new Map();

  async saveSwap(swap) {
    this.#swaps.set(swap.id, { ...swap });
  }

  async deleteSwap(id) {
    this.#swaps.delete(id);
  }

  async getAllSwaps(filter) {
    let swaps = [...this.#swaps.values()];
    if (filter?.id) {
      const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
      swaps = swaps.filter((s) => ids.includes(s.id));
    }
    if (filter?.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      swaps = swaps.filter((s) => types.includes(s.type));
    }
    if (filter?.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      swaps = swaps.filter((s) => statuses.includes(s.status));
    }
    if (filter?.orderBy === "createdAt") {
      const dir = filter.orderDirection === "desc" ? -1 : 1;
      swaps.sort((a, b) => dir * ((a.createdAt || 0) - (b.createdAt || 0)));
    }
    return swaps;
  }

  async clear() {
    this.#swaps.clear();
  }

  async [Symbol.asyncDispose]() {
    this.#swaps.clear();
  }
}

function deriveKeyFromMnemonic(mnemonic) {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error(
      "Invalid BIP39 mnemonic: checksum failed or contains invalid words",
    );
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
  #swaps;

  constructor(wallet, swaps) {
    this.#wallet = wallet;
    this.#swaps = swaps;
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
    const delegatorUrl =
      options.delegatorUrl ||
      process.env.ARK_DELEGATOR_URL ||
      defaults.delegatorUrl;

    if (!mnemonic) {
      throw new Error(
        "Mnemonic is required. Run wallet-setup.js first to generate one.",
      );
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

    // ArkadeSwaps auto-detects the Boltz URL from the wallet's network
    const swaps = await ArkadeSwaps.create({
      wallet,
      swapRepository: new InMemorySwapRepository(),
      swapManager: false, // agent manages its own swap lifecycle
    });

    return new ArkadeAgent(wallet, swaps);
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

  // --- Lightning (via @arkade-os/boltz-swap) ---

  async createLightningInvoice(amountSats, memo) {
    validateAmount(amountSats, "invoice amount");
    if (amountSats < 100) {
      throw new Error(
        `Boltz reverse swap minimum is 100 sats (requested ${amountSats})`,
      );
    }

    const result = await this.#swaps.createLightningInvoice({
      amount: amountSats,
      description: memo || "",
    });

    return {
      invoice: result.invoice,
      amount: result.amount,
      expiry: result.expiry,
      paymentHash: result.paymentHash,
      pendingSwap: result.pendingSwap,
    };
  }

  /**
   * Wait for a Lightning invoice to be paid and claim the funds.
   * Monitors the swap via WebSocket and claims the VHTLC when payment arrives.
   * @param pendingSwap - The pendingSwap from createLightningInvoice()
   * @returns { txid } - The transaction ID of the claimed VHTLC
   */
  async waitForInvoicePayment(pendingSwap) {
    return await this.#swaps.waitAndClaim(pendingSwap);
  }

  /**
   * Claim a reverse swap that has already been paid (e.g. stuck at transaction.mempool).
   * @param pendingSwap - The pendingSwap from createLightningInvoice()
   */
  async claimInvoicePayment(pendingSwap) {
    await this.#swaps.claimVHTLC(pendingSwap);
  }

  async payLightningInvoice(bolt11, maxFeeSats = 100) {
    const invoiceSats = getInvoiceSatoshis(bolt11);
    if (invoiceSats === 0) {
      throw new Error(
        "Zero-amount invoices are not supported — the invoice must specify an amount",
      );
    }
    if (invoiceSats < 333) {
      throw new Error(
        `Boltz submarine swap minimum is 333 sats (invoice is ${invoiceSats})`,
      );
    }

    // Pre-check fees before committing funds
    const fees = await this.#swaps.getFees();
    const estimatedFee =
      Math.ceil((invoiceSats * fees.percentage) / 100) +
      (fees.minerFees?.normal || fees.minerFees || 0);
    if (estimatedFee > maxFeeSats) {
      throw new Error(
        `Estimated Boltz swap fee ~${estimatedFee} sats exceeds maxFeeSats ${maxFeeSats}`,
      );
    }

    const result = await this.#swaps.sendLightningPayment({ invoice: bolt11 });
    const actualFee = result.amount - invoiceSats;

    return {
      txid: result.txid,
      preimage: result.preimage,
      amountSats: invoiceSats,
      fee: actualFee,
    };
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
    if (vtxos.length <= 1)
      return { consolidated: false, reason: "already 1 or 0 VTXOs" };

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
      throw new Error(
        "Delegation not available — no delegatorUrl configured",
      );
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
    if (
      typeof thresholdMs !== "number" ||
      !Number.isFinite(thresholdMs) ||
      thresholdMs <= 0
    ) {
      throw new Error(
        `thresholdMs must be a positive number (got ${thresholdMs})`,
      );
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
      throw new Error(
        `amount must be a non-negative finite number (got ${amountSats})`,
      );
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
    const sig = await this.#wallet.identity.signMessage(message, "schnorr");
    return hex.encode(new Uint8Array(sig));
  }

  // --- L402 Paywalls ---

  /**
   * Fetch content from an L402-protected endpoint.
   * If 402 Payment Required, pays the invoice via Boltz and retries with the preimage.
   */
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
    const { invoice, macaroon } = await parseL402Challenge(initialResponse);

    const amountSats = getInvoiceSatoshis(invoice);

    // Pay via Boltz — sendLightningPayment returns the preimage directly
    const payResult = await this.payLightningInvoice(invoice, maxFeeSats);

    // Retry with L402 authorization
    const finalResponse = await fetch(url, {
      method,
      headers: {
        ...reqHeaders,
        Authorization: `L402 ${macaroon}:${payResult.preimage}`,
      },
      body: reqBody,
    });

    const ct = finalResponse.headers.get("content-type") || "";
    const data = ct.includes("json")
      ? await finalResponse.json()
      : await finalResponse.text();

    return { paid: true, amountSats, preimage: payResult.preimage, data };
  }

  /**
   * Preview L402 cost without paying.
   */
  async previewL402(url) {
    const response = await fetch(url);
    if (response.status !== 402) return { requiresPayment: false };

    try {
      const { invoice } = await parseL402Challenge(response);
      const amountSats = getInvoiceSatoshis(invoice);
      return { requiresPayment: true, amountSats, invoice };
    } catch {
      return { requiresPayment: true, amountSats: null };
    }
  }

  // --- Transaction History ---

  async getTransactionHistory() {
    return await this.#wallet.getTransactionHistory();
  }

  // --- Lifecycle ---

  async cleanup() {
    await this.#swaps.dispose();
  }
}

/**
 * Parse an L402/LSAT challenge from a 402 response.
 * Checks WWW-Authenticate header first, then falls back to JSON body.
 * Must be awaited because the JSON body fallback is async.
 */
async function parseL402Challenge(response) {
  let invoice, macaroon;

  const wwwAuth = response.headers.get("www-authenticate") || "";
  const l402Header =
    wwwAuth.split('L402 macaroon="')[1] ||
    wwwAuth.split('LSAT macaroon="')[1];
  if (l402Header) {
    macaroon = l402Header.split('"')[0];
    invoice = l402Header.split('invoice="')[1]?.split('"')[0];
  }

  if (!invoice || !macaroon) {
    const ct = response.headers.get("content-type") || "";
    if (ct.includes("json")) {
      const challenge = await response.json();
      invoice =
        invoice || challenge.invoice || challenge.payment_request || challenge.pr;
      macaroon = macaroon || challenge.macaroon || challenge.token;
    }
  }

  if (!invoice || !macaroon) {
    throw new Error(
      "Invalid L402 response: missing invoice or macaroon",
    );
  }

  return { invoice, macaroon };
}

// --- Demo ---

async function main() {
  if (!process.env.ARK_MNEMONIC) {
    console.error("ARK_MNEMONIC not set. Run wallet-setup.js first.");
    process.exit(1);
  }

  const network = process.env.ARK_NETWORK || "bitcoin";
  const agent = await ArkadeAgent.create(process.env.ARK_MNEMONIC, {
    network,
  });

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
      console.log(
        `  ${label}: ${asset.amount}${asset.ticker ? ` ${asset.ticker}` : ""}`,
      );
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

  await agent.cleanup();
  process.exit(0);
}

// Only run demo when executed directly (not when imported as a module)
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("arkade-agent.js");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
