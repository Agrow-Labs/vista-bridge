// Live end-to-end test for the ETH (Sepolia) ↔ Cardano (Preprod) bridge.
//
// Pre-requisites:
//   - Bridge is running (cd offchain && bun run dev) with the eth routes in routes.json
//   - Test user EVM wallet is funded with Sepolia ETH
//   - Withdrawal EVM wallet is funded with Sepolia ETH
//   - Cardano Preprod bridge wallet has ADA
//
// Flow:
//   LEG 1 (Sepolia → Preprod):
//     1. Send 0.005 ETH from test user → deposit address on Sepolia
//     2. Register the deposit with the bridge API (recipient = bridge's Preprod addr)
//     3. Wait for the Cardano mirror to mint vETH on Preprod
//
//   wait 5 min
//
//   LEG 2 (Preprod → Sepolia):
//     4. Build a Cardano tx sending vETH from the bridge's Preprod addr to itself,
//        with metadata.d = test user EVM address
//     5. Register the deposit (recipient = test user EVM)
//     6. Wait for the EVM mirror to send ETH back to test user
import {
  JsonRpcProvider,
  Wallet,
  parseEther,
  formatEther,
  type TransactionResponse,
} from "ethers";
import { MeshWallet, Transaction, KoiosProvider, U5CProvider, ForgeScript } from "@meshsdk/core";
import type { IFetcher, ISubmitter } from "@meshsdk/core";
import "dotenv/config";

// ── Fixed test fixtures ────────────────────────────────────────────────
// Sepolia is testnet — these addresses are public bridge fixtures, no real value at stake.
// Set the test-user signing key in offchain/.env.test:  E2E_EVM_PRIVATE_KEY=0x…
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env.test") });

const ALCHEMY = process.env.ROUTE_ETH_SEPOLIA_TO_PREPROD_SOURCE_RPC_URL ?? "";
const SEPOLIA_CHAIN_ID = 11155111;
const DEPOSIT_EVM = "0x68B49df3CE8Bc9B77110c2C7eb15D141cee67055";    // bridge deposit address — public
const WITHDRAWAL_EVM = "0x25f11E5daF0eed7aED446EdE322Ab7A8647E0827"; // bridge withdrawal address — public
const TEST_USER_EVM = process.env.E2E_EVM_ADDRESS ?? "0x037B747521AEb1C8999480E85f0404e5aF1C6195";
const TEST_USER_PK = process.env.E2E_EVM_PRIVATE_KEY ?? "";
if (!TEST_USER_PK) {
  throw new Error("E2E_EVM_PRIVATE_KEY not set — add the test-user Sepolia key to offchain/.env.test");
}

const PREPROD_ADDR = "addr_test1qpnueplse6f4d55eumh7f3tzp3wx882xk7qs6ydxtynrfsw89vzfjf0v4yca056el40n7pr568rdls6lp6eu0dwek9nqku88yp";
const PREPROD_SEED = process.env.ROUTE_ETH_SEPOLIA_TO_PREPROD_DEST_WALLET_SEED ?? "";
const PREPROD_KOIOS = "https://preprod.koios.rest/api/v1";
const PREPROD_UTXORPC = "https://cardano-preprod.utxorpc-m1.demeter.run";
const PREPROD_UTXORPC_KEY = process.env.ROUTE_ETH_SEPOLIA_TO_PREPROD_DEST_API_KEY ?? "";

const VETH_UNIT = "18d477cee2bee00475729bcf7da5ca456d07207d192c6cf11ff8fc7576455448";
const VETH_NAME_HEX = "76455448"; // hex("vETH")

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const FORWARD_ROUTE_ID = "eth-sepolia-to-preprod";
const REVERSE_ROUTE_ID = "preprod-to-eth-sepolia";

const FORWARD_AMOUNT_WEI = parseEther("0.005"); // 0.005 ETH → 0.005e18 vETH on Cardano
const REVERSE_AMOUNT_VETH = (parseEther("0.005") - parseEther("0.0001")).toString(); // forward minted minus the forward fee

// Sleep helper
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Wait until predicate() returns truthy, polling every `every` ms, up to `timeoutMs`.
async function waitFor<T>(
  predicate: () => Promise<T | null | undefined>,
  timeoutMs: number,
  every: number,
  label: string,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await sleep(every);
  }
  throw new Error(`Timeout (${(timeoutMs / 1000).toFixed(0)}s) waiting for: ${label}`);
}

interface ApiDepositStatus {
  depositTxHash: string;
  status: "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "NOT_FOUND";
  mirrorTxHash?: string;
  errorMessage?: string;
}

async function fetchDepositStatus(txHash: string): Promise<ApiDepositStatus> {
  const res = await fetch(`${API_BASE}/api/deposit/${txHash}`);
  if (res.status === 404) return { txHash, status: "NOT_FOUND" };
  if (!res.ok) throw new Error(`status fetch ${res.status}`);
  return (await res.json()) as ApiDepositStatus;
}

