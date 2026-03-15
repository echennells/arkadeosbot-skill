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
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { hex } from "@scure/base";

const DERIVATION_PATH = "m/44'/1237'/0'";
const network = process.env.ARK_NETWORK || "bitcoin";
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
  let mnemonic;

  if (process.env.ARK_MNEMONIC) {
    console.log("Importing existing wallet from ARK_MNEMONIC...\n");
    mnemonic = process.env.ARK_MNEMONIC;
  } else {
    console.log("No ARK_MNEMONIC found. Generating new wallet...\n");
    mnemonic = generateMnemonic(wordlist);
  }

  const privateKeyHex = deriveKeyFromMnemonic(mnemonic);
  const identity = SingleKey.fromHex(privateKeyHex);

  const wallet = await Wallet.create({
    identity,
    arkServerUrl,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  });

  const arkAddress = await wallet.getAddress();
  const boardingAddress = await wallet.getBoardingAddress();

  console.log("=== Arkade Wallet ===");
  console.log("Network:         ", network);
  console.log("Server:          ", arkServerUrl);
  console.log("Ark Address:     ", arkAddress);
  console.log("Boarding Address:", boardingAddress);

  if (!process.env.ARK_MNEMONIC) {
    // WARNING: This prints the mnemonic for initial backup only.
    // After saving it securely, delete this output from your terminal history.
    // NEVER log mnemonics in production code.
    console.log("\n=== SAVE THIS MNEMONIC SECURELY (then clear terminal) ===");
    console.log(mnemonic);
    console.log("\n=== Add to .env (never commit this file) ===");
    console.log(`ARK_MNEMONIC=${mnemonic}`);
    console.log(`ARK_SERVER_URL=${arkServerUrl}`);
    console.log(`ARK_NETWORK=${network}`);
    console.log("\n=== CLEAR YOUR TERMINAL HISTORY AFTER SAVING ===");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
