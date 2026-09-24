#!/usr/bin/env node
import { open, readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CLIENT_VERSION = "0.2.0";

const PRODUCTS = {
  resolve: { path: "/api/resolve", maxUrls: 1, price: "0.002" },
  diff: { path: "/api/diff", maxUrls: 1, price: "0.004" },
  "pricing-snapshot": { path: "/api/pricing-snapshot", maxUrls: 5, price: "0.02" },
  "page-watch-30d": { path: "/api/page-watch-30d", maxUrls: 5, price: "0.50" },
};
const USDC = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

function validateBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password) {
    throw new Error("API_BASE_URL must use HTTPS (HTTP is allowed for localhost).");
  }
  return url;
}

export function buildEndpoint(baseUrl, action, urls) {
  const product = PRODUCTS[action];
  if (!product) throw new Error(`Unknown action: ${action}`);
  if (!Array.isArray(urls) || !urls.length || urls.length > product.maxUrls) {
    throw new Error(`${action} needs 1${product.maxUrls > 1 ? ` to ${product.maxUrls}` : ""} URL(s).`);
  }
  const endpoint = new URL(product.path, validateBaseUrl(baseUrl));
  for (const value of urls) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Targets must be public HTTP(S) URLs without credentials.");
    }
    url.hash = "";
    endpoint.searchParams.append("url", url.toString());
  }
  return endpoint;
}

function decodeHeader(value) {
  return value ? JSON.parse(Buffer.from(value, "base64url").toString("utf8")) : null;
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`Expected JSON; received HTTP ${response.status}.`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error || body.message || "Request failed"}`);
  return body;
}

export async function discoverServices(baseUrl = "https://fetchdelta.com", fetchImpl = fetch) {
  const base = validateBaseUrl(baseUrl);
  const getJson = async (url) => readJsonResponse(await fetchImpl(url, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30000),
  }));
  const manifest = await getJson(new URL("/manifest", base));
  if (!Array.isArray(manifest.products)) throw new Error("The API manifest has no product list.");
  const search = new URL("https://api.cdp.coinbase.com/platform/v2/x402/discovery/search");
  search.search = new URLSearchParams({ urlSubstring: base.origin, curatedOnly: "false", limit: "20" }).toString();
  let resources = [];
  let catalog = { status: "available", url: search.href };
  try {
    const result = await getJson(search);
    if (!Array.isArray(result.resources)) throw new Error("The catalog returned no resource list.");
    resources = result.resources;
    if (result.partialResults) catalog.status = "partial";
  } catch (error) {
    catalog = { ...catalog, status: "unavailable", error: error.message };
  }
  const products = Object.entries(PRODUCTS).map(([name, product]) => {
    const endpoint = new URL(product.path, base).href;
    const entry = manifest.products.find((item) => item.name === name && item.url === endpoint && item.method === "GET");
    if (!entry) throw new Error(`The API manifest is missing the expected ${name} endpoint.`);
    const indexed = resources.find((item) => item.resource === endpoint && item.type === "http");
    return {
      name, method: "GET", url: endpoint, price: entry.price, maxUrls: product.maxUrls,
      listedInBazaar: indexed ? true : catalog.status === "available" ? false : null,
      catalogUpdatedAt: indexed?.lastUpdated || null,
    };
  });
  return {
    api: base.origin, catalog, products,
    note: "Catalog presence is separate from availability. Inspect the endpoint for its current payment requirements; discovery cannot pay.",
  };
}

export async function previewPage(baseUrl, targetUrl, fetchImpl = fetch) {
  const endpoint = buildEndpoint(baseUrl, "resolve", [targetUrl]);
  endpoint.pathname = "/api/resolve/preview";
  return readJsonResponse(await fetchImpl(endpoint, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30000),
  }));
}

export async function inspectPayment(endpoint, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  const requirement = response.headers.get("PAYMENT-REQUIRED");
  if (response.status === 402 && requirement) {
    await response.body?.cancel();
    return { status: 402, paymentRequired: decodeHeader(requirement) };
  }
  return { status: response.status, body: await readJsonResponse(response) };
}

export function paymentPolicy(maxUsdc, network = "eip155:8453") {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(maxUsdc));
  if (!match || !USDC[network]) throw new Error("Invalid payment limit or unsupported payment network.");
  const maximum = BigInt(match[1]) * 1000000n + BigInt((match[2] || "").padEnd(6, "0"));
  return (_version, offers) => offers.filter((offer) => {
    if (offer.network !== network || offer.scheme !== "exact" || String(offer.asset).toLowerCase() !== USDC[network]) return false;
    if (!/^\d+$/.test(String(offer.amount))) return false;
    return BigInt(offer.amount) > 0n && BigInt(offer.amount) <= maximum;
  });
}

export async function payForRequest(endpoint, { privateKey, maxUsdc, network = "eip155:8453", fetchImpl = fetch }) {
  if (!privateKey) throw new Error("EVM_PRIVATE_KEY is required for pay mode.");
  const [{ ExactEvmScheme }, { wrapFetchWithPaymentFromConfig }, { privateKeyToAccount }] = await Promise.all([
    import("@x402/evm/exact/client"), import("@x402/fetch"), import("viem/accounts"),
  ]);
  const paidFetch = wrapFetchWithPaymentFromConfig(fetchImpl, {
    schemes: [{ network, client: new ExactEvmScheme(privateKeyToAccount(privateKey)) }],
    policies: [paymentPolicy(maxUsdc, network)],
  });
  const response = await paidFetch(endpoint, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(90000),
  });
  const body = await readJsonResponse(response);
  const payment = decodeHeader(response.headers.get("PAYMENT-RESPONSE"));
  if (!payment?.success || !payment.transaction) throw new Error("The server did not confirm a settled payment.");
  return { status: response.status, payment, body };
}

export async function pollWatch(receipt, baseUrl, fetchImpl = fetch) {
  const base = validateBaseUrl(baseUrl);
  const url = new URL(receipt?.body?.watch?.statusUrl);
  const token = receipt?.body?.access?.token;
  if (url.origin !== base.origin || url.search || url.hash || !/^\/api\/page-watch-30d\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    throw new Error("The receipt status URL must belong to the configured FetchDelta API.");
  }
  if (!/^[0-9a-f]{64}$/i.test(String(token || ""))) throw new Error("The receipt has no valid watch token.");
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    redirect: "error", signal: AbortSignal.timeout(30000),
  });
  return readJsonResponse(response);
}

export async function main(argv = process.argv.slice(2)) {
  let receiptFile;
  try {
    const [mode, action, ...args] = argv;
    if (!mode || mode === "--help" || mode === "-h") {
      console.log(`FetchDelta client ${CLIENT_VERSION} (Node.js 22+)
  discover
  preview <url>
  inspect <resolve|diff|pricing-snapshot|page-watch-30d> <url> [url...]
  pay <action> <url> [url...] [--receipt <file>]
  poll <receipt-file>

