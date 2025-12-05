// Dolos API service for Cardano blockchain data
// Dolos provides a Mini Blockfrost-compatible HTTP API
// Configure your Dolos instance URL via VITE_DOLOS_API_URL environment variable
// Default: http://localhost:3000 (local Dolos instance)
const DOLOS_API_BASE = import.meta.env.VITE_DOLOS_API_URL || 'http://localhost:3000';

// Note: Dolos Mini Blockfrost API doesn't require authentication like Blockfrost
// If your Dolos instance requires authentication, you can add it here

export interface DolosAsset {
  unit: string;
  quantity: string;
  fingerprint: string;
  policy_id: string;
  asset_name: string;
  name?: string;
  description?: string;
  ticker?: string;
  url?: string;
  logo?: string;
  decimals?: number;
}

export interface DolosAssetMetadata {
  name?: string;
  description?: string;
  ticker?: string;
  url?: string;
  logo?: string;
  decimals?: number;
}

export interface DolosAssetInfo {
  unit: string;
  fingerprint: string;
  policy_id: string;
  asset_name: string;
  quantity: string;
  initial_mint_tx_hash: string;
  mint_or_burn_count: number;
  onchain_metadata?: any;
  metadata?: DolosAssetMetadata;
}

// Helper function to convert IPFS URLs to HTTP URLs
export const convertIpfsToHttp = (ipfsUrl: string): string => {
  if (ipfsUrl.startsWith('ipfs://')) {
    const ipfsHash = ipfsUrl.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${ipfsHash}`;
  }
  return ipfsUrl;
};

// Helper function to make requests to Dolos Mini Blockfrost API
const fetchDolos = async (endpoint: string, options: RequestInit = {}): Promise<Response> => {
  const response = await fetch(`${DOLOS_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Dolos API endpoint not found. Please check your VITE_DOLOS_API_URL configuration.');
    }
    if (response.status === 500) {
      throw new Error('Dolos server error. Please check your Dolos instance is running.');
    }
    if (response.status === 503) {
      throw new Error('Dolos service unavailable. The node may still be syncing.');
    }
    throw new Error(`Dolos API error: ${response.status} ${response.statusText}`);
  }

  return response;
};

// Get asset information by unit (policy_id + asset_name)
export const getAssetInfo = async (unit: string): Promise<DolosAssetInfo> => {
  try {
    const response = await fetchDolos(`/assets/${unit}`);
    return await response.json();
  } catch (error) {
    throw error;
  }
};

// Get asset metadata by unit
export const getAssetMetadata = async (unit: string): Promise<DolosAssetMetadata> => {
  try {
    const response = await fetchDolos(`/assets/${unit}`);
    const assetInfo = await response.json();
    return assetInfo.metadata || {};
  } catch (error) {
    return {};
  }
};

// Get all assets (with pagination)
export const getAllAssets = async (): Promise<DolosAsset[]> => {
  try {
    const response = await fetchDolos(`/assets`);
    return await response.json();
  } catch (error) {
    throw error;
  }
};

// Get top 9 Cardano assets by quantity (most popular)
export const getTopAssets = async (count: number = 9): Promise<DolosAsset[]> => {
  try {
    // Fetch more assets to ensure we get a good selection
    const response = await fetchDolos(`/assets?page=1&count=100`);
    const assets = await response.json();
    // Sort by quantity (descending) and take the top N
    const sortedAssets = assets
      .filter((a: any) => a.asset) // Filter out assets without asset property
      .map((a: any) => ({ ...a, unit: a.asset })) // Map asset to unit for compatibility
      .sort((a: DolosAsset, b: DolosAsset) => {
        const quantityA = BigInt(a.quantity || '0');
        const quantityB = BigInt(b.quantity || '0');
        return quantityA > quantityB ? -1 : quantityA < quantityB ? 1 : 0;
      })
      .slice(0, count);
    
    return sortedAssets;
  } catch (error) {
    throw error;
  }
};

// Get detailed asset information including name and logo
export const getAssetDetails = async (unit: string): Promise<DolosAssetInfo> => {
  try {
    // Validate unit format - should be a valid hex string
    if (!unit || typeof unit !== 'string' || !/^[0-9a-fA-F]+$/.test(unit)) {
      throw new Error(`Invalid asset unit format: ${unit}`);
    }
    
    const response = await fetchDolos(`/assets/${unit}`);
    const data = await response.json();
    return data;
  } catch (error) {
    throw error;
  }
};

// Get top 9 assets with their detailed information (name and logo)
export const getTopAssetsWithDetails = async (count: number = 9): Promise<DolosAssetInfo[]> => {
  try {
    // First get the top assets
    const topAssets = await getTopAssets(count);
    
    // Then get detailed information for each asset using individual requests
    const detailedAssets: DolosAssetInfo[] = [];
    
    for (const asset of topAssets) {
      try {
        // Make individual request to /assets/{asset} endpoint for each asset
        const details = await getAssetDetails(asset.unit);
        detailedAssets.push(details);
      } catch (error) {
        // Skip this asset and continue with the next one
        continue;
      }
    }
    
    return detailedAssets;
  } catch (error) {
    throw error;
  }
};

