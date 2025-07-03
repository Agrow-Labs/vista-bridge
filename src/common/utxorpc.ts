import { Effect, Context, Layer, Stream } from "effect";
import { CardanoWatchClient, CardanoSubmitClient } from "@utxorpc/sdk";
import { cardano } from "@utxorpc/spec";
import { CML } from '@lucid-evolution/lucid'
import type { DepositEvent } from "./types.js";
import { Config, getUtxorpcHeaders } from "./config.js";

// UTXORPC Error types
export class UtxorpcError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "UtxorpcError";
  }
}

// Define a Utxorpc Service using Context.Tag
export class Utxorpc extends Context.Tag("Utxorpc")<Utxorpc, {
  readonly watchAddresses: (addresses: string[]) => Stream.Stream<DepositEvent, UtxorpcError>;
  readonly submitTransaction: (txCbor: Uint8Array) => Effect.Effect<string, UtxorpcError>;
  readonly waitForTxConfirmation: (txHash: string) => Stream.Stream<string, UtxorpcError>;
  readonly watchMempool: () => Stream.Stream<any, UtxorpcError>;
  readonly close: () => Effect.Effect<void>;
}>() { }

// UTXORPC implementation
const makeUtxorpcService = (config: Context.Tag.Service<Config>): Effect.Effect<Context.Tag.Service<Utxorpc>, UtxorpcError> =>
  Effect.try({
    try: () => {
      const headers = getUtxorpcHeaders('source');

      if (headers && headers['dmtr-api-key']) {
        console.log('🔑 Using dmtr-api-key authentication');
      }

      const clientOptions = {
        uri: config.networks.source.utxorpcEndpoint,
        ...(headers && { headers }),
      };

      const watchClient = new CardanoWatchClient(clientOptions);
      const submitClient = new CardanoSubmitClient(clientOptions);

      return {
        watchAddresses: (addresses: string[]) =>
          Stream.async<DepositEvent, UtxorpcError>((emit) => {
            console.log(`🔍 Watching addresses: ${addresses.join(', ')} on ${config.networks.source.utxorpcEndpoint}`);

            const watchStreams = addresses.map(async (addressBech32) => {
              try {
                const addressBytes = addressToBytes(addressBech32);
                console.log(`📡 Starting watch stream for address: ${addressBech32}`);
                // console.log(`🔑 Auth headers: ${JSON.stringify(headers)}`);

                const txEvents = watchClient.watchTxForAddress(addressBytes);

                for await (const event of txEvents) {
                  console.log(`📨 Received transaction event:`, event);

                  if (event.action === 'apply' && event.Tx) {
                    const deposits = await extractDepositsFromTx(event.Tx, addressBech32);
                    for (const deposit of deposits) {
                      emit.single(deposit);
                    }
                  }
                }
              } catch (error) {
                console.error(`❌ Stream error for address ${addressBech32}:`, error);

                const errorMessage = error instanceof Error ? error.message : String(error);
                const errorCode = (error as any)?.code;

                if (errorMessage.includes('Unauthorized') || errorCode === 16) {
                  console.log('🔍 Authentication failed. Possible causes:');
                  console.log('  1. API key expired or invalid');
                  console.log('  2. API key lacks Watch service permissions');
                  console.log('  3. Endpoint URL is incorrect');
                  console.log('  4. Header format issue');
                  console.log(`  5. Current endpoint: ${config.networks.source.utxorpcEndpoint}`);
                  console.log(`  6. Current headers: ${JSON.stringify(headers)}`);
                }

                emit.fail(new UtxorpcError(`Failed to watch addresses: ${error}`, error));
              }
            });

            // Start all watch streams
            Promise.all(watchStreams).catch(error => {
              emit.fail(new UtxorpcError(`Failed to start watch streams: ${error}`, error));
            });

            return Effect.sync(() => {
              console.log("🔌 Closing UTXORPC watch streams");
            });
          }),

        submitTransaction: (txCbor: Uint8Array) =>
          Effect.tryPromise({
            try: async () => {
              console.log(`📡 Submitting transaction to ${config.networks.source.utxorpcEndpoint}`);

              const txHash = await submitClient.submitTx(txCbor);
              const hashHex = Buffer.from(txHash).toString('hex');

              console.log(`✅ Transaction submitted successfully: ${hashHex}`);
              return hashHex;
            },
            catch: (error) => {
              console.error(`❌ Transaction submission failed:`, error);

              const errorMessage = error instanceof Error ? error.message : String(error);
              const errorCode = (error as any)?.code;

              if (errorMessage.includes('Unauthorized') || errorCode === 16) {
                console.log('🔍 Submit authentication failed. Check API key permissions for Submit service.');
              }

              return new UtxorpcError(`Failed to submit transaction: ${error}`, error);
            },
          }),

        waitForTxConfirmation: (txHash: string) =>
          Stream.async<string, UtxorpcError>((emit) => {
            console.log(`⏳ Waiting for transaction confirmation: ${txHash}`);

            const watchConfirmation = async () => {
              try {
                const txHashBytes = Buffer.from(txHash, 'hex');
                const confirmationStates = submitClient.waitForTx(txHashBytes);

                for await (const stage of confirmationStates) {
                  console.log(`📊 Transaction ${txHash} stage: ${stage}`);
                  emit.single(stage.toString());
                }

                emit.end();
              } catch (error) {
                console.error(`❌ Error waiting for confirmation:`, error);
                emit.fail(new UtxorpcError(`Failed to wait for confirmation: ${error}`, error));
              }
            };

            watchConfirmation();

            return Effect.sync(() => {
              console.log(`🔌 Stopping confirmation watch for ${txHash}`);
            });
          }),

        watchMempool: () =>
          Stream.async<any, UtxorpcError>((emit) => {
            console.log(`👀 Watching mempool on ${config.networks.source.utxorpcEndpoint}`);

            const watchMempoolEvents = async () => {
              try {
                const mempoolEvents = submitClient.watchMempool();

                for await (const event of mempoolEvents) {
                  console.log(`🏊 Mempool event:`, event);
                  emit.single(event);
                }
              } catch (error) {
                console.error(`❌ Error watching mempool:`, error);
                emit.fail(new UtxorpcError(`Failed to watch mempool: ${error}`, error));
              }
            };

            watchMempoolEvents();

            return Effect.sync(() => {
              console.log("🔌 Stopping mempool watch");
            });
          }),

        close: () =>
          Effect.sync(() => {
            console.log("🔌 Closing UTXORPC client connections");
            // The SDK clients don't have explicit close methods
            // Connections will be closed when the instance is garbage collected
          }),
      };
    },
    catch: (error) => new UtxorpcError(`Failed to create UTXORPC service: ${error}`, error),
  });

