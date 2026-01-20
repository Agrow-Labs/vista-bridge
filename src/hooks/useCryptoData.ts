import { useState, useEffect } from 'react';
import { ADA_ICON_URL } from '../services/blockfrost';

export interface CryptoAsset {
  symbol: string;
  amount?: string;
  icon: string;
  image: string;
  price?: number;
  priceChange24h?: number;
  marketCap?: number;
  volume24h?: number;
  chain?: string;
}

interface UseCryptoDataReturn {
  cryptoAssets: CryptoAsset[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export const useCryptoData = (): UseCryptoDataReturn => {
  const [cryptoAssets, setCryptoAssets] = useState<CryptoAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCoinData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Create ADA asset using Blockfrost data structure
      // ADA is the native currency (lovelace) on Cardano
      const adaAsset: CryptoAsset = {
        symbol: 'ADA',
        icon: '₳',
        image: ADA_ICON_URL,
        chain: 'cardano'
      };

      setCryptoAssets([adaAsset]);
    } catch (err) {
      setError('Failed to fetch cryptocurrency data.');
    } finally {
      setLoading(false);
    }
  };


  useEffect(() => {
    fetchCoinData();
  }, []);

  const refetch = () => {
    fetchCoinData();
  };

  return {
    cryptoAssets,
    loading,
    error,
    refetch
  };
};