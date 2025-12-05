import { 
  CardanoQueryClient, 
  CardanoSyncClient, 
  CardanoSubmitClient 
} from '@utxorpc/sdk';

// Get UTxO RPC endpoint from environment variable
// Dolos exposes UTxO RPC on port 50051 by default
const UTXORPC_URI = import.meta.env.VITE_UTXORPC_URL || 'http://localhost:50051';

// Initialize clients (lazy initialization)
let queryClient: CardanoQueryClient | null = null;
let syncClient: CardanoSyncClient | null = null;
let submitClient: CardanoSubmitClient | null = null;

/**
 * Get or create the CardanoQueryClient instance
 */
const getQueryClient = (): CardanoQueryClient => {
  if (!queryClient) {
    queryClient = new CardanoQueryClient({
      uri: UTXORPC_URI
    });
  }
  return queryClient;
};

/**
 * Get or create the CardanoSyncClient instance
 */
const getSyncClient = (): CardanoSyncClient => {
  if (!syncClient) {
    syncClient = new CardanoSyncClient({
      uri: UTXORPC_URI
    });
  }
  return syncClient;
};

/**
 * Get or create the CardanoSubmitClient instance
 */
const getSubmitClient = (): CardanoSubmitClient => {
  if (!submitClient) {
    submitClient = new CardanoSubmitClient({
      uri: UTXORPC_URI
    });
  }
  return submitClient;
};

// ============================================================================
// Query Module - For querying blockchain state
// ============================================================================

/**
 * Read blockchain parameters (protocol parameters)
 * @returns Chain parameters including network ID, epoch length, etc.
 */
export const readParams = async () => {
  try {
    const client = getQueryClient();
    const params = await client.readParams();
    return params;
  } catch (error) {
    console.error('Error reading params:', error);
    throw error;
  }
};

/**
 * Search UTxOs by address
 * @param address Cardano address (as hex string or Buffer)
 * @returns Array of UTxOs at the given address
 */
export const searchUtxosByAddress = async (address: string | Buffer) => {
  try {
    const client = getQueryClient();
    const addressBuffer = typeof address === 'string' 
      ? Buffer.from(address, 'hex') 
      : address;
    const utxos = await client.searchUtxosByAddress(addressBuffer);
    return utxos;
  } catch (error) {
    console.error('Error searching UTxOs by address:', error);
    throw error;
  }
};

/**
 * Search UTxOs by address (string format - handles bech32 addresses)
 * Converts bech32 address to hex if needed
 * @param address Cardano address in bech32 format (e.g., "addr1...")
 * @returns Array of UTxOs at the given address
 */
export const searchUtxosByBech32Address = async (address: string) => {
  try {
    // Note: The SDK expects hex-encoded address bytes
    // If you have a bech32 address, you may need to decode it first
    // For now, this assumes the address is already in hex format
    // You might need to use a library like @cardano-foundation/cardano-js-sdk to decode bech32
    return await searchUtxosByAddress(address);
  } catch (error) {
    console.error('Error searching UTxOs by bech32 address:', error);
    throw error;
  }
};

// ============================================================================
// Sync Module - For synchronizing with blockchain
// ============================================================================

/**
 * Follow the blockchain tip (streaming)
 * @param points Array of chain points to start from
 * @returns Async iterable of chain events
 */
export const followTip = async function* (points: Array<{ slot: number; hash: string }>) {
  try {
    const client = getSyncClient();
    const tip = client.followTip(points);
    for await (const event of tip) {
      yield event;
    }
  } catch (error) {
    console.error('Error following tip:', error);
    throw error;
  }
};

/**
 * Fetch a specific block
 * @param point Chain point (slot and hash)
 * @returns Block data
 */
export const fetchBlock = async (point: { slot: number; hash: string }) => {
  try {
    const client = getSyncClient();
    const block = await client.fetchBlock(point);
    return block;
  } catch (error) {
    console.error('Error fetching block:', error);
    throw error;
  }
};

// ============================================================================
// Submit Module - For submitting transactions
// ============================================================================

/**
 * Submit a transaction to the blockchain
 * @param txHex Transaction in hex format
 * @returns Transaction hash
 */
export const submitTx = async (txHex: string): Promise<string> => {
  try {
    const client = getSubmitClient();
    const txBuffer = Buffer.from(txHex, 'hex');
    const txHash = await client.submitTx(txBuffer);
    const txHashHex = Buffer.from(txHash).toString('hex');
    return txHashHex;
  } catch (error) {
    console.error('Error submitting transaction:', error);
    throw error;
  }
};

// ============================================================================
// Helper Functions - For common use cases
// ============================================================================

/**
 * Get all assets (ADA + native assets) for an address
 * Aggregates UTxOs and returns asset balances
 * @param addressHex Address in hex format
 * @returns Array of assets with their quantities
 */
export const getAddressAssets = async (addressHex: string) => {
  try {
    const utxos = await searchUtxosByAddress(addressHex);
    const assetMap = new Map<string, bigint>();
    let totalLovelace = BigInt(0);

    for (const utxo of utxos) {
      // Add lovelace
      if (utxo.coins) {
        totalLovelace += BigInt(utxo.coins.toString());
      }

      // Add native assets
      if (utxo.assets) {
        for (const asset of utxo.assets) {
          const unit = asset.unit.toString('hex');
          const quantity = BigInt(asset.quantity.toString());
          const current = assetMap.get(unit) || BigInt(0);
          assetMap.set(unit, current + quantity);
        }
      }
    }

    const assets: Array<{ unit: string; quantity: string }> = [];

    // Add ADA (lovelace)
    if (totalLovelace > 0) {
      assets.push({
        unit: 'lovelace',
        quantity: totalLovelace.toString(),
      });
    }

    // Add native assets
    for (const [unit, quantity] of assetMap.entries()) {
      assets.push({
        unit,
        quantity: quantity.toString(),
      });
    }

    return assets;
  } catch (error) {
    console.error('Error getting address assets:', error);
    throw error;
  }
};

// Export client getters for advanced usage
export { getQueryClient, getSyncClient, getSubmitClient };

