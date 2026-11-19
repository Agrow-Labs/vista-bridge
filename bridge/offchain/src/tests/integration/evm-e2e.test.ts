// End-to-end tests for EvmIndexer and EvmMirror against a live in-process
// Ganache JSON-RPC server. No signup, no system install, no testnet faucet
// required — Ganache pre-funds 10 accounts with 100 ETH each.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import { resolve } from "node:path";
import { Effect, Stream, Fiber } from "effect";
import { JsonRpcProvider, Wallet, parseEther, formatEther } from "ethers";
import { EvmIndexer } from "../../evm-indexer/index.js";
import { EvmMirror } from "../../evm-mirror/index.js";
import type { DepositEvent, BridgeState } from "../../common/types.js";
import type { BridgeRoute } from "../../common/route.js";

// Anchor createRequire at the offchain workspace's package.json so node's
// module resolution can find ganache's deeply-nested deps.
const require = createRequire(resolve(__dirname, "../../../package.json"));
const ganache = require("ganache");

// ── Test fixtures ─────────────────────────────────────────────────────
const TEST_CHAIN_ID = 1337;
// Ganache's deterministic mnemonic — addresses + private keys are fixed.
const MNEMONIC = "test test test test test test test test test test test junk";

let server: any;
let rpcUrl: string;
let bridgeDepositAddr: string;     // receives source-side deposits
let bridgeSignerKey: string;       // funded; signs destination-side mirror txs
let bridgeSignerAddr: string;

// Each test pulls a fresh, funded user wallet so there's no nonce contention.
let nextUserIdx = 5;
function freshUserWallet(provider?: JsonRpcProvider): { wallet: Wallet; address: string } {
  const idx = nextUserIdx++;
  const HD = require("ethers").HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${idx}`);
  const wallet = new Wallet(HD.privateKey, provider ?? new JsonRpcProvider(rpcUrl));
  return { wallet, address: HD.address };
}

// Helper: serialise a tx send to its mined receipt so ethers' nonce cache
// doesn't race with subsequent sends from the same wallet.
async function sendAndMine(wallet: Wallet, tx: { to: string; value: bigint }): Promise<string> {
  const sent = await wallet.sendTransaction(tx);
  const receipt = await sent.wait(1);
  if (!receipt) throw new Error(`tx ${sent.hash} got no receipt`);
  return sent.hash;
}

beforeAll(async () => {
  server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: TEST_CHAIN_ID, networkId: TEST_CHAIN_ID },
    wallet: { mnemonic: MNEMONIC, totalAccounts: 10, defaultBalance: 100 },
    miner: { blockTime: 0 }, // mine on every tx — keeps tests fast
  });
  await server.listen(0);
  const port = server.address().port;
  rpcUrl = `http://127.0.0.1:${port}`;

  // Derive the bridge deposit (idx 1) and signer (idx 2) at fixed paths so the
  // test addresses align with what Ganache pre-funds.
  const { HDNodeWallet } = await import("ethers");
  const acct1 = HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/1");
  const acct2 = HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/2");
  bridgeDepositAddr = acct1.address;
  bridgeSignerAddr = acct2.address;
  bridgeSignerKey = acct2.privateKey;
}, 30_000);

afterAll(async () => {
  if (server) await server.close();
});

// ── Minimal in-memory relayer ─────────────────────────────────────────
function makeFakeRelayer() {
  const published: DepositEvent[] = [];
  const processed = new Map<string, { mirrorHash: string; status: string }>();
  let onDeposit: ((dep: DepositEvent) => void) | null = null;

  const subscribeToDeposits = Stream.async<DepositEvent, Error>((emit) => {
    onDeposit = (dep) => emit.single(dep);
    return Effect.sync(() => {
      onDeposit = null;
    });
  });

  return {
    published,
    processed,
    publishDeposit: (event: DepositEvent) =>
      Effect.sync(() => {
        published.push(event);
        if (onDeposit) onDeposit(event);
        return { success: true, messageId: `msg-${published.length}` };
      }),
    updateMirrorStatus: (depositTxHash: string, mirrorTxHash: string, status: string) =>
      Effect.sync(() => {
        processed.set(depositTxHash, { mirrorHash: mirrorTxHash, status });
        return true;
      }),
    getBridgeState: (_routeId?: string): Effect.Effect<BridgeState, Error> =>
      Effect.sync(() => ({
        processedDeposits: Array.from(processed.entries())
          .filter(([, v]) => v.status === "CONFIRMED")
          .map(([txHash, v]) => ({
            routeId: "evm-test-route",
            transactionHash: txHash,
            processedAt: BigInt(Date.now()),
            mirrorTxHash: v.mirrorHash,
            status: 3 as any,
          })),
        pendingMirrors: [],
        lastProcessedSlot: 0n,
        lastProcessedBlockHash: "",
      })),
    getPendingDeposits: (_routeId?: string): Effect.Effect<DepositEvent[], Error> => Effect.succeed([]),
    subscribeToDeposits,
  };
}

