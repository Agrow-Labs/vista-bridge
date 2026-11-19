// Test EVM wallet API endpoints for Playwright E2E tests.
// Provides EIP-1193 compatible responses using ethers with a test private key.
// Loaded only when the bridge starts in dev/test mode (gated behind testWalletRoutes).
import { Elysia, t } from "elysia";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

// Load test wallet credentials
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });

const PRIVATE_KEY = process.env.E2E_EVM_PRIVATE_KEY ?? "";
const RPC_URL =
  process.env.E2E_EVM_RPC_URL ??
  process.env.ROUTE_ETH_SEPOLIA_TO_PREPROD_SOURCE_RPC_URL ??
  "";
const CHAIN_ID = 11155111; // Sepolia

let _wallet: Wallet | null = null;
let _provider: JsonRpcProvider | null = null;

function getWallet(): Wallet {
  if (!_wallet) {
    if (!PRIVATE_KEY) throw new Error("E2E_EVM_PRIVATE_KEY not configured");
    if (!RPC_URL) throw new Error("E2E_EVM_RPC_URL not configured");
    _provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
    _wallet = new Wallet(PRIVATE_KEY, _provider);
    console.log(`🧪 EVM test wallet initialized: ${_wallet.address}`);
  }
  return _wallet;
}

function getProvider(): JsonRpcProvider {
  getWallet();
  return _provider!;
}

export function testEvmWalletRoutes() {
  return (
    new Elysia({ prefix: "/api/test/evm" })

      // ── Address ───────────────────────────────────────────────────
      .get("/address", () => {
        const w = getWallet();
        return { address: w.address, chainId: CHAIN_ID, chainIdHex: "0x" + CHAIN_ID.toString(16) };
      })

      // ── Balance (in wei + ETH) ────────────────────────────────────
      .get("/balance", async () => {
        const w = getWallet();
        const bal = await getProvider().getBalance(w.address);
        return {
          address: w.address,
          wei: bal.toString(),
          weiHex: "0x" + bal.toString(16),
          eth: formatEther(bal),
        };
      })

      // ── Send a tx (signs + broadcasts with test key) ──────────────
      .post(
        "/sendTransaction",
        async ({ body, set }) => {
          try {
            const w = getWallet();
            const provider = getProvider();
            // body.value/gas may be hex strings — accept both hex and decimal
            const toBigInt = (v?: string): bigint | undefined => {
              if (v == null || v === "") return undefined;
              return v.startsWith("0x") ? BigInt(v) : BigInt(v);
            };

            // Use EIP-1559 with the same headroom as the production EvmMirror.
            const feeData = await provider.getFeeData();
            const bump = (n: bigint) => (n * 125n) / 100n;
            const txReq: {
              to: string;
              value: bigint;
              data?: string;
              maxFeePerGas?: bigint;
              maxPriorityFeePerGas?: bigint;
              gasPrice?: bigint;
            } = {
              to: body.to,
              value: toBigInt(body.value) ?? 0n,
            };
            if (body.data) txReq.data = body.data;
            if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
              txReq.maxFeePerGas = bump(feeData.maxFeePerGas);
              txReq.maxPriorityFeePerGas = bump(feeData.maxPriorityFeePerGas);
            } else if (feeData.gasPrice != null) {
              txReq.gasPrice = bump(feeData.gasPrice);
            }

            const tx = await w.sendTransaction(txReq);
            console.log(`🧪 EVM test tx submitted: ${tx.hash} (to ${body.to}, value ${body.value})`);
            return { txHash: tx.hash, from: w.address };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("🧪 EVM test sendTransaction failed:", msg);
            set.status = 500;
            return { error: msg };
          }
        },
        {
          body: t.Object({
            to: t.String(),
            value: t.Optional(t.String()),
            data: t.Optional(t.String()),
          }),
        },
      )

      // ── Wait for receipt (lets tests block on confirmation) ───────
      .get("/receipt/:hash", async ({ params, set }) => {
        try {
          const r = await getProvider().getTransactionReceipt(params.hash);
          if (!r) {
            set.status = 404;
            return { error: "no receipt yet" };
          }
          return {
            txHash: r.hash,
            blockNumber: r.blockNumber,
            status: r.status,
            from: r.from,
            to: r.to,
          };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })
  );
}
