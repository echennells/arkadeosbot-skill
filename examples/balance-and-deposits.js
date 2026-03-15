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
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