Watch purchases require --receipt. The private token is stored with mode 0600.
Paid calls need: npm install @x402/fetch@2.7.0 @x402/evm@2.7.0 viem@2.47.4
Environment: API_BASE_URL (default https://fetchdelta.com), EVM_PRIVATE_KEY,
MAX_PAYMENT_USDC (default product price), PAYMENT_NETWORK (default eip155:8453).`);
      return;
    }
    const baseUrl = process.env.API_BASE_URL || "https://fetchdelta.com";
    if (mode === "discover") {
      if (action || args.length) throw new Error("Use discover without arguments.");
      console.log(JSON.stringify(await discoverServices(baseUrl), null, 2));
      return;
    }
    if (mode === "preview") {
      if (!action || args.length) throw new Error("Use preview <url>.");
      console.log(JSON.stringify(await previewPage(baseUrl, action), null, 2));
      return;
    }
    if (mode === "poll") {
      const receipt = JSON.parse(await readFile(action, "utf8"));
      console.log(JSON.stringify(await pollWatch(receipt, baseUrl), null, 2));
      return;
    }
    if (!["inspect", "pay"].includes(mode)) throw new Error("Use discover, preview, inspect, pay, or poll.");
    const receiptIndex = args.indexOf("--receipt");
    const receiptPath = receiptIndex < 0 ? null : args[receiptIndex + 1];
    if (receiptIndex >= 0 && (!receiptPath || receiptIndex !== args.length - 2)) throw new Error("Use --receipt <file> after the URLs.");
    const urls = receiptIndex < 0 ? args : args.slice(0, receiptIndex);
    const endpoint = buildEndpoint(baseUrl, action, urls);
    if (mode === "inspect") {
      console.log(JSON.stringify(await inspectPayment(endpoint), null, 2));
      return;
    }
    if (action === "page-watch-30d" && !receiptPath) throw new Error("Watch purchases require --receipt <file> to retain your access token.");
    if (!process.env.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY is required for pay mode.");
    // Reserve the receipt before paying so an existing file cannot be overwritten after settlement.
    if (receiptPath) receiptFile = await open(receiptPath, "wx", 0o600);
    const receipt = await payForRequest(endpoint, {
      privateKey: process.env.EVM_PRIVATE_KEY,
      maxUsdc: process.env.MAX_PAYMENT_USDC || PRODUCTS[action].price,
      network: process.env.PAYMENT_NETWORK || "eip155:8453",
    });
    if (receiptFile) {
      await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + "\n");
      await receiptFile.sync();
    }
    const { access, ...body } = receipt.body;
    console.log(JSON.stringify({ ...receipt, body, ...(receiptPath ? { receiptFile: receiptPath } : {}) }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await receiptFile?.close();
  }
}

const entrypoint = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) await main();
