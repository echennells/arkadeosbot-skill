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
} from "@arkade-os/sdk";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";

const LEGACY_DERIVATION_PATH = "m/44'/1237'/0'";

if (!process.env.ARK_MNEMONIC) {
  console.error("ARK_MNEMONIC not set. Run wallet-setup.js first.");
  process.exit(1);
}

const network = process.env.ARK_NETWORK || "bitcoin";
const arkServerUrl =
  process.env.ARK_SERVER_URL || "https://arkade.computer";

async function main() {
  const mnemonic = process.env.ARK_MNEMONIC;
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid BIP39 mnemonic: checksum failed or contains invalid words");
  }

  const isMainnet = network === "bitcoin";
  const storageOpts = () => ({
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  });

  // Always use BIP-86 as primary wallet
  const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet });
  const wallet = await Wallet.create({
    identity, arkServerUrl, storage: storageOpts(),
  });

  // Check balance
  const balance = await wallet.getBalance();
  console.log("=== Balance ===");
  console.log("Total:    ", balance.total.toString(), "sats");
  console.log("Off-chain:", (balance.offchain || 0n).toString(), "sats");
  console.log("On-chain: ", (balance.onchain || 0n).toString(), "sats");

  // Check asset balances
  if (balance.assets && balance.assets.length > 0) {
    console.log("\n=== Assets ===");
    for (const asset of balance.assets) {
      console.log(`  ${asset.assetId}: ${asset.amount}`);
    }
  } else {
    console.log("\nNo asset balances.");
  }

  // Addresses
  console.log("\n=== Addresses ===");
  const arkAddress = await wallet.getAddress();
  console.log("Ark Address (off-chain):", arkAddress);

  const boardingAddress = await wallet.getBoardingAddress();
  console.log("Boarding Address (L1):  ", boardingAddress);

  console.log("\nSend BTC to the boarding address to fund this wallet.");
  console.log(
    "After confirmation, the funds will be available as VTXOs via the ASP batch process.",
  );

  // List VTXOs
  const vtxos = await wallet.getVtxos();
  if (vtxos.length > 0) {
    console.log("\n=== VTXOs ===");
    const now = Date.now();
    for (const v of vtxos) {
      const expiry = v.virtualStatus?.batchExpiry;
      const hoursLeft = expiry ? ((expiry - now) / 3600000).toFixed(1) : "?";
      console.log(
        `  ${v.txid.slice(0, 16)}... ${v.value} sats (expires in ${hoursLeft}h, state: ${v.virtualStatus?.state || "unknown"})`,
      );
    }
  } else {
    console.log("\nNo VTXOs yet.");
  }

  // Transaction history
  const txs = await wallet.getTransactionHistory();
  if (txs && txs.length > 0) {
    console.log("\n=== Recent Transactions ===");
    for (const tx of txs.slice(0, 5)) {
      console.log(
        `  ${tx.type || "unknown"}: ${tx.amount} sats (${tx.settled ? "settled" : "pending"})`,
      );
    }
  } else {
    console.log("\nNo transactions yet.");
  }

  // Check for legacy funds needing migration
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const legacyKey = master.derive(LEGACY_DERIVATION_PATH).deriveChild(0).deriveChild(0);
  const legacyIdentity = SingleKey.fromHex(hex.encode(legacyKey.privateKey));
  const legacyWallet = await Wallet.create({
    identity: legacyIdentity, arkServerUrl, storage: storageOpts(),
  });
  const legacyBalance = await legacyWallet.getBalance();

  if (legacyBalance.total > 0n) {
    const legacyAddress = await legacyWallet.getAddress();
    const arkAddress = await wallet.getAddress();
    console.warn(
      "\n=== WARNING: Legacy Funds Detected ===\n" +
      `  Legacy balance: ${legacyBalance.total.toString()} sats\n` +
      `  Legacy path:    m/44'/1237'/0'/0/0\n` +
      `  Legacy address: ${legacyAddress}\n` +
      "  These VTXOs will NOT be auto-renewed and may expire.\n" +
      "  Migrate by sending to your BIP-86 address:\n" +
      `  ${arkAddress}\n` +
      "  Or use ArkadeAgent.migrateLegacyFunds() for automatic migration."
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
