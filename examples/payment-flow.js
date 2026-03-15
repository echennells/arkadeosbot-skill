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
const boltzUrl =
  process.env.BOLTZ_URL || "https://api.ark.boltz.exchange";

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

  const balance = await wallet.getBalance();
  console.log("Current balance:", balance.total.toString(), "sats\n");

  // --- Receive via Lightning (Boltz reverse swap) ---
  console.log("=== Create Lightning Invoice (via Boltz reverse swap) ===");
  const arkAddress = await wallet.getAddress();

  const reverseRes = await fetch(`${boltzUrl}/v2/swap/reverse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "BTC",
      to: "ARK",
      invoiceAmount: 1000,
      description: "Test payment - 1000 sats",
      claimAddress: arkAddress,
    }),
  });

  if (reverseRes.ok) {
    const reverseSwap = await reverseRes.json();
    console.log("BOLT11:", reverseSwap.invoice);
    console.log("Swap ID:", reverseSwap.id);
    console.log("Pay this invoice from any Lightning wallet.\n");
  } else {
    console.log(
      "Boltz reverse swap unavailable:",
      await reverseRes.text(),
      "\n",
    );
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
  // const subRes = await fetch(`${boltzUrl}/v2/swap/submarine`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({
  //     from: "ARK",
  //     to: "BTC",
  //     invoice: "lnbc...",
  //   }),
  // });
  // const subSwap = await subRes.json();
  // const payTxid = await wallet.send({
  //   address: subSwap.address,
  //   amount: subSwap.expectedAmount,
  // });
  // console.log("Submarine swap sent:", payTxid);

  // --- Collaborative Exit (withdraw to L1) ---
  // Uncomment with a real Bitcoin address:
  //
  // const vtxos = await wallet.getVtxos();
  // const outputs = [{ address: "bc1q...", amount: BigInt(50000) }];
  // const exitTxid = await wallet.settle({ inputs: vtxos, outputs });
  // console.log("Collaborative exit:", exitTxid);
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
