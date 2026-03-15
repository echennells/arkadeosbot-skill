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
} from "@arkade-os/sdk";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";

const DERIVATION_PATH = "m/44'/1237'/0'";

if (!process.env.ARK_MNEMONIC) {
  console.error("ARK_MNEMONIC not set. Run wallet-setup.js first.");
  process.exit(1);
}

const arkServerUrl =
  process.env.ARK_SERVER_URL || "https://arkade.computer";

function deriveKeyFromMnemonic(mnemonic) {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid BIP39 mnemonic: checksum failed or contains invalid words");
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const key = master.derive(DERIVATION_PATH).deriveChild(0).deriveChild(0);
  return hex.encode(key.privateKey);
}

async function main() {
  const privateKeyHex = deriveKeyFromMnemonic(process.env.ARK_MNEMONIC);
  const identity = SingleKey.fromHex(privateKeyHex);

  const wallet = await Wallet.create({
    identity,
    arkServerUrl,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
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
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
