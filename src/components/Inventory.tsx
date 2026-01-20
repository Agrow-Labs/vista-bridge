import React from 'react';
import Panel from './Panel';
import { useWalletContext } from '../contexts/WalletContext';
import { formatNumberClean, formatPrice, formatPercentageChange } from '../utils/formatNumber';

interface InventoryProps {
  fromChain: string;
}

const Inventory: React.FC<InventoryProps> = ({ fromChain }) => {
  const { isConnected, assets, selectedAsset, setSelectedAsset } = useWalletContext();

  const selectAsset = (asset: any) => {
    // If clicking the same asset, deselect it
    if (selectedAsset && selectedAsset.symbol === asset.symbol) {
      setSelectedAsset(null);
    } else {
      setSelectedAsset(asset);
    }
  };

  const filteredAssets = assets?.filter(asset => {
    // If no fromChain is selected, show all assets
    if (!fromChain) return true;
    // Filter by chain if fromChain is provided
    return asset.chain && asset.chain.toLowerCase() === fromChain.toLowerCase();
  });


  return (
    <Panel className="w-full" title="Inventory">
      {!isConnected ? (
        <div className="text-center py-8">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <p className="text-lg font-medium text-white mb-2">Wallet Not Connected</p>
            <p className="text-gray-400">
              Please connect your wallet to view your inventory.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 justify-between">
          {(() => {
            return null;
          })()}
          {filteredAssets && filteredAssets.length > 0 ? (
            filteredAssets.map((asset, index) => {
              const isSelected = selectedAsset && selectedAsset.symbol === asset.symbol;
              return (
                <div 
                  key={index} 
                  className={`bg-[#141414] w-full rounded-lg p-4 cursor-pointer transition-all duration-200 hover:bg-[#1a1a1a] ${
                    isSelected ? 'ring-2 ring-blue-500 bg-[#1a1a1a]' : ''
                  }`}
                  onClick={() => selectAsset(asset)}
                >
                  <div className="flex items-center justify-center mb-3">
                    {asset.image ? (
                      <img 
                        src={asset.image} 
                        alt={asset.symbol}
                        className="w-10 h-10 rounded-full object-cover"
                        onError={(e) => {
                          // Fallback to emoji icon if image fails to load
                          const target = e.target as HTMLImageElement;
                          target.style.display = 'none';
                          const fallback = target.nextElementSibling as HTMLElement;
                          if (fallback) fallback.style.display = 'block';
                        }}
                      />
                    ) : null}
                    <div 
                      className={`text-2xl ${asset.image ? 'hidden' : 'block'}`}
                      style={{ display: asset.image ? 'none' : 'block' }}
                    >
                      {asset.icon}
                    </div>
                  </div>
                  <div className="crypto-symbol font-bold text-lg mb-1 text-center">{asset.symbol}</div>
                  <div className="crypto-amount text-xs text-gray-300 mb-1 text-center">
                    {asset.quantity ? formatNumberClean(asset.quantity, 2, asset.unit === 'lovelace') : null}
                  </div>
                  {asset.price && (
                    <div className="text-xs text-center mb-1">
                      <div className="text-white font-semibold">{formatPrice(asset.price)}</div>
                      {asset.priceChange24h !== undefined && (
                        <div className={`${asset.priceChange24h >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPercentageChange(asset.priceChange24h)}
                        </div>
                      )}
                    </div>
                  )}
                  {isSelected && (
                    <div className="flex justify-center mt-2">
                      <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="text-center py-8 col-span-full">
              <div className="text-gray-400 mb-4">
                <svg className="w-16 h-16 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <p className="text-lg font-medium text-white mb-2">No assets found</p>
              <p className="text-gray-400">
                No assets found for the selected chain.
              </p>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
};

export default Inventory;
