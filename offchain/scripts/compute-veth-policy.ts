// Pre-compute the vETH policyId and full asset unit from a Cardano destination
// wallet address (or seed phrase). The bridge's vETH native token policy is
// derived as: NativeScript { type: "sig", keyHash: paymentKeyHash(addr) }.
//
// Run: cd offchain && bun run scripts/compute-veth-policy.ts <ADDRESS_OR_SEED>
//      (no arg → reads from CARDANO_PREPROD_ADDRESS env var)
//
// Output:
//   policyId     <56 hex chars>
//   assetName    vETH
//   assetNameHex 76455448
//   unit         <policyId><assetNameHex>   ← paste into routes.eth-example.json
import {
  resolveNativeScriptHash,
  resolvePaymentKeyHash,
  MeshWallet,
} from "@meshsdk/core";

const ASSET_NAME = "vETH";
const ASSET_NAME_HEX = Buffer.from(ASSET_NAME, "utf8").toString("hex");

async function addrFromSeed(seed: string): Promise<string> {
  const wallet = new MeshWallet({
    networkId: 0,
    key: { type: "mnemonic", words: seed.trim().split(/\s+/) },
  });
  return await wallet.getChangeAddress();
}

const arg = process.argv[2] ?? process.env.CARDANO_PREPROD_ADDRESS;
if (!arg) {
  console.error("Usage: bun run scripts/compute-veth-policy.ts <CARDANO_ADDRESS_OR_24_WORD_SEED>");
  console.error("  Or set CARDANO_PREPROD_ADDRESS in env.");
  process.exit(1);
}

// Heuristic: addresses start with "addr"; anything else with >12 whitespace-separated words is a seed.
const looksLikeAddress = arg.startsWith("addr");
const address = looksLikeAddress ? arg : await addrFromSeed(arg);

const vkh = resolvePaymentKeyHash(address);
const policyId = resolveNativeScriptHash({
  type: "sig",
  keyHash: vkh,
});
const unit = `${policyId}${ASSET_NAME_HEX}`;

console.log(`address      ${address}`);
console.log(`paymentKeyHash  ${vkh}`);
console.log(`policyId     ${policyId}`);
console.log(`assetName    ${ASSET_NAME}`);
console.log(`assetNameHex ${ASSET_NAME_HEX}`);
console.log(`unit         ${unit}`);
console.log("");
console.log("Paste into both routes in offchain/config/routes.eth-example.json:");
console.log(`  "destinationUnit": "${unit}",   // on eth-sepolia-to-preprod`);
console.log(`  "sourceUnit":      "${unit}",   // on preprod-to-eth-sepolia`);
