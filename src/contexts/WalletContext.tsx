import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useWallet, useWalletList } from '@meshsdk/react';
import { BrowserWallet } from '@meshsdk/core';
import { fetchAssetImages } from '../services/dolos';
import { useCryptoData } from '../hooks/useCryptoData';

interface WalletContextType {
  walletAddress: string | null;
  walletName: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  assets: any[] | null;
  isLoadingAssets: boolean;
  selectedAsset: any | null;
  setSelectedAsset: (asset: any | null) => void;
  connectWallet: (walletName: string) => Promise<void>;
  disconnectWallet: () => void;
  refreshAssets: () => Promise<void>;
  wallets: any[];
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

interface WalletProviderProps {
  children: ReactNode;
}

export const WalletProvider: React.FC<WalletProviderProps> = ({ children }) => {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [assets, setAssets] = useState<any[] | null>(null);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<any | null>(null);
  const wallets = useWalletList();
  const wallet = useWallet();
  const { cryptoAssets } = useCryptoData();

  // Function to save assets to localStorage
  const saveAssetsToStorage = (assetsData: any[], walletAddress: string) => {
    const assetsDataWithTimestamp = {
      assets: assetsData,
      timestamp: Date.now(),
      walletAddress: walletAddress
    };
    localStorage.setItem('walletAssets', JSON.stringify(assetsDataWithTimestamp));
  };

  // Function to load assets from localStorage
  const loadAssetsFromStorage = (walletAddress: string) => {
    try {
      const savedAssets = localStorage.getItem('walletAssets');
      if (savedAssets) {
        const parsedData = JSON.parse(savedAssets);
        // Check if the saved data is for the current wallet address
        if (parsedData.walletAddress === walletAddress) {
          // Check if data is less than 5 minutes old (300000 ms)
          const isDataFresh = Date.now() - parsedData.timestamp < 300000;
          if (isDataFresh) {
            setAssets(parsedData.assets);
            return true; // Data was loaded from cache
          } else {
            localStorage.removeItem('walletAssets');
          }
        }
      }
    } catch (error) {
      localStorage.removeItem('walletAssets');
    }
    return false; // Data was not loaded from cache
  };

  // Function to merge wallet assets with price data
  const mergeAssetsWithPriceData = (walletAssets: any[], priceData: any[]) => {
    return walletAssets.map(walletAsset => {
      // Find matching price data by symbol
      const priceInfo = priceData.find(priceAsset => {
        const walletSymbol = walletAsset.symbol?.toLowerCase();
        const priceSymbol = priceAsset.symbol?.toLowerCase();
        console.log(`Comparing symbols: wallet="${walletSymbol}" vs price="${priceSymbol}"`);
        
        // Handle special cases for symbol matching
        if (walletSymbol === 'cardano' && priceSymbol === 'cardano') {
          return true;
        }
        if (walletSymbol === 'bitcoin' && priceSymbol === 'bitcoin') {
          return true;
        }
        
        return walletSymbol === priceSymbol;
      });

      const mergedAsset = {
        ...walletAsset,
        price: priceInfo?.price,
        priceChange24h: priceInfo?.priceChange24h,
        marketCap: priceInfo?.marketCap,
        volume24h: priceInfo?.volume24h,
        // Use CoinGecko image for Cardano and Bitcoin if available
        image: priceInfo?.image || walletAsset.image,
        // Use CoinGecko icon for Cardano and Bitcoin if available
        icon: priceInfo?.icon || walletAsset.icon
      };
      
      return mergedAsset;
    });
  };

  // Function to fetch wallet assets
  const fetchAssets = async (walletInstance: any) => {
    try {
      setIsLoadingAssets(true);
      const walletAssets = await walletInstance.getBalance();
      
      // Fetch asset images and metadata from Dolos
      const assetsWithImages = await fetchAssetImages(walletAssets);
      
      // Merge with price data if available
      const assetsWithPrices = cryptoAssets.length > 0 
        ? mergeAssetsWithPriceData(assetsWithImages, cryptoAssets)
        : assetsWithImages;
      
      setAssets(assetsWithPrices);
      
      // Save to localStorage for persistence
      if (walletAddress) {
        saveAssetsToStorage(assetsWithPrices, walletAddress);
      }
    } catch (error) {
      setAssets(null);
    } finally {
      setIsLoadingAssets(false);
    }
  };

  // Load wallet state from localStorage on mount
  useEffect(() => {
    const savedWalletAddress = localStorage.getItem('walletAddress');
    const savedWalletName = localStorage.getItem('walletName');
    
    if (savedWalletAddress && savedWalletName) {
      setWalletAddress(savedWalletAddress);
      setWalletName(savedWalletName);
      
      // Try to load cached assets first
      const assetsLoadedFromCache = loadAssetsFromStorage(savedWalletAddress);
      
      // Attempt to reconnect to the wallet (but don't clear on failure)
      const attemptReconnection = async () => {
        try {
          if (savedWalletName) {
            await BrowserWallet.enable(savedWalletName);
            
            // If we didn't load from cache, fetch fresh data
            if (!assetsLoadedFromCache) {
              const walletInstance = await BrowserWallet.enable(savedWalletName);
              await fetchAssets(walletInstance);
            }
          }
        } catch (error) {
          // Don't clear stored data - let user manually disconnect if needed
        }
      };
      
      attemptReconnection();
    }
  }, []);

  // Update wallet state when wallet connection changes
  useEffect(() => {
    if (wallet.connected && wallet.address) {
      // Only update if we don't already have this address stored
      if (walletAddress !== wallet.address) {
        setWalletAddress(wallet.address);
        if (walletName) {
          localStorage.setItem('walletAddress', wallet.address);
          localStorage.setItem('walletName', walletName);
        }
      }
    }
  }, [wallet.connected, wallet.address, walletName, walletAddress]);

  // Update assets when crypto data changes
  useEffect(() => {
    if (assets && cryptoAssets.length > 0) {
      const updatedAssets = mergeAssetsWithPriceData(assets, cryptoAssets);
      setAssets(updatedAssets);
      
      // Update localStorage with new price data
      if (walletAddress) {
        saveAssetsToStorage(updatedAssets, walletAddress);
      }
    }
  }, [cryptoAssets]);

  // Listen for wallet disconnection events
  useEffect(() => {
    const handleWalletDisconnect = () => {
      // Only clear if user explicitly disconnects from wallet extension
      setWalletAddress(null);
      setWalletName(null);
      setAssets(null);
      localStorage.removeItem('walletAddress');
      localStorage.removeItem('walletName');
      localStorage.removeItem('walletAssets');
    };

    // Listen for storage changes (when wallet extension clears data)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'walletAddress' && e.newValue === null) {
        handleWalletDisconnect();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  const connectWallet = async (walletName: string) => {
    try {
      setIsConnecting(true);
      const walletInstance = await BrowserWallet.enable(walletName);
      const addresses = await walletInstance.walletInstance.getUsedAddresses();
      const address = addresses[0];
      
      if (address) {
        setWalletAddress(address);
        setWalletName(walletName);
        localStorage.setItem('walletAddress', address);
        localStorage.setItem('walletName', walletName);
        
        // Fetch assets after successful connection
        await fetchAssets(walletInstance);
      }
    } catch (error) {
      throw error;
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnectWallet = () => {
    setWalletAddress(null);
    setWalletName(null);
    setAssets(null);
    localStorage.removeItem('walletAddress');
    localStorage.removeItem('walletName');
    localStorage.removeItem('walletAssets');
    // Note: MeshSDK doesn't have a direct disconnect method
    // The wallet will be disconnected when the user disconnects in their wallet extension
  };

  const refreshAssets = async () => {
    if (wallet.connected && wallet.wallet) {
      await fetchAssets(wallet.wallet);
    }
  };

  const isConnected = walletAddress !== null;

  const value: WalletContextType = {
    walletAddress,
    walletName,
    isConnected,
    isConnecting,
    assets,
    isLoadingAssets,
    selectedAsset,
    setSelectedAsset,
    connectWallet,
    disconnectWallet,
    refreshAssets,
    wallets
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
};

export const useWalletContext = (): WalletContextType => {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWalletContext must be used within a WalletProvider');
  }
  return context;
};
