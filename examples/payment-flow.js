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
import { ArkadeSwaps } from "@arkade-os/boltz-swap";
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

/**
 * In-memory SwapRepository for Node.js (IndexedDbSwapRepository is browser-only).
 */
class InMemorySwapRepository {
  version = 1;
  #swaps = new Map();
  async saveSwap(swap) { this.#swaps.set(swap.id, { ...swap }); }
  async deleteSwap(id) { this.#swaps.delete(id); }
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
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      swaps = swaps.filter((s) => statuses.includes(s.status));
    }
    return swaps;
  }
  async clear() { this.#swaps.clear(); }
  async [Symbol.asyncDispose]() { this.#swaps.clear(); }
}

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

  // ArkadeSwaps handles Boltz integration (keys, preimages, signing)
  const swaps = await ArkadeSwaps.create({
    wallet,
    swapRepository: new InMemorySwapRepository(),
    swapManager: false,
  });

  const balance = await wallet.getBalance();
  console.log("Current balance:", balance.total.toString(), "sats\n");

  // --- Receive via Lightning (Boltz reverse swap) ---
  console.log("=== Create Lightning Invoice (via Boltz reverse swap) ===");
  try {
    const result = await swaps.createLightningInvoice({
      amount: 1000,
      description: "Test payment - 1000 sats",
    });
    console.log("BOLT11:", result.invoice);
    console.log("Amount:", result.amount, "sats (after Boltz fees)");
    console.log("Expires:", new Date(result.expiry * 1000).toISOString());
    console.log("Pay this invoice from any Lightning wallet.\n");
  } catch (err) {
    console.log("Boltz reverse swap unavailable:", err.message, "\n");
  }

  // --- Ark-to-Ark Transfer ---
  // Uncomment with a real Ark address to send:
  //
  // const txid = await wallet.send({
  //   address: "ark1...",
  //   amount: 100,
  // });
  // console.log("Transfer:", txid);

  // --- Pay Lightning Invoice (Boltz submarine swap) ---
  // Uncomment with a real BOLT11 invoice to pay:
  //
  // const payResult = await swaps.sendLightningPayment({
  //   invoice: "lnbc...",
  // });
  // console.log("Paid:", payResult.txid);
  // console.log("Preimage:", payResult.preimage);
  // console.log("Amount:", payResult.amount, "sats");

  // --- Collaborative Exit (withdraw to L1) ---
  // Uncomment with a real Bitcoin address:
  //
  // const vtxos = await wallet.getVtxos();
  // const outputs = [{ address: "bc1q...", amount: BigInt(50000) }];
  // const exitTxid = await wallet.settle({ inputs: vtxos, outputs });
  // console.log("Collaborative exit:", exitTxid);

  await swaps.dispose();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