// Search for assets by name or ticker
export const searchAssets = async (): Promise<DolosAsset[]> => {
  try {
    // Dolos Mini Blockfrost API doesn't have a direct search endpoint, so we'll fetch all assets and filter
    const allAssets = await getAllAssets();
    return allAssets;
  } catch (error) {
    throw error;
  }
};

// Get specific assets by their units
export const getAssetsByUnits = async (units: string[]): Promise<DolosAssetInfo[]> => {
  try {
    const promises = units.map(unit => getAssetInfo(unit));
    return await Promise.all(promises);
  } catch (error) {
    throw error;
  }
};

// Get specific assets by their addresses (same as units but with better naming)
export const getAssetsByAddresses = async (addresses: string[]): Promise<DolosAssetInfo[]> => {
  try {
    const promises = addresses.map(address => getAssetDetails(address));
    return await Promise.all(promises);
  } catch (error) {
    throw error;
  }
};

// Helper function to convert Dolos asset to our CryptoAsset format
export const convertDolosToCryptoAsset = (dolosAsset: DolosAssetInfo, emojiIcon: string): {
  symbol: string;
  amount?: string;
  icon: string;
  image: string;
  chain: string;
  } => {
  const symbol = dolosAsset.metadata?.ticker || 
                dolosAsset.onchain_metadata?.symbol ||
                dolosAsset.metadata?.name ||
                dolosAsset.onchain_metadata?.name ||
                dolosAsset.asset_name || 
                dolosAsset.unit.slice(0, 8);
  // Handle base64 logo data - convert to data URL if it's base64
  let image = '';
  let imageSource = dolosAsset.metadata?.logo || dolosAsset.onchain_metadata?.image;
  
  if (imageSource) {
    // Check if it's base64 data (starts with data: or is a long base64 string)
    if (imageSource.startsWith('data:')) {
      image = imageSource;
    } else if (imageSource.startsWith('ipfs://')) {
      // Convert IPFS URL to HTTP URL using a public gateway
      image = convertIpfsToHttp(imageSource);
    } else if (imageSource.length > 100 && /^[A-Za-z0-9+/=]+$/.test(imageSource)) {
      // It's likely base64 data, create a data URL
      image = `data:image/png;base64,${imageSource}`;
    } else {
      // It's a regular URL
      image = imageSource;
    }
  }
  
  return {
    symbol,
    amount: dolosAsset.quantity,
    icon: emojiIcon,
    image: image,
    chain: 'cardano',
  };
};

// Function to fetch asset images for wallet assets
export const fetchAssetImages = async (walletAssets: any[]): Promise<any[]> => {
  try {
    const assetsWithImages = await Promise.all(
      walletAssets.map(async (asset) => {
        try {
          // Skip Cardano (lovelace) as it doesn't have metadata
          if (asset.unit === 'lovelace') {
            return {
              ...asset,
              image: '', // Cardano doesn't have an image
              symbol: 'ADA',
              icon: '₳',
              chain: 'cardano'
            };
          }

          // Fetch asset metadata from Dolos
          const assetInfo = await getAssetDetails(asset.unit);
          // Extract image from metadata
          let image = '';
          let imageSource = assetInfo.metadata?.logo || assetInfo.onchain_metadata?.image;
          
          if (imageSource) {
            // Check if it's base64 data (starts with data: or is a long base64 string)
            if (imageSource.startsWith('data:')) {
              image = imageSource;
            } else if (imageSource.startsWith('ipfs://')) {
              // Convert IPFS URL to HTTP URL using a public gateway
              image = convertIpfsToHttp(imageSource);
            } else if (imageSource.length > 100 && /^[A-Za-z0-9+/=]+$/.test(imageSource)) {
              // It's likely base64 data, create a data URL
              image = `data:image/png;base64,${imageSource}`;
            } else {
              // It's a regular URL
              image = imageSource;
            }
          }

          // Get symbol from metadata or use asset name
          const symbol = assetInfo.metadata?.ticker || 
                        assetInfo.onchain_metadata?.symbol ||
                        assetInfo.metadata?.name || 
                        assetInfo.onchain_metadata?.name ||
                        assetInfo.asset_name || 
                        asset.unit.slice(0, 8);

          return {
            ...asset,
            image,
            symbol,
            icon: '🪙', // Default emoji icon as fallback
            chain: 'cardano'
          };
        } catch (error) {
          // Return asset with fallback data
          return {
            ...asset,
            image: '',
            symbol: asset.unit.slice(0, 8),
            icon: '🪙',
            chain: 'cardano'
          };
        }
      })
    );

    return assetsWithImages;
  } catch (error) {
    // Return original assets with fallback data
    return walletAssets.map(asset => ({
      ...asset,
      image: '',
      symbol: asset.unit === 'lovelace' ? 'Cardano' : asset.unit.slice(0, 8),
      icon: asset.unit === 'lovelace' ? '₳' : '🪙',
      chain: 'cardano'
    }));
  }
};

// Export types with Blockfrost names for backward compatibility
export type BlockfrostAsset = DolosAsset;
export type BlockfrostAssetMetadata = DolosAssetMetadata;
export type BlockfrostAssetInfo = DolosAssetInfo;
export const convertBlockfrostToCryptoAsset = convertDolosToCryptoAsset;

