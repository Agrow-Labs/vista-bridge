// Blockfrost API service for Cardano blockchain data
const BLOCKFROST_API_BASE = 'https://cardano-preprod.blockfrost.io/api/v0';

// You'll need to get a project_id from https://blockfrost.io
const PROJECT_ID = import.meta.env.VITE_BLOCKFROST_PROJECT_ID || '';

// Standard ADA icon URL (Cardano official icon)
export const ADA_ICON_URL = 'https://cryptologos.cc/logos/cardano-ada-logo.svg';

export interface BlockfrostAsset {
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

export interface BlockfrostAssetMetadata {
  name?: string;
  description?: string;
  ticker?: string;
  url?: string;
  logo?: string;
  decimals?: number;
}

export interface BlockfrostAssetInfo {
  unit: string;
  fingerprint: string;
  policy_id: string;
  asset_name: string;
  quantity: string;
  initial_mint_tx_hash: string;
  mint_or_burn_count: number;
  onchain_metadata?: any;
  metadata?: BlockfrostAssetMetadata;
}

// Helper function to convert IPFS URLs to HTTP URLs
export const convertIpfsToHttp = (ipfsUrl: string): string => {
  if (ipfsUrl.startsWith('ipfs://')) {
    const ipfsHash = ipfsUrl.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${ipfsHash}`;
  }
  return ipfsUrl;
};

// Helper function to make authenticated requests to Blockfrost
const fetchWithAuth = async (endpoint: string, options: RequestInit = {}): Promise<Response> => {
  if (!PROJECT_ID) {
    throw new Error('Blockfrost PROJECT_ID is required. Please set VITE_BLOCKFROST_PROJECT_ID in your environment variables.');
  }

  const response = await fetch(`${BLOCKFROST_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'project_id': PROJECT_ID,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error('Invalid Blockfrost project token. Please check your VITE_BLOCKFROST_PROJECT_ID.');
    }
    if (response.status === 402) {
      throw new Error('Blockfrost daily request limit exceeded.');
    }
    if (response.status === 429) {
      throw new Error('Blockfrost rate limit exceeded. Please try again later.');
    }
    throw new Error(`Blockfrost API error: ${response.status} ${response.statusText}`);
  }

  return response;
};

// Get asset information by unit (policy_id + asset_name)
export const getAssetInfo = async (unit: string): Promise<BlockfrostAssetInfo> => {
  try {
    const response = await fetchWithAuth(`/assets/${unit}`);
    return await response.json();
  } catch (error) {
    throw error;
  }
};

// Get asset metadata by unit
export const getAssetMetadata = async (unit: string): Promise<BlockfrostAssetMetadata> => {
  try {
    const response = await fetchWithAuth(`/assets/${unit}`);
    const assetInfo = await response.json();
    return assetInfo.metadata || {};
  } catch (error) {
    return {};
  }
};

// Get all assets (with pagination)
export const getAllAssets = async (): Promise<BlockfrostAsset[]> => {
  try {
    const response = await fetchWithAuth(`/assets`);
    return await response.json();
  } catch (error) {
    throw error;
  }
};

// Get top 9 Cardano assets by quantity (most popular)
export const getTopAssets = async (count: number = 9): Promise<BlockfrostAsset[]> => {
  try {
    // Fetch more assets to ensure we get a good selection
    const response = await fetchWithAuth(`/assets?page=1&count=100`);
    const assets = await response.json();
    
    // Sort by quantity (descending) and take the top N
    const sortedAssets = assets
      .filter((a: any) => a.asset) // Filter out assets without asset property
      .map((a: any) => ({ ...a, unit: a.asset })) // Map asset to unit for compatibility
      .sort((a: BlockfrostAsset, b: BlockfrostAsset) => {
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
export const getAssetDetails = async (unit: string): Promise<BlockfrostAssetInfo> => {
  try {
    // Validate unit format - should be a valid hex string
    if (!unit || typeof unit !== 'string' || !/^[0-9a-fA-F]+$/.test(unit)) {
      throw new Error(`Invalid asset unit format: ${unit}`);
    }
    
    const response = await fetchWithAuth(`/assets/${unit}`);
    const data = await response.json();
    return data;
  } catch (error) {
    throw error;
  }
};

// Get top 9 assets with their detailed information (name and logo)
export const getTopAssetsWithDetails = async (count: number = 9): Promise<BlockfrostAssetInfo[]> => {
  try {
    // First get the top assets
    const topAssets = await getTopAssets(count);
    
    // Then get detailed information for each asset using individual requests
    const detailedAssets: BlockfrostAssetInfo[] = [];
    
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
export const searchAssets = async (): Promise<BlockfrostAsset[]> => {
  try {
    // Blockfrost doesn't have a direct search endpoint, so we'll fetch all assets and filter
    const allAssets = await getAllAssets();
    return allAssets;
  } catch (error) {
    throw error;
  }
};

// Get specific assets by their units
export const getAssetsByUnits = async (units: string[]): Promise<BlockfrostAssetInfo[]> => {
  try {
    const promises = units.map(unit => getAssetInfo(unit));
    return await Promise.all(promises);
  } catch (error) {
    throw error;
  }
};

// Get specific assets by their addresses (same as units but with better naming)
export const getAssetsByAddresses = async (addresses: string[]): Promise<BlockfrostAssetInfo[]> => {
  try {
    const promises = addresses.map(address => getAssetDetails(address));
    return await Promise.all(promises);
  } catch (error) {
    throw error;
  }
};

// Helper function to convert Blockfrost asset to our CryptoAsset format
export const convertBlockfrostToCryptoAsset = (blockfrostAsset: BlockfrostAssetInfo, emojiIcon: string): {
  symbol: string;
  amount?: string;
  icon: string;
  image: string;
  chain: string;
  } => {
  const symbol = blockfrostAsset.metadata?.ticker || 
                blockfrostAsset.onchain_metadata?.symbol ||
                blockfrostAsset.metadata?.name ||
                blockfrostAsset.onchain_metadata?.name ||
                blockfrostAsset.asset_name || 
                blockfrostAsset.unit.slice(0, 8);
  // Handle base64 logo data - convert to data URL if it's base64
  let image = '';
  let imageSource = blockfrostAsset.metadata?.logo || blockfrostAsset.onchain_metadata?.image;
  
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
    amount: blockfrostAsset.quantity,
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
          // Handle Cardano (lovelace) - use standard ADA icon
          if (asset.unit === 'lovelace') {
            return {
              ...asset,
              image: ADA_ICON_URL,
              symbol: 'ADA',
              icon: '₳',
              chain: 'cardano'
            };
          }

          // Fetch asset metadata from Blockfrost
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
      image: asset.unit === 'lovelace' ? ADA_ICON_URL : '',
      symbol: asset.unit === 'lovelace' ? 'ADA' : asset.unit.slice(0, 8),
      icon: asset.unit === 'lovelace' ? '₳' : '🪙',
      chain: 'cardano'
    }));
  }
};