// Create a Layer that provides the Utxorpc service
export const UtxorpcLive = Layer.effect(
  Utxorpc,
  Effect.flatMap(Config, makeUtxorpcService)
);

// Helper: Convert Bech32 address to bytes
const addressToBytes = (addressBech32: string): Uint8Array => {
  try {
    console.log(`🔄 Converting address to bytes: ${addressBech32}`);

    const cmlAddress = CML.Address.from_bech32(addressBech32);

    const addressBytes = cmlAddress.to_raw_bytes();

    console.log(`✅ Address converted: ${addressBytes.length} bytes`);
    return addressBytes;
  } catch (error) {
    console.error(`❌ Failed to convert address ${addressBech32}:`, error);

    // For UTXORPC compatibility, we can also try using the address as-is in UTF-8 bytes
    // This is a fallback for development/testing purposes
    console.log(`⚠️ Using fallback UTF-8 encoding for address ${addressBech32}`);
    return new TextEncoder().encode(addressBech32);
  }
};

// Helper: Extract deposit information from a transaction
const extractDepositsFromTx = async (tx: cardano.Tx, watchedAddress: string): Promise<DepositEvent[]> => {
  const deposits: DepositEvent[] = [];

  try {
    console.log(`🔍 Extracting deposits from transaction for address: ${watchedAddress}`);

    // Extract transaction hash
    const txHash = tx.hash ? Buffer.from(tx.hash).toString('hex') : 'unknown_hash';

    // Parse transaction outputs to find deposits to the watched address
    if (tx.outputs && tx.outputs.length > 0) {
      for (let outputIndex = 0; outputIndex < tx.outputs.length; outputIndex++) {
        const output = tx.outputs[outputIndex];

        if (output?.address && output.coin !== undefined) {
          try {
            // Convert output address to bech32 for comparison
            const outputAddressBytes = output.address;
            const outputAddressBech32 = CML.Address.from_raw_bytes(outputAddressBytes).to_bech32();

            // Check if this output is to our watched address
            if (outputAddressBech32 === watchedAddress) {
              // Extract ADA amount (lovelace)
              const adaAmount = BigInt(output.coin);

              if (adaAmount > 0) {
                // Extract sender address from first input (simplified approach)
                let senderAddress = "unknown_sender";
                if (tx.inputs && tx.inputs.length > 0) {
                  const firstInput = tx.inputs[0];
                  if (firstInput?.asOutput?.address) {
                    try {
                      const senderBytes = firstInput.asOutput.address;
                      senderAddress = CML.Address.from_raw_bytes(senderBytes).to_bech32();
                    } catch (error) {
                      console.warn(`⚠️ Could not decode sender address:`, error);
                    }
                  }
                }

                const deposit: DepositEvent = {
                  transactionHash: txHash,
                  senderAddress,
                  recipientAddress: watchedAddress,
                  amount: adaAmount,
                  assetType: "ADA",
                  blockSlot: BigInt(0), // Will be set by the indexer from block context
                  blockHash: "unknown_block", // Will be set by the indexer from block context
                  outputIndex,
                  metadata: extractMetadata(tx),
                  timestamp: BigInt(Date.now()),
                };

                deposits.push(deposit);
                console.log(`💰 Found deposit: ${adaAmount} lovelace to ${watchedAddress} (output ${outputIndex})`);
              }
            }
          } catch (error) {
            console.warn(`⚠️ Could not process output ${outputIndex}:`, error);
          }
        }
      }
    }

    if (deposits.length === 0) {
      console.log(`ℹ️ No deposits found for address ${watchedAddress} in transaction ${txHash}`);
    }

    return deposits;
  } catch (error) {
    console.error(`❌ Error extracting deposits:`, error);
    return [];
  }
};