async function registerDeposit(body: {
  depositTxHash: string;
  senderAddress: string;
  recipientAddress: string;
  amount: string;
  sourceNetwork: string;
  routeId: string;
  assetType: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/deposit/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`register failed ${res.status}: ${text}`);
  }
  const j = (await res.json()) as { success: boolean; message: string };
  console.log(`📡 register API → ${j.success ? "ok" : "fail"}: ${j.message}`);
}

// ── Leg 1: Sepolia → Preprod ───────────────────────────────────────────
async function legForward(): Promise<{ txHash: string; mirrorHash: string }> {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("LEG 1: Sepolia → Preprod  (test user → bridge → vETH on Preprod)");
  console.log("═══════════════════════════════════════════════════════════");

  if (!ALCHEMY) throw new Error("ROUTE_ETH_SEPOLIA_TO_PREPROD_SOURCE_RPC_URL not set");
  const provider = new JsonRpcProvider(ALCHEMY, SEPOLIA_CHAIN_ID);
  const wallet = new Wallet(TEST_USER_PK, provider);

  const bal = await provider.getBalance(wallet.address);
  console.log(`💰 test user balance: ${formatEther(bal)} ETH`);
  if (bal < FORWARD_AMOUNT_WEI + parseEther("0.001")) {
    throw new Error(`test user underfunded; need ≥${formatEther(FORWARD_AMOUNT_WEI + parseEther("0.001"))} ETH`);
  }

  const feeData = await provider.getFeeData();
  console.log(`⛽ gas: maxFee=${formatEther(feeData.maxFeePerGas ?? 0n)} ETH/gas`);

  const sent: TransactionResponse = await wallet.sendTransaction({
    to: DEPOSIT_EVM,
    value: FORWARD_AMOUNT_WEI,
  });
  console.log(`📤 sent ${formatEther(FORWARD_AMOUNT_WEI)} ETH → ${DEPOSIT_EVM}`);
  console.log(`   tx hash: ${sent.hash}`);
  console.log(`   etherscan: https://sepolia.etherscan.io/tx/${sent.hash}`);

  // Register the deposit IMMEDIATELY so the recipient address arrives at the
  // relayer before the indexer (which has a 3-confirmation delay) can overwrite it.
  await registerDeposit({
    depositTxHash: sent.hash,
    senderAddress: wallet.address,
    recipientAddress: PREPROD_ADDR,
    amount: FORWARD_AMOUNT_WEI.toString(),
    sourceNetwork: "ethereum",
    routeId: FORWARD_ROUTE_ID,
    assetType: "ETH",
  });

  console.log(`⌛ waiting for 1 confirmation on Sepolia...`);
  const receipt = await sent.wait(1);
  console.log(`✅ included in block ${receipt?.blockNumber}`);

  console.log(`⌛ waiting for bridge to confirm the mint on Preprod (up to 5 min)...`);
  const status = await waitFor<ApiDepositStatus>(
    async () => {
      const s = await fetchDepositStatus(sent.hash);
      process.stdout.write(`   status=${s.status}${s.mirrorTxHash ? ` mirror=${s.mirrorTxHash.slice(0, 16)}…` : ""}\r`);
      if (s.status === "FAILED") throw new Error(`mirror failed: ${s.errorMessage ?? "(no message)"}`);
      return s.status === "CONFIRMED" ? s : null;
    },
    5 * 60_000,
    5_000,
    "forward mirror confirmation",
  );
  console.log("");
  console.log(`✅ vETH minted on Preprod`);
  console.log(`   mirror tx: ${status.mirrorTxHash}`);
  console.log(`   cardanoscan: https://preprod.cardanoscan.io/transaction/${status.mirrorTxHash}`);

  return { txHash: sent.hash, mirrorHash: status.mirrorTxHash! };
}

