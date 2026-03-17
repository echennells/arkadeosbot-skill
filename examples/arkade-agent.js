import "dotenv/config";
import { EventSource } from "eventsource";
if (typeof globalThis.EventSource === "undefined") {
  globalThis.EventSource = EventSource;
}
import {
  Wallet,
  SingleKey,
  MnemonicIdentity,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  RestDelegatorProvider,
} from "@arkade-os/sdk";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";

const LEGACY_DERIVATION_PATH = "m/44'/1237'/0'";

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
 * Derive a private key using the legacy m/44'/1237'/0' path.
 * Only used for fallback scanning of wallets created by older bot versions
 * or the arkade.money web wallet.
 */
function deriveLegacyKey(mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const key = master.derive(LEGACY_DERIVATION_PATH).deriveChild(0).deriveChild(0);
  return hex.encode(key.privateKey);
}

// 1 BTC in sats — amounts above this trigger a warning (likely unit confusion)
const HIGH_AMOUNT_THRESHOLD_SATS = 100_000_000;

function validateAmount(amountSats, label = "amount", { allowZero = false } = {}) {
  if (typeof amountSats !== "number" || !Number.isFinite(amountSats)) {
    throw new Error(`${label} must be a finite number (got ${amountSats})`);
  }
  const minValue = allowZero ? 0 : 1;
  if (!Number.isInteger(amountSats) || amountSats < minValue) {
    throw new Error(
      `${label} must be a ${allowZero ? "non-negative" : "positive"} integer (got ${amountSats})`,
    );
  }
  if (amountSats > HIGH_AMOUNT_THRESHOLD_SATS) {
    console.warn(
      `Warning: ${label} is ${amountSats} sats (${(amountSats / 1e8).toFixed(8)} BTC). ` +
      "Ensure this is in satoshis, not BTC."
    );
  }
}

// Ark addresses start with ark1 (mainnet) or tark1 (testnet/regtest)
const ARK_ADDRESS_RE = /^t?ark1[a-z0-9]+$/;
// Bitcoin L1 addresses: bech32 (bc1/tb1/bcrt1), P2SH (3/2), P2PKH (1)
const ONCHAIN_ADDRESS_RE = /^(bc1|tb1|bcrt1|[123])[a-zA-Z0-9]+$/;

function validateArkAddress(address, label = "address") {
  if (typeof address !== "string" || !ARK_ADDRESS_RE.test(address)) {
    throw new Error(
      `${label} must be a valid Ark address (starting with ark1 or tark1), got: ${address}`,
    );
  }
}

function validateOnchainAddress(address, label = "address") {
  if (typeof address !== "string" || !ONCHAIN_ADDRESS_RE.test(address)) {
    throw new Error(
      `${label} must be a valid Bitcoin L1 address (bc1/tb1/bcrt1/1/3), got: ${address}`,
    );
  }
}

export class ArkadeAgent {
  #wallet;
  #legacyWallet;

  constructor(wallet, legacyWallet = null) {
    this.#wallet = wallet;
    this.#legacyWallet = legacyWallet;
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
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error(
        "Invalid BIP39 mnemonic: checksum failed or contains invalid words",
      );
    }

    const isMainnet = network === "bitcoin";
    const storageOpts = () => ({
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    });

    const baseConfig = (identity) => {
      const config = { identity, arkServerUrl, storage: storageOpts() };
      if (delegatorUrl) {
        config.delegatorProvider = new RestDelegatorProvider(delegatorUrl);
      }
      return config;
    };

