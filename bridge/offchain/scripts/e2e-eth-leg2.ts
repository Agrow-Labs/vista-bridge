// Leg 2 only: Preprod → Sepolia (assumes leg 1 already minted vETH at the bridge addr)
import { JsonRpcProvider, formatEther } from "ethers";
import { MeshWallet, Transaction, KoiosProvider, U5CProvider } from "@meshsdk/core";
import type { IFetcher, ISubmitter } from "@meshsdk/core";
import "dotenv/config";

const ALCHEMY = process.env.ROUTE_ETH_SEPOLIA_TO_PREPROD_SOURCE_RPC_URL ?? "";
const TEST_USER_EVM = "0x037B747521AEb1C8999480E85f0404e5aF1C6195";
const PREPROD_ADDR = "addr_test1qpnueplse6f4d55eumh7f3tzp3wx882xk7qs6ydxtynrfsw89vzfjf0v4yca056el40n7pr568rdls6lp6eu0dwek9nqku88yp";
const PREPROD_SEED = process.env.ROUTE_ETH_SEPOLIA_TO_PREPROD_DEST_WALLET_SEED ?? "";
const PREPROD_UTXORPC = "https://cardano-preprod.utxorpc-m1.demeter.run";
const PREPROD_UTXORPC_KEY = process.env.ROUTE_ETH_SEPOLIA_TO_PREPROD_DEST_API_KEY ?? "";
const VETH_UNIT = "18d477cee2bee00475729bcf7da5ca456d07207d192c6cf11ff8fc7576455448";
const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const REVERSE_ROUTE_ID = "preprod-to-eth-sepolia";

// Amount to bridge back (slightly less than what was minted, to leave room for fees)
const REVERSE_VETH = (BigInt("5000000000000000") - BigInt("100000000000000")).toString(); // 0.0049e18

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor<T>(p: () => Promise<T | null | undefined>, timeoutMs: number, every: number, label: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await p();
    if (r) return r;
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

(async () => {
  console.log(`🌉 ETH ↔ Cardano live bridge — LEG 2 (Preprod → Sepolia)`);

  if (!PREPROD_SEED) throw new Error("missing PREPROD seed env");

  // Sanity: bridge healthy
  const h = await fetch(`${API_BASE}/api/health`);
  if (!h.ok) throw new Error(`bridge unhealthy ${h.status}`);
  console.log(`✅ bridge API healthy`);

  // Track test user balance on Sepolia before/after
  const provider = new JsonRpcProvider(ALCHEMY, 11155111);
  const before = await provider.getBalance(TEST_USER_EVM);
  console.log(`💰 test user Sepolia balance BEFORE: ${formatEther(before)} ETH`);

  // Build Cardano tx: self-transfer vETH with cross-chain metadata
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
  const addr = await wallet.getChangeAddress();
  if (addr !== PREPROD_ADDR) throw new Error(`expected ${PREPROD_ADDR}, got ${addr}`);

  const tx = new Transaction({ initiator: wallet });
  tx.sendAssets(addr, [{ unit: VETH_UNIT, quantity: REVERSE_VETH }]);
  tx.setMetadata(1337, { d: TEST_USER_EVM, a: "ETH", v: "1.1.0" });
  const unsigned = await tx.build();
  const signed = await wallet.signTx(unsigned);
  const txHash = await wallet.submitTx(signed);
  console.log(`📤 submitted vETH self-transfer (${REVERSE_VETH} units)`);
  console.log(`   tx: ${txHash}`);
  console.log(`   cardanoscan: https://preprod.cardanoscan.io/transaction/${txHash}`);

  // Register the cross-chain destination with the bridge
  const reg = await fetch(`${API_BASE}/api/deposit/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      depositTxHash: txHash,
      senderAddress: PREPROD_ADDR,
      recipientAddress: TEST_USER_EVM,
      amount: REVERSE_VETH,
      sourceNetwork: "cardano",
      routeId: REVERSE_ROUTE_ID,
      assetType: "ETH",
    }),
  });
  const regBody = await reg.json();
  console.log(`📡 register API → ${regBody.success ? "ok" : "fail"}: ${regBody.message}`);

  // Wait for the bridge to mirror ETH back on Sepolia
  console.log(`⌛ waiting for EvmMirror to send ETH back to ${TEST_USER_EVM} (up to 10 min)...`);
  const status = await waitFor<ApiDepositStatus>(
    async () => {
      const r = await fetch(`${API_BASE}/api/deposit/${txHash}`);
      if (!r.ok) return null;
      const s = (await r.json()) as ApiDepositStatus;
      process.stdout.write(`   status=${s.status}${s.mirrorTxHash ? ` mirror=${s.mirrorTxHash.slice(0, 16)}…` : ""}\r`);
      if (s.status === "FAILED") throw new Error(`mirror failed: ${s.errorMessage ?? "(no message)"}`);
      return s.status === "CONFIRMED" ? s : null;
    },
    10 * 60_000,
    5_000,
    "reverse mirror confirmation",
  );
  console.log("");
  console.log(`✅ EvmMirror reports ETH sent: ${status.mirrorTxHash}`);
  console.log(`   etherscan: https://sepolia.etherscan.io/tx/${status.mirrorTxHash}`);

  // Wait until the on-chain ETH balance bumps
  console.log(`⌛ waiting for receipt to settle...`);
  await waitFor<boolean>(
    async () => {
      const p = new JsonRpcProvider(ALCHEMY, 11155111);
      const now = await p.getBalance(TEST_USER_EVM, "latest");
      return now > before ? true : null;
    },
    3 * 60_000,
    5_000,
    "test user balance bump",
  );
  const after = await new JsonRpcProvider(ALCHEMY, 11155111).getBalance(TEST_USER_EVM, "latest");
  console.log(`💰 test user Sepolia balance AFTER:  ${formatEther(after)} ETH  (Δ ${formatEther(after - before)} ETH)`);

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`✅ LEG 2 COMPLETE`);
  console.log(`   Preprod deposit:   ${txHash}`);
  console.log(`   Sepolia mirror:    ${status.mirrorTxHash}`);
  console.log(`═══════════════════════════════════════════════════════════`);
})().catch((err) => {
  console.error("\n❌ leg 2 failed:", err);
  process.exit(1);
});
