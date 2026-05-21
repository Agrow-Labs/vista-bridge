import { describe, it, expect } from "vitest";
import { createIndexerForRoute, createMirrorForRoute } from "../../common/chain-factory.js";
import { mockBridgeRoute } from "../fixtures.js";
import { CardanoIndexer } from "../../cardano-indexer/index.js";
import { CardanoMirror } from "../../cardano-mirror/index.js";
import { EvmIndexer } from "../../evm-indexer/index.js";
import { EvmMirror } from "../../evm-mirror/index.js";
import { Effect } from "effect";

// Minimal mock relayer for factory tests
const mockRelayer = {
  publishDeposit: () => Effect.succeed({ success: true, messageId: "test" }),
  subscribeToDeposits: {} as any,
  updateMirrorStatus: () => Effect.succeed(true),
  getBridgeState: () => Effect.succeed({ processedDeposits: [], pendingMirrors: [], lastProcessedSlot: BigInt(0), lastProcessedBlockHash: "" }),
  getPendingDeposits: () => Effect.succeed([]),
};

describe("Chain Factory", () => {
  it("creates CardanoIndexer for cardano source", () => {
    const route = mockBridgeRoute({ id: "test-route" });
    const indexer = createIndexerForRoute(route, mockRelayer);

    expect(indexer).toBeInstanceOf(CardanoIndexer);
    expect(indexer.chainId).toBe("cardano-preprod");
  });

  it("creates CardanoMirror for cardano destination", () => {
    const route = mockBridgeRoute({ id: "test-route" });
    const mirror = createMirrorForRoute(route, mockRelayer);

    expect(mirror).toBeInstanceOf(CardanoMirror);
    expect(mirror.chainId).toBe("cardano-preview");
  });

  it("creates EvmIndexer for evm source", () => {
    const route = mockBridgeRoute({ id: "evm-route" });
    route.source = {
      chainId: "eth-sepolia",
      chainType: "evm",
      name: "sepolia",
      evmChainId: 11155111,
      addresses: ["0x0000000000000000000000000000000000000001"],
    };
    const indexer = createIndexerForRoute(route, mockRelayer);
    expect(indexer).toBeInstanceOf(EvmIndexer);
    expect(indexer.chainId).toBe("eth-sepolia");
  });

  it("creates EvmMirror for evm destination", () => {
    const route = mockBridgeRoute({ id: "evm-route" });
    route.destination = {
      chainId: "eth-sepolia",
      chainType: "evm",
      name: "sepolia",
      evmChainId: 11155111,
      addresses: ["0x0000000000000000000000000000000000000002"],
    };
    const mirror = createMirrorForRoute(route, mockRelayer);
    expect(mirror).toBeInstanceOf(EvmMirror);
    expect(mirror.chainId).toBe("eth-sepolia");
  });

  it("throws for unsupported source chain type", () => {
    const route = mockBridgeRoute();
    route.source.chainType = "solana" as any;

    expect(() => createIndexerForRoute(route, mockRelayer)).toThrow(
      "Unsupported source chain type: solana",
    );
  });

  it("throws for unsupported destination chain type", () => {
    const route = mockBridgeRoute();
    route.destination.chainType = "bitcoin" as any;

    expect(() => createMirrorForRoute(route, mockRelayer)).toThrow(
      "Unsupported destination chain type: bitcoin",
    );
  });

  it("passes route ID to indexer", () => {
    const route = mockBridgeRoute({ id: "custom-route-id" });
    const indexer = createIndexerForRoute(route, mockRelayer);
    // The indexer stores the route internally — chainId comes from route.source
    expect(indexer.chainId).toBe(route.source.chainId);
  });

  it("passes route ID to mirror", () => {
    const route = mockBridgeRoute({ id: "custom-route-id" });
    const mirror = createMirrorForRoute(route, mockRelayer);
    expect(mirror.chainId).toBe(route.destination.chainId);
  });
});
