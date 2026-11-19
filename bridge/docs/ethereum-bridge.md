# Ethereum (Sepolia) ↔ Cardano (Preprod) Bridge — Dev/Test Guide

This guide walks through running a Vista Bridge instance that bridges native ETH on **Sepolia** ↔ a wrapped `vETH` native token on **Cardano Preprod**, both directions.

## Asset Model

| Direction | Source asset | Destination asset | Mechanism |
|---|---|---|---|
| Sepolia → Preprod | ETH (native, wei) | `vETH` (Cardano native token) | **Mint** vETH 1:1 with wei deposited |
| Preprod → Sepolia | `vETH` (Cardano native token) | ETH (native, wei) | **Burn** vETH, release ETH from sender wallet |

1 wei of ETH maps to 1 unit of vETH on Cardano. vETH is a Cardano native token minted by a single-sig native script controlled by the destination wallet. The script's policyId is the hash of `ForgeScript.withOneSignature(destWalletAddr)` — fixed once you pick the destination wallet.

## 1. Install Dependencies

Already wired into `offchain/package.json`:

```bash
cd offchain
bun install   # picks up `ethers` v6
```

## 2. Generate Wallets

```bash
cd offchain
bun run generate-evm-wallet      # source-deposit + dest-sender for EVM side
bun run scripts/generate-bridge-wallets.ts   # source-deposit + dest-sender for Cardano side
```

