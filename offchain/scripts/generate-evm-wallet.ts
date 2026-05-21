// Generate a fresh EVM wallet for bridge dev/test.
// Run: cd offchain && bun run scripts/generate-evm-wallet.ts
import { Wallet, HDNodeWallet } from "ethers";

console.log("=== Generating EVM Bridge Wallets ===\n");

// Source-side wallet: this is the address users send ETH to (the bridge "deposit address").
// On ETH→Cardano routes, only the address is used by the indexer; the private key
// is NOT needed because we never spend from this address.
const depositWallet: HDNodeWallet = Wallet.createRandom();

console.log("--- SOURCE (Sepolia) — Bridge Deposit Address ---");
console.log("Address:    ", depositWallet.address);
console.log("Mnemonic:   ", depositWallet.mnemonic?.phrase);
console.log("PrivateKey: ", depositWallet.privateKey);
console.log("");

// Destination-side wallet: this is the bridge's sender on the EVM destination chain
// (used for Cardano→ETH routes). Its private key signs outbound mirror txs and
// MUST be funded with testnet ETH from a faucet.
const senderWallet: HDNodeWallet = Wallet.createRandom();

console.log("--- DESTINATION (Sepolia) — Bridge Sender (signer) ---");
console.log("Address:    ", senderWallet.address);
console.log("Mnemonic:   ", senderWallet.mnemonic?.phrase);
console.log("PrivateKey: ", senderWallet.privateKey);
console.log("");

console.log("=== Faucets — fund the SENDER address (and a personal wallet for end-to-end testing) ===");
console.log("  • Google Cloud:  https://cloud.google.com/application/web3/faucet/ethereum/sepolia");
console.log("  • Alchemy:       https://www.alchemy.com/faucets/ethereum-sepolia   (needs ≥0.001 ETH on mainnet)");
console.log("  • QuickNode:     https://faucet.quicknode.com/ethereum/sepolia");
console.log("  • PoW Faucet:    https://sepolia-faucet.pk910.de/                   (no auth, browser PoW)");
console.log("");

console.log("=== Paste into offchain/.env (replace ROUTE_ID with your route's id, e.g. ETH_SEPOLIA_TO_PREPROD) ===");
console.log(`# Source side (ETH Sepolia → Cardano)`);
console.log(`#   Configure the deposit address in offchain/config/routes.json:`);
console.log(`#   "source.addresses": ["${depositWallet.address}"]`);
console.log("");
console.log(`# Destination side (Cardano → ETH Sepolia)`);
console.log(`#   Sender (signer) for outbound mirror txs:`);
console.log(`ROUTE_PREPROD_TO_ETH_SEPOLIA_DEST_PRIVATE_KEY=${senderWallet.privateKey}`);
console.log(`#   "destination.addresses": ["${senderWallet.address}"]`);