function makeEvmRoute(opts: {
  id: string;
  asSource: boolean;
  asDestination: boolean;
  depositAddr?: string;
  signerKey?: string;
  rpcUrl: string;
  confirmations?: number;
  minDeposit?: bigint;
  maxTransfer?: bigint;
  fee?: bigint;
}): BridgeRoute {
  const min = (opts.minDeposit ?? parseEther("0.001")).toString();
  const max = (opts.maxTransfer ?? parseEther("10")).toString();
  const fee = (opts.fee ?? parseEther("0.0001")).toString();
  return {
    id: opts.id,
    source: opts.asSource
      ? {
          chainId: "evm-test",
          chainType: "evm",
          name: "ganache",
          evmChainId: TEST_CHAIN_ID,
          evmConfirmations: opts.confirmations ?? 1,
          rpcEndpoint: opts.rpcUrl,
          addresses: [opts.depositAddr!],
        }
      : {
          chainId: "non-source",
          chainType: "cardano",
          name: "preprod",
          addresses: ["addr_test1stub"],
        },
    destination: opts.asDestination
      ? {
          chainId: "evm-test",
          chainType: "evm",
          name: "ganache",
          evmChainId: TEST_CHAIN_ID,
          rpcEndpoint: opts.rpcUrl,
          addresses: [], // not used by EvmMirror — signer comes from walletPrivateKey
          walletPrivateKey: opts.signerKey!,
        }
      : {
          chainId: "non-dest",
          chainType: "cardano",
          name: "preprod",
          addresses: ["addr_test1stub"],
        },
    bridge: {
      allowedAssets: ["ETH"],
      minDepositAmount: min,
      maxTransferAmount: max,
      feeAmount: fee,
      assetConfigs: {
        ETH: {
          sourceUnit: "",
          destinationUnit: "",
          destinationAction: "send",
          minDepositAmount: min,
          maxTransferAmount: max,
          feeLovelace: fee,
          decimals: 18,
        },
      },
    },
    security: { requiredConfirmations: 1, retryAttempts: 3, retryDelayMs: 100 },
  };
}

// Wait until `predicate()` returns true, polling every 100ms, up to `timeoutMs`.
async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

// ── Tests ─────────────────────────────────────────────────────────────
describe("EvmIndexer (E2E against Ganache)", () => {
  it("detects an incoming ETH deposit and publishes a DepositEvent", async () => {
    const { wallet, address: userAddr } = freshUserWallet();
    const route = makeEvmRoute({
      id: "evm-test-route",
      asSource: true,
      asDestination: false,
      depositAddr: bridgeDepositAddr,
      rpcUrl,
      confirmations: 1,
    });
    const relayer = makeFakeRelayer();
    const indexer = new EvmIndexer(route, relayer);
    const fiber = Effect.runFork(indexer.run.pipe(Effect.catchAll(() => Effect.void)));

    // Give the indexer a moment to wire up its block subscription
    await new Promise((r) => setTimeout(r, 500));

    const amount = parseEther("0.5");
    const depositHash = await sendAndMine(wallet, { to: bridgeDepositAddr, value: amount });
    // Mine one extra block to satisfy `confirmations: 1`
    await sendAndMine(wallet, { to: bridgeSignerAddr, value: 1n });

    await waitFor(() => relayer.published.length >= 1, 8000, "indexer publishes deposit");
    await Fiber.interrupt(fiber);

    expect(relayer.published).toHaveLength(1);
    const dep = relayer.published[0];
    expect(dep.assetType).toBe("ETH");
    expect(dep.amount).toBe(amount);
    expect(dep.transactionHash.toLowerCase()).toBe(depositHash.toLowerCase());
    expect(dep.senderAddress.toLowerCase()).toBe(userAddr.toLowerCase());
    // recipientAddress is intentionally left empty by EvmIndexer for cross-chain
    // deposits — the cross-chain destination is supplied via POST /api/deposit/register.
    expect(dep.recipientAddress).toBe("");
    expect(dep.routeId).toBe("evm-test-route");
  }, 30_000);

  it("ignores transactions sent to other addresses", async () => {
    const { wallet } = freshUserWallet();
    const otherAddr = Wallet.createRandom().address;
    const route = makeEvmRoute({
      id: "evm-test-route-2",
      asSource: true,
      asDestination: false,
      depositAddr: otherAddr,
      rpcUrl,
      confirmations: 1,
    });
    const relayer = makeFakeRelayer();
    const indexer = new EvmIndexer(route, relayer);
    const fiber = Effect.runFork(indexer.run.pipe(Effect.catchAll(() => Effect.void)));

    await new Promise((r) => setTimeout(r, 500));

    await sendAndMine(wallet, { to: bridgeDepositAddr, value: parseEther("0.1") });
    await sendAndMine(wallet, { to: bridgeSignerAddr, value: 1n });

    await new Promise((r) => setTimeout(r, 1500));
    await Fiber.interrupt(fiber);

    expect(relayer.published).toHaveLength(0);
  }, 30_000);

  it("rejects deposits below minDepositAmount", async () => {
    const { wallet } = freshUserWallet();
    const route = makeEvmRoute({
      id: "evm-test-route-3",
      asSource: true,
      asDestination: false,
      depositAddr: bridgeDepositAddr,
      rpcUrl,
      confirmations: 1,
      minDeposit: parseEther("1"),
    });
    const relayer = makeFakeRelayer();
    const indexer = new EvmIndexer(route, relayer);
    const fiber = Effect.runFork(indexer.run.pipe(Effect.catchAll(() => Effect.void)));

    await new Promise((r) => setTimeout(r, 500));

    await sendAndMine(wallet, { to: bridgeDepositAddr, value: parseEther("0.5") });
    await sendAndMine(wallet, { to: bridgeSignerAddr, value: 1n });

    await new Promise((r) => setTimeout(r, 1500));
    await Fiber.interrupt(fiber);

    expect(relayer.published).toHaveLength(0); // validation failed → never reached relayer
  }, 30_000);
});

