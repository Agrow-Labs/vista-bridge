import { Effect, Context, Layer } from "effect";
import dotenv from "dotenv";
import { BridgeConfig } from "./types.js";

// Load environment variables from .env file
dotenv.config();

// Define a Config Service using Context.Tag
export class Config extends Context.Tag("Config")<Config, BridgeConfig>() {}

// Helper function to parse comma-separated addresses
const parseAddressList = (envVar: string, defaultValue: string[]): string[] => {
  const value = process.env[envVar];
  if (!value) return defaultValue;
  return value.split(',').map(addr => addr.trim()).filter(addr => addr.length > 0);
};

// Helper function to get environment variable with default
const getEnv = (key: string, defaultValue: string): string => {
  return process.env[key] || defaultValue;
};

// Helper function to get integer environment variable with default
const getEnvInt = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

// Load configuration from environment variables as an Effect
export const loadConfigFromEnv = Effect.try({
  try: (): BridgeConfig => {
    const config: BridgeConfig = {
      networks: {
        source: {
          name: getEnv('SOURCE_NETWORK_NAME', 'preproduction'),
          utxorpcEndpoint: getEnv('SOURCE_UTXORPC_URL', 'https://preprod.utxorpc-v0.demeter.run'),
          lucidProvider: getEnv('SOURCE_LUCID_PROVIDER', 'https://cardano-preproduction.blockfrost.io/api/v0'),
          lucidNetwork: getEnv('SOURCE_LUCID_NETWORK', 'Preproduction'),
          depositAddresses: parseAddressList('SOURCE_DEPOSIT_ADDRESSES', [
            'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj0vs2qd4a6gtmvpt4ks2sggz'
          ]),
        },
        destination: {
          name: getEnv('DEST_NETWORK_NAME', 'preview'),
          utxorpcEndpoint: getEnv('DEST_UTXORPC_URL', 'https://preview.utxorpc-v0.demeter.run'),
          lucidProvider: getEnv('DEST_LUCID_PROVIDER', 'https://cardano-preview.blockfrost.io/api/v0'),
          lucidNetwork: getEnv('DEST_LUCID_NETWORK', 'Preview'),
          senderAddresses: parseAddressList('DEST_SENDER_ADDRESSES', [
            'addr_test1qpx4p5wdqvdpj9xndt0p0wgj5rz4qjk5zhj7lczv5lz6n3nju5d8ps7zex2k2xt3uqxgjqnnj0vs2qd4a6gtmvpt4ks6dz7fn'
          ]),
        },
      },
      bridge: {
        allowedAssets: parseAddressList('BRIDGE_ALLOWED_ASSETS', ['ADA']),
        minDepositAmount: getEnv('BRIDGE_MIN_DEPOSIT_AMOUNT', '2000000'),
        maxTransferAmount: getEnv('BRIDGE_MAX_TRANSFER_AMOUNT', '100000000000'),
        feeAmount: getEnv('BRIDGE_FEE_AMOUNT', '1000000'),
      },
      security: {
        requiredConfirmations: getEnvInt('SECURITY_REQUIRED_CONFIRMATIONS', 5),
        retryAttempts: getEnvInt('SECURITY_RETRY_ATTEMPTS', 3),
        retryDelayMs: getEnvInt('SECURITY_RETRY_DELAY_MS', 5000),
      },
      grpc: {
        indexerPort: getEnvInt('GRPC_INDEXER_PORT', 50051),
        relayerPort: getEnvInt('GRPC_RELAYER_PORT', 50052),
        mirrorPort: getEnvInt('GRPC_MIRROR_PORT', 50053),
      },
    };

    validateConfig(config);
    return config;
  },
  catch: (unknown) => new Error(`Configuration Error: ${unknown}`),
});

// Create a Layer that provides a live implementation of the Config service
export const ConfigLive = Layer.effect(Config, loadConfigFromEnv);

