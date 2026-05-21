// EVM Mirror — builds, signs, and submits mirror transactions on an EVM chain.
// Mirrors a deposit from the source chain by sending native ETH (amount - fee)
// from the configured signer to the depositor's address on the destination chain.
import { Effect, Stream, Schedule } from "effect";
import {
  JsonRpcProvider,
  WebSocketProvider,
  Wallet,
  type Provider,
  formatEther,
} from "ethers";
import type { IChainMirror } from "../common/chain-interfaces.js";
import type { BridgeRoute } from "../common/route.js";
import { getAssetConfig } from "../common/route.js";
import type { DepositEvent, BridgeState } from "../common/types.js";

export class EvmMirrorError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "EvmMirrorError";
  }
}

interface RelayerService {
  updateMirrorStatus: (depositTxHash: string, mirrorTxHash: string, status: string, errorMessage?: string) => Effect.Effect<boolean, Error>;
  getBridgeState: (routeId?: string) => Effect.Effect<BridgeState, Error>;
  getPendingDeposits: (routeId?: string) => Effect.Effect<DepositEvent[], Error>;
  subscribeToDeposits: Stream.Stream<DepositEvent, Error>;
}

/**
 * EVM-specific chain mirror.
 * Sends native ETH from `route.destination.walletPrivateKey` to each deposit's
 * senderAddress. Fee for ETH is route.bridge.feeAmount (in wei, deducted from amount).
 */
export class EvmMirror implements IChainMirror {
  readonly chainId: string;

  constructor(
    private readonly route: BridgeRoute,
    private readonly relayer: RelayerService,
  ) {
    this.chainId = route.destination.chainId;
  }