Each command prints addresses and a private key / seed phrase. **Save these somewhere safe** (they are test wallets, but the destination-sender keys hold the bridge's float).

## 3. Get an RPC Endpoint

**Recommended primary:** [Alchemy](https://www.alchemy.com) free tier — sign up, create an app on Ethereum Sepolia, copy the HTTPS + WSS URLs. Free tier allows 30M compute units/month on Sepolia, fully supports `eth_subscribe`.

**Fallback (no signup):** `wss://ethereum-sepolia.publicnode.com` (public dRPC). Lower rate limits but works for low-volume testing.

The indexer prefers `wsEndpoint` (push subscriptions) and falls back to `rpcEndpoint` (HTTP polling).

## 4. Fund the Bridge Sender on Sepolia

The bridge needs ETH on its destination-side sender wallet to pay outbound mirrors for Preprod→Sepolia traffic. Send Sepolia ETH to the address printed by `generate-evm-wallet` (the "DESTINATION" address).

Faucets:

- **Google Cloud Web3 Faucet** — https://cloud.google.com/application/web3/faucet/ethereum/sepolia (Google account, no mainnet ETH required)
- **PoW Faucet (pk910)** — https://sepolia-faucet.pk910.de/ (browser proof-of-work, no auth, fastest fallback)
- **Alchemy** — https://www.alchemy.com/faucets/ethereum-sepolia (requires ≥0.001 ETH on mainnet)
- **QuickNode** — https://faucet.quicknode.com/ethereum/sepolia

Aim for ≥0.2 Sepolia ETH so the bridge can mirror several deposits before refilling.

You'll also need a personal EOA wallet (e.g. MetaMask) funded with a small amount of Sepolia ETH for end-to-end testing — you'll send ETH from it into the bridge.

## 5. Configure Routes

The repository ships an example config at `offchain/config/routes.eth-example.json`. Activate it:

```bash
# offchain/.env
BRIDGE_ROUTES_FILE=config/routes.eth-example.json
API_PORT=3001
```

Edit `routes.eth-example.json` and replace:

- `source.addresses[0]` on `eth-sepolia-to-preprod` — the EVM deposit address users send ETH to
- `destination.addresses[0]` on `eth-sepolia-to-preprod` — the Cardano Preprod address that signs the mint (and from whose vkh the vETH policyId derives)
- `source.addresses[0]` on `preprod-to-eth-sepolia` — the Cardano Preprod address users send vETH to
- `destination.addresses[0]` on `preprod-to-eth-sepolia` — the EVM sender address that holds Sepolia ETH for outbound mirrors

### Fill in env secrets

See the EVM section of `offchain/config/env.template`. Per-route convention: `ROUTE_<UPPER_SNAKE_ID>_<SOURCE|DEST>_<KEY>`.

Required for the ETH↔Cardano example:

```bash
# offchain/.env
ROUTE_ETH_SEPOLIA_TO_PREPROD_SOURCE_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
ROUTE_ETH_SEPOLIA_TO_PREPROD_SOURCE_WS_URL=wss://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
ROUTE_ETH_SEPOLIA_TO_PREPROD_DEST_API_KEY=your_demeter_preprod_key
ROUTE_ETH_SEPOLIA_TO_PREPROD_DEST_WALLET_SEED=word1 ... word24

ROUTE_PREPROD_TO_ETH_SEPOLIA_SOURCE_API_KEY=your_demeter_preprod_key
ROUTE_PREPROD_TO_ETH_SEPOLIA_SOURCE_WALLET_SEED=word1 ... word24
ROUTE_PREPROD_TO_ETH_SEPOLIA_DEST_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
ROUTE_PREPROD_TO_ETH_SEPOLIA_DEST_WS_URL=wss://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
ROUTE_PREPROD_TO_ETH_SEPOLIA_DEST_PRIVATE_KEY=0x...
```

## 6. Resolve the vETH Policy ID

The vETH token's policyId is determined by the destination wallet's verification-key hash. Compute it ahead of time:

```bash
cd offchain
bun run compute-veth-policy <destinationCardanoAddrOrSeed>
```

Output is the full `policyId + hex("vETH")` ready to paste into both `PLACEHOLDER_VETH_POLICY_ID_PLUS_HEX_NAME` entries in `routes.eth-example.json`.

## 7. Run the Bridge

```bash
cd offchain
bun run dev
```

You should see two routes spawn, an EvmIndexer subscribe to Sepolia, and an EvmMirror connect with your destination wallet.

Then in another terminal:

```bash
curl http://localhost:3001/api/routes | jq
curl http://localhost:3001/api/state | jq
```

## 8. End-to-End Test

**Sepolia → Preprod**:

1. From MetaMask (Sepolia), send ≥0.001 ETH to the EVM deposit address.
2. EvmIndexer waits `evmConfirmations` (default 3) blocks, then publishes the deposit.
3. CardanoMirror builds and submits a vETH mint tx to the depositor's Cardano address (you'll need to register your Cardano address as the `senderAddress` via the bridge UI or `POST /api/deposit/register`).

**Preprod → Sepolia**:

1. From a Cardano wallet (Nami/Eternl on Preprod), send vETH to the Preprod deposit address.
2. CardanoIndexer detects the deposit, publishes it.
3. EvmMirror sends Sepolia ETH (amount − fee) to the depositor's EVM address.
4. CardanoMirror burns the deposited vETH on Preprod (closing the circuit).

## Testing

The EVM backend has an integration test suite that runs against an in-process
Ganache node — no signup, no faucet, no system install:

```bash
cd offchain
bun run test src/tests/integration/evm-e2e.test.ts
```

Covers: deposit detection, address filtering, min-amount validation, mirror tx
build/sign/submit/confirm, fee deduction, and underfunded-signer error reporting.

## What's Implemented Now

- `chainType: "evm"` in `ChainConfig`
- `EvmIndexer` — WS or HTTP, scans blocks at `tip - evmConfirmations`, native ETH only
- `EvmMirror` — ethers Wallet, EIP-1559 gas with 25% headroom, pre-flight balance check, waits for receipt, sequential nonce ordering
- Per-route env-var overlay for RPC/WS URLs and private keys
- Factory dispatch for `"evm"` source and destination
- `bun run generate-evm-wallet` — random EOA + faucet links
- `bun run compute-veth-policy <addr>` — pre-compute the vETH Cardano native-token policyId
- Frontend MetaMask path in `BridgePanel.tsx`: connect, switch/add Sepolia, send ETH to deposit address, register recipient with backend
- ETH balance lookup in the wallet panel (via `eth_getBalance`)
- 5 end-to-end Ganache-backed tests for the indexer + mirror

## Deliberately Out of Scope

- **ERC-20 deposits.** Same pattern as ETH but listens on `eth_subscribe(logs, Transfer)`. Add when needed.
- **Solidity bridge contract for deposit accounting.** Plain EOA deposit/withdrawal addresses are fine for now — mirrors the Cardano-side model.
- **WalletConnect.** MetaMask + other window.ethereum wallets work; WalletConnect would require its SDK.
- **Reorg protection beyond `evmConfirmations`.** A deep Sepolia reorg past N blocks would double-mirror. Acceptable for a dev/test bridge.