describe("EvmMirror (E2E against Ganache)", () => {
  it("sends a mirror tx for a published deposit, less the fee", async () => {
    const route = makeEvmRoute({
      id: "evm-mirror-route",
      asSource: false,
      asDestination: true,
      signerKey: bridgeSignerKey,
      rpcUrl,
      fee: parseEther("0.01"),
    });
    const relayer = makeFakeRelayer();
    const mirror = new EvmMirror(route, relayer);
    const fiber = Effect.runFork(mirror.run.pipe(Effect.catchAll(() => Effect.void)));

    await new Promise((r) => setTimeout(r, 500));

    // Synthesize a Cardano-source deposit on the relayer's stream.
    // Cross-chain semantics: senderAddress is the Cardano depositor,
    // recipientAddress is the EVM destination the mirror should send to.
    const recipientAddr = Wallet.createRandom().address;
    const provider = new JsonRpcProvider(rpcUrl);
    const before = await provider.getBalance(recipientAddr);
    expect(before).toBe(0n);

    const fakeDep: DepositEvent = {
      routeId: "evm-mirror-route",
      transactionHash: "0xfeed".padEnd(66, "0"),
      senderAddress: "addr_test1qpcardano_stub_depositor",
      recipientAddress: recipientAddr,
      amount: parseEther("0.5"),
      assetType: "ETH",
      blockSlot: 0n,
      blockHash: "",
      outputIndex: 0,
      metadata: {},
      timestamp: 0n,
    };
    await Effect.runPromise(relayer.publishDeposit(fakeDep));

    await waitFor(
      () => (relayer.processed.get(fakeDep.transactionHash)?.status === "CONFIRMED"),
      15_000,
      "mirror tx confirmed",
    );

    const entry = relayer.processed.get(fakeDep.transactionHash);
    expect(entry?.mirrorHash.startsWith("0x")).toBe(true);
    expect(entry?.mirrorHash.length).toBe(66);

    // Verify the on-chain mirror tx actually went where we expect.
    const mirrorTx = await provider.getTransaction(entry!.mirrorHash);
    expect(mirrorTx?.to?.toLowerCase()).toBe(recipientAddr.toLowerCase());
    const expectedNet = parseEther("0.5") - parseEther("0.01");
    expect(mirrorTx?.value).toBe(expectedNet);

    // Use a freshly-constructed provider; the one created earlier may have
    // cached an older "latest" tag before the mirror tx mined.
    const freshProvider = new JsonRpcProvider(rpcUrl);
    const after = await freshProvider.getBalance(recipientAddr, "latest");
    expect(after).toBe(expectedNet);
    await Fiber.interrupt(fiber);
  }, 30_000);

  it("marks the deposit FAILED if the signer is underfunded", async () => {
    // Fresh unfunded signer (key not in Ganache's pre-funded accounts)
    const unfunded = Wallet.createRandom();
    const route = makeEvmRoute({
      id: "evm-mirror-route-poor",
      asSource: false,
      asDestination: true,
      signerKey: unfunded.privateKey,
      rpcUrl,
      fee: parseEther("0.01"),
    });
    const relayer = makeFakeRelayer();
    const mirror = new EvmMirror(route, relayer);
    const fiber = Effect.runFork(mirror.run.pipe(Effect.catchAll(() => Effect.void)));

    await new Promise((r) => setTimeout(r, 500));

    const fakeDep: DepositEvent = {
      routeId: "evm-mirror-route-poor",
      transactionHash: "0xdead".padEnd(66, "0"),
      senderAddress: "addr_test1qpcardano_stub_depositor",
      recipientAddress: Wallet.createRandom().address,
      amount: parseEther("0.5"),
      assetType: "ETH",
      blockSlot: 0n,
      blockHash: "",
      outputIndex: 0,
      metadata: {},
      timestamp: 0n,
    };
    await Effect.runPromise(relayer.publishDeposit(fakeDep));

    await waitFor(
      () => relayer.processed.get(fakeDep.transactionHash)?.status === "FAILED",
      10_000,
      "deposit marked FAILED",
    );
    await Fiber.interrupt(fiber);

    expect(relayer.processed.get(fakeDep.transactionHash)?.status).toBe("FAILED");
  }, 30_000);
});
