import { useState, useEffect } from 'react';
import { 
  readParams, 
  searchUtxosByAddress, 
  getAddressAssets,
} from '../services/utxorpc';

/**
 * React hook for querying UTxOs using UTxO RPC SDK
 * @param addressHex Cardano address in hex format
 * @param autoFetch Whether to automatically fetch on mount
 */
export const useUtxoRpc = (addressHex: string | null, autoFetch: boolean = true) => {
  const [utxos, setUtxos] = useState<any[]>([]);
  const [assets, setAssets] = useState<Array<{ unit: string; quantity: string }>>([]);
  const [chainParams, setChainParams] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUtxos = async (addr: string) => {
    try {
      setLoading(true);
      setError(null);
      const utxoData = await searchUtxosByAddress(addr);
      setUtxos(utxoData);
      
      // Also fetch aggregated assets for convenience
      const assetData = await getAddressAssets(addr);
      setAssets(assetData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch UTxOs';
      setError(errorMessage);
      console.error('Error fetching UTxOs:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchChainParams = async () => {
    try {
      const params = await readParams();
      setChainParams(params);
    } catch (err) {
      console.error('Error fetching chain params:', err);
    }
  };

  useEffect(() => {
    if (autoFetch && addressHex) {
      fetchUtxos(addressHex);
    }
  }, [addressHex, autoFetch]);

  useEffect(() => {
    // Fetch chain params once on mount
    fetchChainParams();
  }, []);

  return {
    utxos,
    assets,
    chainParams,
    loading,
    error,
    refetch: () => addressHex && fetchUtxos(addressHex),
    fetchChainParams,
  };
};

