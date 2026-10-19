#!/usr/bin/env node
import { open, readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildEndpoint, CLIENT_VERSION, paymentPolicy } from "./agent-client.mjs";

const prices = { resolve: "0.002", diff: "0.004", "pricing-snapshot": "0.02", "page-watch-30d": "0.50" };
const watchAccessMeta = "com.fetchdelta/watch-access";

export async function connectMcp(baseUrl = "https://fetchdelta.com", fetchImpl = fetch) {
  const endpoint = buildEndpoint(baseUrl, "resolve", ["https://example.com"]);
  endpoint.pathname = "/mcp";
  endpoint.search = "";
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const client = new Client({ name: "fetchdelta-client", version: CLIENT_VERSION });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (request.url !== endpoint.href) throw new Error("MCP transport changed its destination.");
      return fetchImpl(request, { redirect: "error" });
    },
  });
  try {
    await client.connect(transport, { timeout: 30000 });
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

function callParams(baseUrl, action, urls, retainAccess = false) {
  const endpoint = buildEndpoint(baseUrl, action, urls);
  return {
    name: action.replaceAll("-", "_"), arguments: { urls: endpoint.searchParams.getAll("url") },
    ...(retainAccess ? { _meta: { "com.fetchdelta/retain-watch-access": true } } : {}),
  };
}

export async function inspectMcp(client, baseUrl, action, urls) {
  const result = await client.callTool(callParams(baseUrl, action, urls, true));
  const body = result.structuredContent;
  if (result.isError && body?.x402Version === 2 && Array.isArray(body.accepts)) {
    return { status: 402, paymentRequired: body };
  }
  throw new Error(body?.error || "Expected an unpaid x402 challenge.");
}

export async function payMcp(client, baseUrl, action, urls, {
  privateKey, maxUsdc = prices[action], network = "eip155:8453", receiptPath,
} = {}) {
  let receiptFile;
  try {
    const params = callParams(baseUrl, action, urls, true);
    if (!privateKey) throw new Error("EVM_PRIVATE_KEY is required for pay mode.");
    if (action === "page-watch-30d" && !receiptPath) throw new Error("Watch purchases require a private receipt file.");
    // Reserve durable, exclusive storage before allowing the wallet to sign.
    if (receiptPath) receiptFile = await open(receiptPath, "wx", 0o600);
    const quote = await inspectMcp(client, baseUrl, action, urls);
    const expected = buildEndpoint(baseUrl, action, urls);
    const resource = quote.paymentRequired.resource?.url;
    const canonicalResource = new URL(expected.pathname, expected.origin).href;
    if (resource !== expected.href && resource !== canonicalResource) throw new Error("Payment resource does not match the requested API operation.");
    const [{ x402Client }, { ExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
      import("@x402/core/client"), import("@x402/evm/exact/client"), import("viem/accounts"),
    ]);
    const wallet = new x402Client().register(network, new ExactEvmScheme(privateKeyToAccount(privateKey)))
      .registerPolicy(paymentPolicy(maxUsdc, network));
    const payload = await wallet.createPaymentPayload(quote.paymentRequired);
    params._meta["x402/payment"] = payload;
    // Exactly one signed attempt. A lost response must not trigger a new purchase.
    const result = await client.callTool(params, undefined, { timeout: 90000 });
    const payment = result._meta?.["x402/payment-response"];
    if (result.isError || !payment?.success || !payment.transaction) {
      throw new Error("MCP purchase did not confirm settlement. Do not blindly retry an uncertain payment.");
    }
    const body = result.structuredContent;
    if (!body || typeof body !== "object") throw new Error("The paid tool returned no structured result.");
    const access = result._meta?.[watchAccessMeta];
    if (action === "page-watch-30d" && !/^[0-9a-f]{64}$/i.test(String(access?.token || ""))) {
      throw new Error("Paid watch response has no access token. Retain transaction evidence and contact support without repurchasing.");
    }
    const receipt = { status: 200, payment, body: { ...body, ...(access ? { access } : {}) } };
    if (receiptFile) {
      await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + "\n");
      await receiptFile.sync();
    }
    return { status: 200, payment, body, ...(receiptPath ? { receiptFile: receiptPath } : {}) };
  } finally {
    await receiptFile?.close();
  }
}

export async function pollMcp(client, receipt, baseUrl) {
  const expectedOrigin = buildEndpoint(baseUrl, "resolve", ["https://example.com"]).origin;
  const url = new URL(receipt?.body?.watch?.statusUrl);
  const match = /^\/api\/page-watch-30d\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (url.origin !== expectedOrigin || url.search || url.hash || !match) throw new Error("Watch receipt belongs to a different API.");
  const token = receipt?.body?.access?.token;
  if (!/^[0-9a-f]{64}$/i.test(String(token || ""))) throw new Error("The receipt has no valid watch token.");
  const result = await client.callTool({
    name: "poll_watch", arguments: { id: match[1] }, _meta: { "com.fetchdelta/watch-token": token },
  });
  if (result.isError) throw new Error(result.structuredContent?.error || "Watch poll failed.");
  return result.structuredContent;
}

export async function main(argv = process.argv.slice(2)) {
  let client;
  try {
    const [mode, action, ...args] = argv;
    if (!mode || ["--help", "-h"].includes(mode)) {
      console.log(`FetchDelta MCP client ${CLIENT_VERSION} (Node.js 22+)
  tools
  preview <url>
  inspect <resolve|diff|pricing-snapshot|page-watch-30d> <url> [url...]
  pay <action> <url> [url...] [--receipt <file>]
  poll <receipt-file>

Only pay can sign. Watch purchases require --receipt; tokens are never printed.
Environment: API_BASE_URL (default https://fetchdelta.com), EVM_PRIVATE_KEY,
MAX_PAYMENT_USDC (default product price), PAYMENT_NETWORK (default eip155:8453).`);
      return;
    }
    if (!["tools", "preview", "inspect", "pay", "poll"].includes(mode)) throw new Error("Unknown MCP command.");
    const baseUrl = process.env.API_BASE_URL || "https://fetchdelta.com";
    client = await connectMcp(baseUrl);
    let result;
    if (mode === "tools") {
      if (action || args.length) throw new Error("Use tools without arguments.");
      result = await client.listTools();
    } else if (mode === "preview") {
      if (!action || args.length) throw new Error("Use preview <url>.");
      result = await client.callTool({ name: "preview_page", arguments: { url: action } });
    } else if (mode === "poll") {
      if (!action || args.length) throw new Error("Use poll <receipt-file>.");
      result = await pollMcp(client, JSON.parse(await readFile(action, "utf8")), baseUrl);
    } else {
      const index = args.indexOf("--receipt");
      const receiptPath = index < 0 ? undefined : args[index + 1];
      if (index >= 0 && (!receiptPath || index !== args.length - 2)) throw new Error("Use --receipt <file> after the URLs.");
      const urls = index < 0 ? args : args.slice(0, index);
      result = mode === "inspect" ? await inspectMcp(client, baseUrl, action, urls) : await payMcp(client, baseUrl, action, urls, {
        privateKey: process.env.EVM_PRIVATE_KEY, maxUsdc: process.env.MAX_PAYMENT_USDC || prices[action],
        network: process.env.PAYMENT_NETWORK || "eip155:8453", receiptPath,
      });
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await client?.close();
  }
}

const entrypoint = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) await main();