// Get UTXORPC headers for a specific network
export const getUtxorpcHeaders = (networkType: 'source' | 'destination'): Record<string, string> => {
  const headers: Record<string, string> = {};
  
  const apiKeyVar = networkType === 'source' ? 'SOURCE_UTXORPC_API_KEY' : 'DEST_UTXORPC_API_KEY';
  const apiKey = process.env[apiKeyVar];
  
  if (apiKey) {
    headers['dmtr-api-key'] = apiKey;
  }
  
  return headers;
};

// Configuration validation
export const validateConfig = (config: BridgeConfig): void => {
  // Validate addresses
  if (!config.networks.source.depositAddresses?.length) {
    throw new Error("Source network must have at least one deposit address");
  }

  if (!config.networks.destination.senderAddresses?.length) {
    throw new Error("Destination network must have at least one sender address");
  }

  // Validate amounts
  const minDeposit = BigInt(config.bridge.minDepositAmount);
  const maxTransfer = BigInt(config.bridge.maxTransferAmount);
  const fee = BigInt(config.bridge.feeAmount);

  if (minDeposit >= maxTransfer) {
    throw new Error("Minimum deposit amount must be less than maximum transfer amount");
  }

  if (fee >= minDeposit) {
    throw new Error("Fee amount must be less than minimum deposit amount");
  }

  // Validate ports
  const ports = [config.grpc.indexerPort, config.grpc.relayerPort, config.grpc.mirrorPort];
  const uniquePorts = new Set(ports);
  if (uniquePorts.size !== ports.length) {
    throw new Error("All gRPC ports must be unique");
  }

  // Validate UTXORPC endpoints
  if (!config.networks.source.utxorpcEndpoint.startsWith('http')) {
    throw new Error("Source UTXORPC endpoint must be a valid HTTP(S) URL");
  }

  if (!config.networks.destination.utxorpcEndpoint.startsWith('http')) {
    throw new Error("Destination UTXORPC endpoint must be a valid HTTP(S) URL");
  }
};

// Helper function to load config from file as an Effect
export const loadConfigFromFile = (filePath: string): Effect.Effect<BridgeConfig, Error> =>
  Effect.tryPromise({
    try: async () => {
      const fs = await import("node:fs");
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const config = JSON.parse(content) as BridgeConfig;
      validateConfig(config);
      return config;
    },
    catch: (unknown) => new Error(`Failed to load config from file: ${unknown}`),
  });

// Default configuration for testing (fallback)
export const defaultConfig: BridgeConfig = {
  networks: {
    source: {
      name: "preproduction",
      utxorpcEndpoint: "https://preprod.utxorpc-v0.demeter.run",
      lucidProvider: "https://cardano-preproduction.blockfrost.io/api/v0",
      lucidNetwork: "Preproduction",
      depositAddresses: [
        "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj0vs2qd4a6gtmvpt4ks6dz7fn"
      ],
    },
    destination: {
      name: "preview",
      utxorpcEndpoint: "https://preview.utxorpc-v0.demeter.run",
      lucidProvider: "https://cardano-preview.blockfrost.io/api/v0",
      lucidNetwork: "Preview",
      senderAddresses: [
        "addr_test1qpx4p5wdqvdpj9xndt0p0wgj5rz4qjk5zhj7lczv5lz6n3nju5d8ps7zex2k2xt3uqxgjqnnj0vs2qd4a6gtmvpt4ks2sggz"
      ],
    },
  },
  bridge: {
    allowedAssets: ["ADA"],
    minDepositAmount: "1000000", // 1 ADA
    maxTransferAmount: "100000000000", // 100,000 ADA  
    feeAmount: "1000000", // 1 ADA
  },
  security: {
    requiredConfirmations: 5,
    retryAttempts: 3,
    retryDelayMs: 5000,
  },
  grpc: {
    indexerPort: 50051,
    relayerPort: 50052,
    mirrorPort: 50053,
  },
}; 