// Helper: Extract metadata from transaction
const extractMetadata = (tx: cardano.Tx): Record<string, string> => {
  const metadata: Record<string, string> = {};

  try {
    if (tx.auxiliary && tx.auxiliary.metadata) {
      // Parse metadata if available
      const metadataArray = tx.auxiliary.metadata;
      if (Array.isArray(metadataArray)) {
        for (const metadataItem of metadataArray) {
          if (metadataItem.label && metadataItem.value) {
            const key = metadataItem.label.toString();
            const value = extractMetadatumValue(metadataItem.value);
            if (value !== null) {
              metadata[key] = value;
            }
          }
        }
      }
    }
  } catch (error) {
    console.warn(`⚠️ Could not extract metadata:`, error);
  }

  return metadata;
};

// Helper: Extract value from Metadatum
const extractMetadatumValue = (metadatum: any): string | null => {
  try {
    if (!metadatum || !metadatum.metadatum) {
      return null;
    }

    const { metadatum: value } = metadatum;

    if (value.case === 'text' && typeof value.value === 'string') {
      return value.value;
    } else if (value.case === 'int' && typeof value.value === 'bigint') {
      return value.value.toString();
    } else if (value.case === 'bytes' && value.value instanceof Uint8Array) {
      return Buffer.from(value.value).toString('utf8');
    } else if (value.case === 'array' || value.case === 'map') {
      return JSON.stringify(value.value);
    }

    return JSON.stringify(value);
  } catch (error) {
    console.warn(`⚠️ Could not extract metadatum value:`, error);
    return null;
  }
};

// Legacy compatibility helpers
export const createAddressPredicate = (addresses: string[]) => ({
  match: {
    cardano: {
      has_address: {
        exact_address: addresses,
      },
    },
  },
});

export const createDepositPredicate = (depositAddresses: string[]) => ({
  match: {
    cardano: {
      produces: {
        address: {
          exact_address: depositAddresses,
        },
      },
    },
  },
});

// Type-safe wrapper for UTXORPC responses
export interface UtxorpcResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export const wrapUtxorpcCall = <T>(
  call: Effect.Effect<T, UtxorpcError>
): Effect.Effect<T, UtxorpcError> => call; 