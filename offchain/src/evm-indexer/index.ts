// EVM Indexer — watches an Ethereum (or EVM-compatible) chain for incoming
// native-asset (ETH) deposits to one of the configured deposit addresses.
//
// Strategy: subscribe to new blocks via WebSocket (eth_subscribe newHeads) when
// a wsEndpoint is provided, otherwise poll via JsonRpcProvider. For each new
// block tip we scan the block at (tip - evmConfirmations) so that only
// already-confirmed deposits are emitted to the relayer.
import { Effect, Stream, Schedule } from "effect";
import {
  JsonRpcProvider,
  WebSocketProvider,
  type Provider,
  type Block,
  type TransactionResponse,
  formatEther,
} from "ethers";
import type { IChainIndexer } from "../common/chain-interfaces.js";
import type { BridgeRoute } from "../common/route.js";
import { getAssetConfig } from "../common/route.js";
import type { DepositEvent } from "../common/types.js";
import { IndexerError } from "../common/types.js";

interface RelayerService {
  publishDeposit: (event: DepositEvent) => Effect.Effect<{ success: boolean; messageId: string }, Error>;
}

/**
 * EVM-specific chain indexer for native ETH deposits.
 * Watches `route.source.addresses` for incoming transactions and publishes
 * confirmed DepositEvents to the relayer.
 */
export class EvmIndexer implements IChainIndexer {
  readonly chainId: string;

  constructor(
    private readonly route: BridgeRoute,
    private readonly relayer: RelayerService,
  ) {
    this.chainId = route.source.chainId;
  }

  get run(): Effect.Effect<never, Error> {
    const { route, relayer } = this;
    const processedTxHashes = new Set<string>();
    // Lowercase deposit addresses for case-insensitive matching (EVM addresses are checksummed)
    const watchedAddrs = new Set(route.source.addresses.map((a) => a.toLowerCase()));
    const confirmations = route.source.evmConfirmations ?? Math.max(1, route.security.requiredConfirmations);

    const validateDeposit = (deposit: DepositEvent): Effect.Effect<void, IndexerError> =>
      Effect.gen(function* () {
        if (!route.bridge.allowedAssets.includes(deposit.assetType)) {
          return yield* Effect.fail(new IndexerError(`Asset ${deposit.assetType} not allowed`));
        }
        const assetCfg = getAssetConfig(route, deposit.assetType);
        const minAmount = BigInt(assetCfg.minDepositAmount);
        const maxAmount = BigInt(assetCfg.maxTransferAmount);
        if (deposit.amount < minAmount) {
          return yield* Effect.fail(new IndexerError(`Amount ${deposit.amount} below min ${minAmount}`));
        }
        if (deposit.amount > maxAmount) {
          return yield* Effect.fail(new IndexerError(`Amount ${deposit.amount} above max ${maxAmount}`));
        }
      });

    const processDeposit = (deposit: DepositEvent): Effect.Effect<void, IndexerError> =>
      Effect.gen(function* () {
        if (processedTxHashes.has(deposit.transactionHash)) return;
        deposit.routeId = route.id;
        console.log(`💰 EvmIndexer [${route.id}]: ${deposit.transactionHash} — ${formatEther(deposit.amount)} ETH from ${deposit.senderAddress}`);
        yield* validateDeposit(deposit);
        processedTxHashes.add(deposit.transactionHash);
        const result = yield* relayer.publishDeposit(deposit).pipe(
          Effect.mapError((e) => new IndexerError(`Publish failed: ${e.message}`, e)),
        );
        if (!result.success) {
          return yield* Effect.fail(new IndexerError(`Publish failed for ${deposit.transactionHash}`));
        }
        console.log(`✅ EvmIndexer [${route.id}]: Published ${deposit.transactionHash}`);
      });

    return Effect.gen(function* () {
      if (route.source.addresses.length === 0) {
        return yield* Effect.fail(new IndexerError(`No deposit addresses for route ${route.id}`));
      }
      const wsUrl = route.source.wsEndpoint;
      const httpUrl = route.source.rpcEndpoint;
      if (!wsUrl && !httpUrl) {
        return yield* Effect.fail(new IndexerError(`Route ${route.id}: source needs rpcEndpoint or wsEndpoint`));
      }

      let provider: Provider;
      if (wsUrl) {
        provider = new WebSocketProvider(wsUrl, route.source.evmChainId);
        console.log(`👀 EvmIndexer [${route.id}]: WS subscribed to ${wsUrl} (${route.source.addresses.length} addrs, ${confirmations} conf)`);
      } else {
        provider = new JsonRpcProvider(httpUrl, route.source.evmChainId);
        console.log(`👀 EvmIndexer [${route.id}]: HTTP polling ${httpUrl} (${route.source.addresses.length} addrs, ${confirmations} conf)`);
      }

      // Extract matching deposits from a block.
      const scanBlock = async (blockNumber: number): Promise<DepositEvent[]> => {
        const block: Block | null = await provider.getBlock(blockNumber, true);
        if (!block) return [];
        const deposits: DepositEvent[] = [];
        for (const txOrHash of block.prefetchedTransactions ?? []) {
          const tx = txOrHash as TransactionResponse;
          if (!tx.to || tx.value === 0n) continue;
          if (!watchedAddrs.has(tx.to.toLowerCase())) continue;
          deposits.push({
            routeId: route.id,
            transactionHash: tx.hash,
            senderAddress: tx.from,
            // Leave recipientAddress empty — cross-chain destination must come
            // from POST /api/deposit/register. If we wrote the deposit address
            // here it would overwrite a prior register call (INSERT OR REPLACE)
            // and the Cardano mirror would refuse to mint.
            recipientAddress: "",
            amount: tx.value,
            assetType: "ETH",
            blockSlot: BigInt(block.number),
            blockHash: block.hash ?? "",
            outputIndex: 0,
            metadata: {},
            timestamp: BigInt(block.timestamp),
          });
        }
        return deposits;
      };

      // Stream of confirmed block numbers (tip - confirmations).
      const depositStream = Stream.async<DepositEvent, IndexerError>((emit) => {
        let lastScanned = -1;
        const onBlock = async (tipNumber: number) => {
          try {
            const target = tipNumber - confirmations;
            if (target < 0) return;
            // First-run baseline: only scan the latest confirmed block, not history.
            const fromBlock = lastScanned < 0 ? target : lastScanned + 1;
            lastScanned = target;
            for (let bn = fromBlock; bn <= target; bn++) {
              const deps = await scanBlock(bn);
              for (const dep of deps) emit.single(dep);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`⚠️ EvmIndexer [${route.id}]: scan error at tip ${tipNumber}: ${msg}`);
          }
        };
        provider.on("block", onBlock);
        return Effect.sync(() => {
          provider.off("block", onBlock);
          if (provider instanceof WebSocketProvider) {
            void provider.destroy();
          }
        });
      });

      yield* depositStream.pipe(
        Stream.mapEffect(processDeposit),
        Stream.runDrain,
      );
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          console.log(`🔄 EvmIndexer [${route.id}]: Stream interrupted (${error.message ?? error}), reconnecting in 30s...`);
          yield* Effect.sleep("30 seconds");
        }),
      ),
      Effect.repeat(Schedule.forever),
    ) as Effect.Effect<never, Error>;
  }
}
