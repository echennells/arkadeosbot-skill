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

  // --- Asset Balances ---
  console.log("=== Asset Balances ===");
  const balance = await wallet.getBalance();
  console.log("BTC:", balance.total.toString(), "sats\n");

  if (balance.assets && balance.assets.length > 0) {
    for (const asset of balance.assets) {
      console.log(`Asset: ${asset.assetId}`);
      console.log(`  Amount: ${asset.amount}`);
      console.log();
    }
  } else {
    console.log("No assets held.\n");
  }

  // --- Transfer Assets ---
  // Uncomment with real values to send assets:
  //
  // const txid = await wallet.send({
  //   address: "ark1...",
  //   amount: 0,
  //   assets: [{ assetId: "hex...", amount: 100 }],
  // });
  // console.log("Asset transfer:", txid);

  // --- VTXOs with Assets ---
  const vtxos = await wallet.getVtxos();
  const assetVtxos = vtxos.filter((v) => v.assets && v.assets.length > 0);
  if (assetVtxos.length > 0) {
    console.log("=== VTXOs with Assets ===");
    for (const v of assetVtxos) {
      console.log(`  ${v.txid.slice(0, 16)}... ${v.value} sats`);
      for (const a of v.assets) {
        console.log(`    Asset ${a.assetId}: ${a.amount}`);
      }
    }
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