    // Always use BIP-86 as primary wallet (SDK standard, compatible with NArk/BTCPay)
    const bip86Identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet });
    const bip86Wallet = await Wallet.create(baseConfig(bip86Identity));

    // Also check legacy path — funds there need migration, not silent switching
    const legacyIdentity = SingleKey.fromHex(deriveLegacyKey(mnemonic));
    const legacyWallet = await Wallet.create(baseConfig(legacyIdentity));
    const legacyBalance = await legacyWallet.getBalance();

    let legacyRef = null;
    const legacyAssets = legacyBalance.assets || [];
    if (legacyBalance.total > 0n || legacyAssets.length > 0) {
      legacyRef = legacyWallet;
      const bip86Address = await bip86Wallet.getAddress();
      const assetInfo = legacyAssets.length > 0
        ? `\n  Legacy assets: ${legacyAssets.length} asset type(s)`
        : "";
      console.warn(
        "Warning: Funds found under legacy derivation path m/44'/1237'/0'.\n" +
        `  Legacy balance: ${legacyBalance.total.toString()} sats${assetInfo}\n` +
        "  This path is deprecated and these VTXOs will NOT be auto-renewed.\n" +
        "  To migrate, call agent.migrateLegacyFunds() or manually send to:\n" +
        `  ${bip86Address}`
      );
    }

    return new ArkadeAgent(bip86Wallet, legacyRef);
  }

  /**
   * Check if there are funds stranded on the legacy m/44'/1237'/0' path.
   * Returns null if no legacy wallet or zero balance.
   */
  async getLegacyBalance() {
    if (!this.#legacyWallet) return null;
    const balance = await this.#legacyWallet.getBalance();
    const assets = balance.assets || [];
    if (balance.total === 0n && assets.length === 0) return null;
    return {
      total: balance.total.toString(),
      offchain: (balance.offchain || 0n).toString(),
      onchain: (balance.onchain || 0n).toString(),
      assets,
      address: await this.#legacyWallet.getAddress(),
    };
  }

  /**
   * Migrate all funds (sats and assets) from the legacy derivation path
   * to the current BIP-86 wallet via off-chain transfers.
   */
  async migrateLegacyFunds() {
    if (!this.#legacyWallet) {
      return { migrated: false, reason: "No legacy wallet detected" };
    }
    const legacyBalance = await this.#legacyWallet.getBalance();
    const legacyAssets = legacyBalance.assets || [];
    if (legacyBalance.total === 0n && legacyAssets.length === 0) {
      return { migrated: false, reason: "Legacy wallet has no funds or assets" };
    }

    const bip86Address = await this.#wallet.getAddress();
    const results = { migrated: true, fromPath: "m/44'/1237'/0'/0/0", toAddress: bip86Address };

    // Migrate sats
    if (legacyBalance.total > 0n) {
      const amount = Number(legacyBalance.offchain || legacyBalance.total);
      const txid = await this.#legacyWallet.send({
        address: bip86Address,
        amount,
      });
      results.satsTxid = txid;
      results.satsAmount = amount;
      console.log(
        `Migrated ${amount} sats from legacy path to BIP-86 wallet: ${txid}`
      );
    }

    // Migrate assets
    if (legacyAssets.length > 0) {
      results.assets = [];
      for (const asset of legacyAssets) {
        const txid = await this.#legacyWallet.send({
          address: bip86Address,
          amount: 0,
          assets: [{ assetId: asset.assetId, amount: asset.amount }],
        });
        results.assets.push({ assetId: asset.assetId, amount: asset.amount, txid });
        console.log(
          `Migrated asset ${asset.assetId} (amount: ${asset.amount}) from legacy path: ${txid}`
        );
      }
    }

    return results;
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
    validateArkAddress(recipientAddress, "recipient address");
    validateAmount(amountSats, "transfer amount");
    return await this.#wallet.send({
      address: recipientAddress,
      amount: amountSats,
    });
  }

  // --- Withdrawal (Collaborative Exit to L1) ---

  async withdraw(onchainAddress, amountSats) {
    validateOnchainAddress(onchainAddress, "withdrawal address");
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
      // Coerce to Number to handle SDK returning BigInt or number consistently
      selectedAmount += Number(vtxo.value);
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

    const beforeTotal = vtxos.reduce((sum, v) => sum + Number(v.value), 0);
    // settle() with no params merges all VTXOs into one, deducting fees
    const txid = await this.#wallet.settle();
    const afterVtxos = await this.#wallet.getVtxos();
    const afterTotal = afterVtxos.reduce((sum, v) => sum + Number(v.value), 0);

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
    validateArkAddress(recipientAddress, "recipient address");
    validateAmount(amountSats, "transfer amount", { allowZero: true });
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

  // --- Transaction History ---

  async getTransactionHistory() {
    return await this.#wallet.getTransactionHistory();
  }

  // --- Lifecycle ---

  cleanup() {
    // Reserved for future resource cleanup
  }
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

  // Check for legacy funds needing migration
  const legacyBalance = await agent.getLegacyBalance();
  if (legacyBalance) {
    console.log("\n=== Legacy Wallet (needs migration) ===");
    console.log("Legacy balance:", legacyBalance.total, "sats");
    console.log("Legacy address:", legacyBalance.address);
    console.log("Run agent.migrateLegacyFunds() to move these to the BIP-86 wallet.");
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

// Only run demo when executed directly (not when imported as a module)
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const isDirectRun =
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
