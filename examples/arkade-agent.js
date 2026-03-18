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

function deriveLegacyKey(mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const key = master.derive(LEGACY_DERIVATION_PATH).deriveChild(0).deriveChild(0);
  return hex.encode(key.privateKey);
}

const DEFAULT_GAP_LIMIT = 20;

export class ArkadeAgent {
  wallet; // The primary BIP-86 Wallet instance — use directly for SDK operations
  #legacyWallet;
  #indexWallets = new Map();
  #scanned = false;
  #mnemonic;
  #arkServerUrl;
  #delegatorUrl;
  #isMainnet;

  constructor(wallet, legacyWallet, config) {
    this.wallet = wallet;
    this.#legacyWallet = legacyWallet || null;
    if (config) {
      this.#mnemonic = config.mnemonic;
      this.#arkServerUrl = config.arkServerUrl;
      this.#delegatorUrl = config.delegatorUrl;
      this.#isMainnet = config.isMainnet;
    }
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

    const bip86Identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet });
    const bip86Wallet = await Wallet.create(baseConfig(bip86Identity));

    // Check legacy path — funds there need migration
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

    const config = { mnemonic, arkServerUrl, delegatorUrl, isMainnet };
    const agent = new ArkadeAgent(bip86Wallet, legacyRef, config);

    if (options.scan) {
      await agent.scanIndexes();
    }

    return agent;
  }

  #deriveKeyAtIndex(index) {
    const seed = mnemonicToSeedSync(this.#mnemonic);
    const master = HDKey.fromMasterSeed(seed);
    const coinType = this.#isMainnet ? 0 : 1;
    const child = master.derive(`m/86'/${coinType}'/0'`).deriveChild(0).deriveChild(index);
    return hex.encode(child.privateKey);
  }

  async #createWalletForKey(privateKeyHex, { withDelegation = true } = {}) {
    const identity = SingleKey.fromHex(privateKeyHex);
    const config = {
      identity,
      arkServerUrl: this.#arkServerUrl,
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
    };
    if (withDelegation && this.#delegatorUrl) {
      config.delegatorProvider = new RestDelegatorProvider(this.#delegatorUrl);
    }
    return await Wallet.create(config);
  }

  /**
   * Scan BIP-86 child indexes for funds at rotated HD positions.
   * When delegation is configured, checks both delegate and non-delegate
   * script variants at each index.
   */
  async scanIndexes(options = {}) {
    if (!this.#mnemonic) {
      throw new Error("Cannot scan: mnemonic not available (wallet was created without config)");
    }

    const gapLimit = options.gapLimit || DEFAULT_GAP_LIMIT;
    this.#indexWallets.clear();

    let consecutiveEmpty = 0;
    let index = 0;
    let totalSats = 0n;
    const fundedIndexes = [];
    const assetTotals = new Map();
    const hasDelegation = !!this.#delegatorUrl;

    while (consecutiveEmpty < gapLimit) {
      const keyHex = index > 0 ? this.#deriveKeyAtIndex(index) : null;
      let indexHasFunds = false;

      // Check primary variant (with delegation if configured)
      const primaryVariant = hasDelegation ? "delegate" : "default";
      let wallet;
      let balance;

      if (index === 0) {
        balance = await this.wallet.getBalance();
      } else {
        wallet = await this.#createWalletForKey(keyHex);
        balance = await wallet.getBalance();
      }

      let sats = balance.total || 0n;
      let assets = balance.assets || [];

      if (sats > 0n || assets.length > 0) {
        if (index > 0) {
          this.#indexWallets.set(`${index}:${primaryVariant}`, wallet);
        }
        fundedIndexes.push({ index, variant: primaryVariant, sats: sats.toString(), assets });
        totalSats += sats;
        indexHasFunds = true;
        for (const a of assets) {
          const prev = assetTotals.get(a.assetId) || 0;
          assetTotals.set(a.assetId, prev + (a.amount || 0));
        }
      }

      // Check non-delegate variant (only when delegation is configured)
      if (hasDelegation) {
        let ndWallet;
        let ndBalance;

        if (index === 0) {
          const idx0Key = this.#deriveKeyAtIndex(0);
          ndWallet = await this.#createWalletForKey(idx0Key, { withDelegation: false });
          ndBalance = await ndWallet.getBalance();
        } else {
          ndWallet = await this.#createWalletForKey(keyHex, { withDelegation: false });
          ndBalance = await ndWallet.getBalance();
        }

        const ndSats = ndBalance.total || 0n;
        const ndAssets = ndBalance.assets || [];

        if (ndSats > 0n || ndAssets.length > 0) {
          this.#indexWallets.set(`${index}:no-delegate`, ndWallet);
          fundedIndexes.push({ index, variant: "no-delegate", sats: ndSats.toString(), assets: ndAssets });
          totalSats += ndSats;
          indexHasFunds = true;
          for (const a of ndAssets) {
            const prev = assetTotals.get(a.assetId) || 0;
            assetTotals.set(a.assetId, prev + (a.amount || 0));
          }
        }
      }

      if (indexHasFunds) {
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
      }

      if (options.onProgress) {
        options.onProgress(index, { sats: sats.toString(), assets });
      }

      index++;
    }

    this.#scanned = true;

    const result = {
      scanned: true,
      indexesChecked: index,
      fundedIndexes,
      totalSats: totalSats.toString(),
      assets: [...assetTotals.entries()].map(([assetId, amount]) => ({ assetId, amount })),
    };

    const migratable = fundedIndexes.filter(
      f => f.index > 0 || f.variant === "no-delegate"
    );
    if (migratable.length > 0) {
      const primaryAddr = await this.wallet.getAddress();
      const labels = migratable.map(f => `${f.index}(${f.variant})`);
      console.warn(
        `Found funds at ${migratable.length} non-primary location(s): ${labels.join(", ")}.\n` +
        "  Call agent.migrateIndexFunds() to consolidate to the primary wallet:\n" +
        `  ${primaryAddr}`
      );
    }

    return result;
  }

  /**
   * Migrate all funds from rotated HD indexes to the primary wallet (index 0).
   * Requires scanIndexes() to have been called first.
   */
  async migrateIndexFunds() {
    if (!this.#scanned) {
      throw new Error("Call scanIndexes() before migrateIndexFunds()");
    }
    if (this.#indexWallets.size === 0) {
      return { migrated: false, reason: "No funds at rotated indexes" };
    }

    const primaryAddr = await this.wallet.getAddress();
    const results = {
      migrated: true,
      toAddress: primaryAddr,
      entries: [],
    };

    for (const [key, indexWallet] of this.#indexWallets) {
      const balance = await indexWallet.getBalance();
      const assets = balance.assets || [];
      const entry = { key, sats: 0, assets: [], txids: [] };

      if (balance.total > 0n) {
        const amount = Number(balance.offchain || balance.total);
        const txid = await indexWallet.send({
          address: primaryAddr,
          amount,
        });
        entry.sats = amount;
        entry.txids.push(txid);
        console.log(`Migrated ${amount} sats from ${key}: ${txid}`);
      }

      for (const asset of assets) {
        const txid = await indexWallet.send({
          address: primaryAddr,
          amount: 0,
          assets: [{ assetId: asset.assetId, amount: asset.amount }],
        });
        entry.assets.push({ assetId: asset.assetId, amount: asset.amount });
        entry.txids.push(txid);
        console.log(`Migrated asset ${asset.assetId} from ${key}: ${txid}`);
      }

      results.entries.push(entry);
    }

    this.#indexWallets.clear();
    return results;
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

    const bip86Address = await this.wallet.getAddress();
    const results = { migrated: true, fromPath: "m/44'/1237'/0'/0/0", toAddress: bip86Address };

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

  /**
   * Delegate VTXOs to the delegator service for automatic renewal.
   */
  async delegateVtxos() {
    const dm = await this.wallet.getDelegatorManager();
    if (!dm) {
      throw new Error(
        "Delegation not available — no delegatorUrl configured",
      );
    }

    const vtxos = await this.wallet.getVtxos();
    if (vtxos.length === 0) return { delegated: 0, failed: 0 };

    const destination = await this.wallet.getAddress();
    const result = await dm.delegate(vtxos, destination);

    return {
      delegated: result.delegated.length,
      failed: result.failed.length,
      failures: result.failed.length > 0 ? result.failed : undefined,
    };
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

  const address = await agent.wallet.getAddress();
  const boardingAddress = await agent.wallet.getBoardingAddress();
  console.log("=== Agent Identity ===");
  console.log("Ark Address:     ", address);
  console.log("Boarding Address:", boardingAddress);

  // Scan for funds at rotated HD indexes (important for imported mnemonics)
  console.log("\n=== HD Index Scan ===");
  const scan = await agent.scanIndexes();
  console.log(`Checked ${scan.indexesChecked} indexes, found funds at: ${scan.fundedIndexes.map(f => `${f.index}(${f.variant})`).join(", ") || "none"}`);
  console.log(`Total across all indexes: ${scan.totalSats} sats`);

  if (scan.fundedIndexes.some(f => f.index > 0 || f.variant === "no-delegate")) {
    console.log("Run agent.migrateIndexFunds() to consolidate to the primary wallet.");
  }

  const balance = await agent.wallet.getBalance();
  console.log("\n=== Balance ===");
  console.log("Total:    ", balance.total.toString(), "sats");
  console.log("Off-chain:", (balance.offchain || 0n).toString(), "sats");
  console.log("On-chain: ", (balance.onchain || 0n).toString(), "sats");

  const vtxos = await agent.wallet.getVtxos();
  if (vtxos.length > 0) {
    console.log("\n=== VTXOs ===");
    const now = Date.now();
    for (const v of vtxos) {
      const hoursLeft = v.virtualStatus?.batchExpiry
        ? ((v.virtualStatus.batchExpiry - now) / 3600000).toFixed(1)
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

  // Delegate VTXOs for automatic renewal
  console.log("\n=== Delegation ===");
  try {
    const result = await agent.delegateVtxos();
    console.log(`Delegated: ${result.delegated}, Failed: ${result.failed}`);
  } catch (err) {
    console.log("Delegation unavailable:", err.message);
  }

  process.exit(0);
}

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
