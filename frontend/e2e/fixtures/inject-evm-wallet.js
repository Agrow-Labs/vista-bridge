/**
 * EIP-1193 mock EVM wallet for Playwright E2E tests.
 * Injected via page.addInitScript() before page loads.
 * Delegates account access, signing and broadcasting to the backend
 * /api/test/evm/* endpoints, which hold the real test user private key.
 */
(function () {
  const BACKEND_URL = "http://localhost:3001";
  const SEPOLIA_HEX = "0xaa36a7";

  let _address = null;
  let _chainId = SEPOLIA_HEX;

  async function getAddress() {
    if (_address) return _address;
    const resp = await fetch(BACKEND_URL + "/api/test/evm/address");
    const data = await resp.json();
    _address = data.address;
    _chainId = data.chainIdHex || SEPOLIA_HEX;
    return _address;
  }

  // Simple event emitter so any code calling provider.on('chainChanged', ...) won't blow up.
  const listeners = {};
  function on(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
  }
  function off(event, cb) {
    const arr = listeners[event];
    if (!arr) return;
    listeners[event] = arr.filter((fn) => fn !== cb);
  }
  function emit(event, payload) {
    (listeners[event] || []).slice().forEach((fn) => {
      try { fn(payload); } catch (e) { /* swallow */ }
    });
  }

  async function handle(method, params) {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts": {
        const a = await getAddress();
        return [a];
      }
      case "eth_chainId":
        // Make sure we've resolved the address (and thus chainId) at least once.
        await getAddress();
        return _chainId;

      case "net_version": {
        await getAddress();
        return String(parseInt(_chainId, 16));
      }

      case "wallet_switchEthereumChain":
        // No-op: backend signer is always on Sepolia.
        return null;

      case "wallet_addEthereumChain":
        return null;

      case "eth_getBalance": {
        const r = await fetch(BACKEND_URL + "/api/test/evm/balance");
        const data = await r.json();
        return data.weiHex || ("0x" + BigInt(data.wei).toString(16));
      }

      case "eth_sendTransaction": {
        const tx = (params && params[0]) || {};
        const r = await fetch(BACKEND_URL + "/api/test/evm/sendTransaction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: tx.to,
            value: tx.value || "0x0",
            data: tx.data,
          }),
        });
        const data = await r.json();
        if (!r.ok || data.error) {
          throw new Error("Send failed: " + (data.error || r.status));
        }
        return data.txHash;
      }

      case "eth_blockNumber":
      case "eth_gasPrice":
      case "eth_estimateGas":
      case "eth_getTransactionByHash":
      case "eth_getTransactionReceipt":
      case "eth_call":
      case "eth_feeHistory":
      case "eth_maxPriorityFeePerGas":
      case "eth_getBlockByNumber":
      case "eth_getCode":
      case "eth_getTransactionCount":
        // Proxy generic reads straight to the public Sepolia RPC via a backend
        // pass-through would be cleaner; for the UI test we don't need any of
        // these — the frontend only calls eth_requestAccounts, eth_chainId,
        // wallet_switchEthereumChain and eth_sendTransaction.
        throw new Error("Method " + method + " not implemented in test wallet");

      default:
        throw new Error("Unsupported method: " + method);
    }
  }

  const provider = {
    isMetaMask: true, // some dApps gate by this flag — keep them happy
    isTestWallet: true,
    request: async function (args) {
      const method = args && args.method;
      const params = (args && args.params) || [];
      return await handle(method, params);
    },
    on,
    off,
    removeListener: off,
    // Legacy callback-style sendAsync, in case any old code uses it
    sendAsync: function (payload, callback) {
      Promise.resolve(handle(payload.method, payload.params || []))
        .then((result) => callback(null, { id: payload.id, jsonrpc: "2.0", result }))
        .catch((err) => callback(err));
    },
  };

  Object.defineProperty(window, "ethereum", {
    value: provider,
    writable: true,
    configurable: true,
  });

  // Resolve the address eagerly so handlers that touch _chainId don't race.
  getAddress().catch(() => {});

  console.log("[Playwright] EIP-1193 test EVM wallet injected (window.ethereum)");
})();
