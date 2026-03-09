import { useState, useEffect } from 'react';
import { getADABTCData, convertCoinGeckoToCryptoAsset } from '../services/coingecko';


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
      
      // Fetch both Cardano assets and CoinGecko data in parallel
      const [cardanoAssets, coinGeckoData] = await Promise.allSettled([
        // Fetch Cardano assets from Dolos (if needed in the future)
        (async () => {
          return [];
        })(),
        // Fetch ADA and BTC data from CoinGecko
        (async () => {
          const coinGeckoPrices = await getADABTCData();
          return coinGeckoPrices.map(coin => convertCoinGeckoToCryptoAsset(coin));
        })()
      ]);

      const allAssets: CryptoAsset[] = [];

      // Add Cardano assets if successful
      if (cardanoAssets.status === 'fulfilled') {
        allAssets.push(...cardanoAssets.value);
      } else {
        console.warn('Failed to fetch Cardano assets:', cardanoAssets.reason);
      }

      // Add CoinGecko assets if successful
      if (coinGeckoData.status === 'fulfilled') {
        allAssets.push(...coinGeckoData.value);
      } else {
        console.warn('Failed to fetch CoinGecko data:', coinGeckoData.reason);
      }

      // If both failed, throw an error
      if (cardanoAssets.status === 'rejected' && coinGeckoData.status === 'rejected') {
        throw new Error('Failed to fetch both Cardano and CoinGecko data');
      }

      setCryptoAssets(allAssets);
    } catch (err) {
      setError('Failed to fetch cryptocurrency data. Please check your API keys and internet connection.');
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