  get run(): Effect.Effect<never, Error> {
    const { route, relayer } = this;

    return Effect.gen(function* () {
      const wsUrl = route.destination.wsEndpoint;
      const httpUrl = route.destination.rpcEndpoint;
      const privateKey = route.destination.walletPrivateKey;
      if (!privateKey) {
        return yield* Effect.fail(new EvmMirrorError(`No walletPrivateKey for route ${route.id}`));
      }
      if (!wsUrl && !httpUrl) {
        return yield* Effect.fail(new EvmMirrorError(`Route ${route.id}: destination needs rpcEndpoint or wsEndpoint`));
      }

      const provider: Provider = wsUrl
        ? new WebSocketProvider(wsUrl, route.destination.evmChainId)
        : new JsonRpcProvider(httpUrl, route.destination.evmChainId);
      const wallet = new Wallet(privateKey, provider);
      console.log(`✅ EvmMirror [${route.id}]: Wallet ${wallet.address} on chainId=${route.destination.evmChainId ?? "auto"}`);

      // Apply a 25% headroom on top of provider-suggested gas prices so we don't
      // get stuck behind a Sepolia spike. EIP-1559 only — legacy chains fall back
      // to `gasPrice`.
      const bump = (n: bigint) => (n * 125n) / 100n;

      // For genuine cross-chain (Cardano → EVM), the depositor's senderAddress
      // is a Cardano addr and can't receive ETH. The cross-chain EVM destination
      // arrives via the register API in deposit.recipientAddress.
      const isCrossChainFromCardano = route.source.chainType === "cardano";
      const resolveEvmRecipient = (deposit: DepositEvent): string => {
        if (isCrossChainFromCardano) {
          const r = deposit.recipientAddress;
          if (!r || !/^0x[a-fA-F0-9]{40}$/.test(r)) {
            throw new EvmMirrorError(
              `Cross-chain deposit ${deposit.transactionHash} has no EVM recipientAddress — caller must POST /api/deposit/register first`,
            );
          }
          return r;
        }
        return deposit.senderAddress;
      };

      // ── Build, sign, submit ──────────────────────────────────────
      const sendMirror = (deposit: DepositEvent): Effect.Effect<string, EvmMirrorError> =>
        Effect.tryPromise({
          try: async () => {
            if (deposit.assetType !== "ETH") {
              throw new Error(`Unsupported asset on EVM destination: ${deposit.assetType}`);
            }
            const assetCfg = getAssetConfig(route, deposit.assetType);
            const fee = BigInt(assetCfg.feeLovelace); // wei for EVM
            const net = deposit.amount - fee;
            if (net <= 0n) {
              throw new Error(`Insufficient after fee: ${deposit.amount} - ${fee} = ${net}`);
            }
            const recipient = resolveEvmRecipient(deposit);

            // Estimate gas + fees and pre-flight a balance check so we fail
            // fast with a clear message when the signer is underfunded.
            const feeData = await provider.getFeeData();
            const gasLimit = 21_000n; // pure ETH transfer
            let txReq: {
              to: string;
              value: bigint;
              gasLimit: bigint;
              maxFeePerGas?: bigint;
              maxPriorityFeePerGas?: bigint;
              gasPrice?: bigint;
            } = { to: recipient, value: net, gasLimit };

            let estGasCost: bigint;
            if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
              txReq.maxFeePerGas = bump(feeData.maxFeePerGas);
              txReq.maxPriorityFeePerGas = bump(feeData.maxPriorityFeePerGas);
              estGasCost = txReq.maxFeePerGas * gasLimit;
            } else if (feeData.gasPrice != null) {
              txReq.gasPrice = bump(feeData.gasPrice);
              estGasCost = txReq.gasPrice * gasLimit;
            } else {
              throw new Error("Provider returned no fee data");
            }

            const balance = await provider.getBalance(wallet.address);
            const needed = net + estGasCost;
            if (balance < needed) {
              throw new Error(
                `Signer ${wallet.address} balance ${formatEther(balance)} ETH < needed ${formatEther(needed)} ETH (transfer ${formatEther(net)} + gas ${formatEther(estGasCost)}). Fund this address from a Sepolia faucet.`,
              );
            }

            console.log(
              `🏗️ EvmMirror [${route.id}]: ${formatEther(net)} ETH → ${recipient} (gas ≈ ${formatEther(estGasCost)} ETH)`,
            );
            const tx = await wallet.sendTransaction(txReq);
            console.log(`✅ EvmMirror [${route.id}]: Submitted ${tx.hash}`);
            const receipt = await tx.wait(1);
            if (!receipt || receipt.status !== 1) {
              throw new Error(`Tx ${tx.hash} reverted or no receipt`);
            }
            console.log(`✅ EvmMirror [${route.id}]: ${tx.hash} confirmed in block ${receipt.blockNumber}`);
            return tx.hash;
          },
          catch: (error) => new EvmMirrorError(`Mirror failed: ${error instanceof Error ? error.message : error}`, error),
        });

      // Prevent concurrent processing of the same deposit
      const inFlight = new Set<string>();

      const processDeposit = (deposit: DepositEvent): Effect.Effect<void, EvmMirrorError> =>
        Effect.gen(function* () {
          const depHash = deposit.transactionHash;
          if (inFlight.has(depHash)) return;

          const state = yield* relayer.getBridgeState(route.id).pipe(
            Effect.mapError((e) => new EvmMirrorError(`DB check failed: ${e.message}`, e)),
          );
          if (state.processedDeposits.some((d) => d.transactionHash === depHash)) return;

          inFlight.add(depHash);
          try {
            console.log(`🔨 EvmMirror [${route.id}]: Processing ${depHash.slice(0, 16)}...`);
            const mirrorTxHash = yield* sendMirror(deposit);
            yield* relayer.updateMirrorStatus(depHash, mirrorTxHash, "CONFIRMED").pipe(
              Effect.mapError((e) => new EvmMirrorError(e.message, e)),
            );
            console.log(`✅ EvmMirror [${route.id}]: ${depHash.slice(0, 16)}... → ${mirrorTxHash.slice(0, 16)}... CONFIRMED`);
          } finally {
            inFlight.delete(depHash);
          }
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const state = yield* relayer.getBridgeState(route.id).pipe(
                Effect.catchAll(() => Effect.succeed({ processedDeposits: [], pendingMirrors: [], lastProcessedSlot: BigInt(0), lastProcessedBlockHash: "" })),
              );
              if (state.processedDeposits.some((d) => d.transactionHash === deposit.transactionHash)) return;
              console.error(`❌ EvmMirror [${route.id}]: Failed ${deposit.transactionHash.slice(0, 16)}...: ${error.message}`);
              yield* relayer.updateMirrorStatus(deposit.transactionHash, "", "FAILED", error.message).pipe(
                Effect.mapError((e) => new EvmMirrorError(e.message, e)),
                Effect.catchAll(() => Effect.void),
              );
            }),
          ),
        );

      console.log(`🔄 EvmMirror [${route.id}]: Started (ethers v6)`);

      yield* Effect.gen(function* () {
        const pending = yield* relayer.getPendingDeposits(route.id).pipe(
          Effect.mapError((e) => new EvmMirrorError(e.message, e)),
        );
        if (pending.length > 0) {
          console.log(`🔍 EvmMirror [${route.id}]: ${pending.length} pending deposits`);
          // Serialize: EVM nonces must increment sequentially per signer
          yield* Effect.forEach(pending, processDeposit, { concurrency: 1 });
        }
      }).pipe(
        Effect.catchAll((error) => {
          console.error(`❌ EvmMirror [${route.id}]: Pending check error:`, error);
          return Effect.void;
        }),
        Effect.repeat(Schedule.fixed("5 seconds")),
        Effect.fork,
      );

      yield* relayer.subscribeToDeposits.pipe(
        Stream.filter((dep) => dep.routeId === route.id),
        Stream.mapEffect(processDeposit),
        Stream.catchAll(() => {
          console.log(`🔄 EvmMirror [${route.id}]: Stream interrupted, restarting...`);
          return Stream.empty;
        }),
        Stream.runDrain,
      );

      yield* Effect.never;
    }) as Effect.Effect<never, Error>;
  }
}
