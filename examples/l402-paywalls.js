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
import { ArkadeSwaps, getInvoiceSatoshis } from "@arkade-os/boltz-swap";
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

// L402 token cache -- keyed by domain so tokens are reused across endpoints
const tokenCache = new Map();

function deriveKeyFromMnemonic(mnemonic) {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid BIP39 mnemonic: checksum failed or contains invalid words");
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const key = master.derive(DERIVATION_PATH).deriveChild(0).deriveChild(0);
  return hex.encode(key.privateKey);
}

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

/**
 * Parse a 402 challenge. Checks the WWW-Authenticate header first (L402/LSAT
 * spec-compliant), then falls back to the JSON body (non-standard but common).
 */
async function parseChallenge(response) {
  let invoice, macaroon;

  const wwwAuth = response.headers.get("www-authenticate") || "";
  const l402 = wwwAuth.split('L402 macaroon="')[1];
  if (l402) {
    macaroon = l402.split('"')[0];
    invoice = l402.split('invoice="')[1]?.split('"')[0];
  }
  if (!macaroon || !invoice) {
    const lsat = wwwAuth.split('LSAT macaroon="')[1];
    if (lsat) {
      macaroon = macaroon || lsat.split('"')[0];
      invoice = invoice || lsat.split('invoice="')[1]?.split('"')[0];
    }
  }

  if (!invoice || !macaroon) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await response.json();
      invoice = invoice || body.invoice || body.payment_request || body.pr;
      macaroon = macaroon || body.macaroon || body.token;
    }
  }

  if (!invoice || !macaroon) {
    throw new Error("Invalid L402 response: missing invoice or macaroon");
  }

  return { invoice, macaroon };
}

/**
 * Fetch content from an L402-protected endpoint.
 * If 402 Payment Required, pays via Boltz submarine swap and retries.
 */
async function fetchWithL402(swaps, url, options = {}) {
  const { method = "GET", headers = {}, body } = options;
  const domain = new URL(url).host;
  const reqHeaders = { "Content-Type": "application/json", ...headers };
  const reqBody = body ? JSON.stringify(body) : undefined;

  // Try cached token first
  const cached = tokenCache.get(domain);
  if (cached) {
    const response = await fetch(url, {
      method,
      headers: {
        ...reqHeaders,
        Authorization: `L402 ${cached.macaroon}:${cached.preimage}`,
      },
      body: reqBody,
    });

    if (response.status !== 402 && response.status !== 401) {
      const ct = response.headers.get("content-type") || "";
      const data = ct.includes("json")
        ? await response.json()
        : await response.text();
      return { paid: false, cached: true, data };
    }
    tokenCache.delete(domain);
    console.log("Cached token expired, paying for new one...");
  }

  // Step 1: Make initial request
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

  console.log("Got 402 Payment Required, parsing challenge...");

  // Step 2: Parse challenge
  const { invoice, macaroon } = await parseChallenge(initialResponse);

  // Step 3: Decode invoice amount
  const amountSats = getInvoiceSatoshis(invoice);
  if (amountSats === 0) {
    throw new Error("L402 invoice has no amount");
  }
  console.log(`Invoice amount: ${amountSats} sats`);

  // Step 4: Pay via Boltz — sendLightningPayment returns preimage directly
  console.log("Paying invoice via Boltz submarine swap...");
  const result = await swaps.sendLightningPayment({ invoice });

  console.log("Payment complete, preimage:", result.preimage.slice(0, 16) + "...");

  // Step 5: Retry with L402 authorization
  console.log("Fetching protected content...");
  const finalResponse = await fetch(url, {
    method,
    headers: {
      ...reqHeaders,
      Authorization: `L402 ${macaroon}:${result.preimage}`,
    },
    body: reqBody,
  });

  const ct = finalResponse.headers.get("content-type") || "";
  const data = ct.includes("json")
    ? await finalResponse.json()
    : await finalResponse.text();

  // Cache token
  tokenCache.set(domain, { macaroon, preimage: result.preimage });

  return { paid: true, amountSats, preimage: result.preimage, macaroon, data };
}

/**
 * Preview L402 cost without paying.
 */
async function previewL402(url) {
  const response = await fetch(url);
  if (response.status !== 402) {
    return { requiresPayment: false };
  }

  const { invoice } = await parseChallenge(response);
  const amountSats = getInvoiceSatoshis(invoice);

  return { requiresPayment: true, amountSats, invoice };
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

  // --- Preview L402 Cost ---
  const L402_TEST_URL = "https://tassandra.laisee.org/price/USD";
  console.log("=== Preview L402 Cost ===");
  console.log(`Checking ${L402_TEST_URL}...`);
  const preview = await previewL402(L402_TEST_URL);

  if (!preview.requiresPayment) {
    console.log("No payment required for this endpoint.\n");
  } else {
    console.log(`Payment required: ${preview.amountSats} sats`);
    console.log(`Invoice: ${preview.invoice.slice(0, 50)}...\n`);
  }

  // --- Fetch with L402 Payment ---
  // Uncomment to actually pay and fetch:
  //
  // console.log("=== Fetch with L402 Payment ===");
  // const result = await fetchWithL402(swaps, L402_TEST_URL);
  // console.log("Paid:", result.paid);
  // if (result.amountSats) console.log("Amount:", result.amountSats, "sats");
  // console.log("Data:", result.data);
  //
  // // Second request reuses the cached token
  // console.log("\n=== Fetch Again (cached token) ===");
  // const result2 = await fetchWithL402(swaps, "https://tassandra.laisee.org/price/EUR");
  // console.log("Paid:", result2.paid, "Cached:", result2.cached);
  // console.log("Data:", result2.data);

  await swaps.dispose();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
