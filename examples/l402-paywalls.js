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
import { decode } from "light-bolt11-decoder";

const DERIVATION_PATH = "m/44'/1237'/0'";

if (!process.env.ARK_MNEMONIC) {
  console.error("ARK_MNEMONIC not set. Run wallet-setup.js first.");
  process.exit(1);
}

const arkServerUrl =
  process.env.ARK_SERVER_URL || "https://arkade.computer";
const boltzUrl =
  process.env.BOLTZ_URL || "https://api.ark.boltz.exchange";

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
 * Pay a Lightning invoice via Boltz submarine swap.
 * Returns the swap info for monitoring.
 */
async function payViaSubmarine(wallet, invoice) {
  const subRes = await fetch(`${boltzUrl}/v2/swap/submarine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "ARK",
      to: "BTC",
      invoice,
    }),
  });

  if (!subRes.ok) {
    throw new Error(`Boltz submarine swap failed: ${await subRes.text()}`);
  }

  const swap = await subRes.json();

  // Send VTXOs to swap address
  await wallet.send({
    address: swap.address,
    amount: swap.expectedAmount,
  });

  return swap;
}

/**
 * Fetch content from an L402-protected endpoint.
 * If 402 Payment Required, pays via Boltz submarine swap and retries.
 */
async function fetchWithL402(wallet, url, options = {}) {
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
  const decoded = decode(invoice);
  const amountSection = decoded.sections.find((s) => s.name === "amount");
  if (!amountSection?.value) {
    throw new Error("L402 invoice has no amount");
  }
  const amountSats = Math.ceil(Number(amountSection.value) / 1000);
  console.log(`Invoice amount: ${amountSats} sats`);

  // Step 4: Pay via Boltz submarine swap
  console.log("Paying invoice via Boltz submarine swap...");
  const swap = await payViaSubmarine(wallet, invoice);

  // Step 5: Poll for swap completion and preimage
  let preimage = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await fetch(`${boltzUrl}/v2/swap/${swap.id}`);
    if (statusRes.ok) {
      const status = await statusRes.json();
      if (status.status === "transaction.claimed") {
        if (!status.preimage) {
          throw new Error("Boltz swap claimed but no preimage returned");
        }
        preimage = status.preimage;
        break;
      }
      if (
        status.status === "transaction.failed" ||
        status.status === "swap.expired"
      ) {
        throw new Error(`L402 payment failed: ${status.status}`);
      }
    }
  }

  if (!preimage) {
    throw new Error("L402 payment timed out");
  }

  console.log("Payment complete, preimage:", preimage.slice(0, 16) + "...");

  // Step 6: Retry with L402 authorization
  console.log("Fetching protected content...");
  const finalResponse = await fetch(url, {
    method,
    headers: {
      ...reqHeaders,
      Authorization: `L402 ${macaroon}:${preimage}`,
    },
    body: reqBody,
  });

  const ct = finalResponse.headers.get("content-type") || "";
  const data = ct.includes("json")
    ? await finalResponse.json()
    : await finalResponse.text();

  // Cache token
  tokenCache.set(domain, { macaroon, preimage });

  return { paid: true, amountSats, preimage, macaroon, data };
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
  const decoded = decode(invoice);
  const amountSection = decoded.sections.find((s) => s.name === "amount");
  const amountSats = Math.ceil(Number(amountSection.value) / 1000);

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
  // const result = await fetchWithL402(wallet, L402_TEST_URL);
  // console.log("Paid:", result.paid);
  // if (result.amountSats) console.log("Amount:", result.amountSats, "sats");
  // console.log("Data:", result.data);
  //
  // // Second request reuses the cached token
  // console.log("\n=== Fetch Again (cached token) ===");
  // const result2 = await fetchWithL402(wallet, "https://tassandra.laisee.org/price/EUR");
  // console.log("Paid:", result2.paid, "Cached:", result2.cached);
  // console.log("Data:", result2.data);
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