// ── Leg 2: Preprod → Sepolia ───────────────────────────────────────────
async function legReverse(): Promise<{ txHash: string; mirrorHash: string }> {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("LEG 2: Preprod → Sepolia  (bridge addr deposits vETH → ETH back to test user)");
  console.log("═══════════════════════════════════════════════════════════");

  if (!PREPROD_SEED) throw new Error("ROUTE_ETH_SEPOLIA_TO_PREPROD_DEST_WALLET_SEED not set");

  // Submit via UTXORPC, query UTxOs via Koios
  const headers: Record<string, string> = {};
  if (PREPROD_UTXORPC_KEY) headers["dmtr-api-key"] = PREPROD_UTXORPC_KEY;
  const submitter = new U5CProvider({ url: PREPROD_UTXORPC, headers });
  const fetcher = new KoiosProvider("preprod");
  const wallet = new MeshWallet({
    networkId: 0,
    fetcher: fetcher as unknown as IFetcher,
    submitter: submitter as unknown as ISubmitter,
    key: { type: "mnemonic", words: PREPROD_SEED.split(" ") },
  });
  const walletAddr = await wallet.getChangeAddress();
  if (walletAddr !== PREPROD_ADDR) {
    throw new Error(`expected wallet addr ${PREPROD_ADDR}, got ${walletAddr}`);
  }

  // Build self-transfer of vETH with cross-chain metadata. The bridge's
  // CardanoIndexer will see this as a deposit on the preprod-to-eth-sepolia
  // route (because of the asset config). The mirror burns the vETH and
  // sends ETH on Sepolia to the EVM destination in metadata.d.
  const forgeScript = ForgeScript.withOneSignature(walletAddr);
  void forgeScript; // (only needed for minting; the burn happens inside the bridge mirror)
  const tx = new Transaction({ initiator: wallet });
  tx.sendAssets(walletAddr, [
    { unit: VETH_UNIT, quantity: REVERSE_AMOUNT_VETH },
  ]);
  // Cardano metadata: 64-byte chunks for the destination address
  tx.setMetadata(1337, {
    d: TEST_USER_EVM,
    a: "ETH",
    v: "1.1.0",
  });

  const unsigned = await tx.build();
  const signed = await wallet.signTx(unsigned);
  const txHash = await wallet.submitTx(signed);
  console.log(`📤 sent ${REVERSE_AMOUNT_VETH} vETH (self-transfer w/ metadata)`);
  console.log(`   tx hash: ${txHash}`);
  console.log(`   cardanoscan: https://preprod.cardanoscan.io/transaction/${txHash}`);

  await registerDeposit({
    depositTxHash: txHash,
    senderAddress: PREPROD_ADDR,
    recipientAddress: TEST_USER_EVM,
    amount: REVERSE_AMOUNT_VETH,
    sourceNetwork: "cardano",
    routeId: REVERSE_ROUTE_ID,
    assetType: "ETH",
  });

  console.log(`⌛ waiting for bridge to mirror ETH back to ${TEST_USER_EVM} on Sepolia (up to 8 min)...`);
  const status = await waitFor<ApiDepositStatus>(
    async () => {
      const s = await fetchDepositStatus(txHash);
      process.stdout.write(`   status=${s.status}${s.mirrorTxHash ? ` mirror=${s.mirrorTxHash.slice(0, 16)}…` : ""}\r`);
      if (s.status === "FAILED") throw new Error(`mirror failed: ${s.errorMessage ?? "(no message)"}`);
      return s.status === "CONFIRMED" ? s : null;
    },
    8 * 60_000,
    5_000,
    "reverse mirror confirmation",
  );
  console.log("");
  console.log(`✅ ETH delivered on Sepolia`);
  console.log(`   mirror tx: ${status.mirrorTxHash}`);
  console.log(`   etherscan: https://sepolia.etherscan.io/tx/${status.mirrorTxHash}`);

  return { txHash, mirrorHash: status.mirrorTxHash! };
}

// ── Main ───────────────────────────────────────────────────────────────
(async () => {
  console.log(`🌉 ETH ↔ Cardano live bridge E2E`);
  console.log(`   API:        ${API_BASE}`);
  console.log(`   deposit:    ${DEPOSIT_EVM}`);
  console.log(`   withdrawal: ${WITHDRAWAL_EVM}`);
  console.log(`   test user:  ${TEST_USER_EVM}`);
  console.log(`   preprod:    ${PREPROD_ADDR.slice(0, 24)}...`);

  // Sanity: API reachable
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) throw new Error(`health ${res.status}`);
    console.log(`✅ bridge API healthy at ${API_BASE}`);
  } catch (err) {
    console.error(`❌ bridge API not reachable at ${API_BASE} — is the bridge running?`);
    process.exit(1);
  }

  const t0 = Date.now();
  const forward = await legForward();
  const t1 = Date.now();
  console.log(`\n⏱️  leg 1 took ${((t1 - t0) / 1000).toFixed(0)}s`);

  console.log(`\n💤 sleeping 5 minutes before reverse leg...`);
  await sleep(5 * 60_000);

  const reverse = await legReverse();
  const t2 = Date.now();
  console.log(`\n⏱️  leg 2 took ${((t2 - t1 - 5 * 60_000) / 1000).toFixed(0)}s`);

  // Final Sepolia balance check
  const provider = new JsonRpcProvider(ALCHEMY, SEPOLIA_CHAIN_ID);
  const finalBal = await provider.getBalance(TEST_USER_EVM);
  console.log(`\n💰 test user final Sepolia balance: ${formatEther(finalBal)} ETH`);

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`✅ E2E COMPLETE`);
  console.log(`   Sepolia tx (deposit):   ${forward.txHash}`);
  console.log(`   Preprod tx (mint):      ${forward.mirrorHash}`);
  console.log(`   Preprod tx (deposit):   ${reverse.txHash}`);
  console.log(`   Sepolia tx (withdraw):  ${reverse.mirrorHash}`);
  console.log(`═══════════════════════════════════════════════════════════`);
})().catch((err) => {
  console.error("\n❌ E2E failed:", err);
  process.exit(1);
});
