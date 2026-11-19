/**
 * Live ETH (Sepolia) → Cardano (Preprod) bridge — driven through the UI.
 *
 * Hits the real running bridge (which talks to Alchemy Sepolia + Cardano Preprod
 * via UTXORPC), but the browser-side wallets are injected mocks:
 *   - window.ethereum  : EIP-1193 proxy → /api/test/evm/sendTransaction
 *                        (test user PK signs/sends, real Sepolia tx)
 *   - window.cardano.playwright : CIP-30 proxy → /api/test/wallet/*
 *                        (only used here to read the destination address)
 *
 * Records a video of the full run. Requires the offchain bridge to be running
 * with routes.json that includes the eth-sepolia-to-preprod route.
 */
import { test, expect } from "@playwright/test";
import * as path from "path";

const BACKEND_URL = "http://localhost:3001";
const INJECT_CARDANO = path.resolve(__dirname, "fixtures/inject-wallet.js");
const INJECT_EVM = path.resolve(__dirname, "fixtures/inject-evm-wallet.js");

async function apiGet(p: string): Promise<any> {
  const r = await fetch(`${BACKEND_URL}${p}`);
  return r.json();
}

test.use({
  video: "on",
  // Keep the trace too, so failure post-mortem is easier
  trace: "on",
  headless: false,
  // Pace each action so the recording is watchable in real time
  launchOptions: { slowMo: 350 },
  viewport: { width: 1400, height: 900 },
});

test.describe("ETH→Cardano bridge UI E2E (live testnets)", () => {
  test.beforeEach(async ({ page }) => {
    // Inject the CIP-30 Cardano test wallet AND the EIP-1193 EVM test wallet.
    await page.addInitScript({ path: INJECT_CARDANO });
    await page.addInitScript({ path: INJECT_EVM });
  });

  test("connects both wallets, deposits ETH on Sepolia, sees vETH mint CONFIRMED on Preprod", async ({ page }, testInfo) => {
    // Live bridge round-trip on real testnets: Sepolia confirmation + Preprod block + Koios indexing.
    test.setTimeout(8 * 60_000);

    // ── sanity: bridge has the eth route configured ───────────────
    const routesResp = await apiGet("/api/routes");
    const ethRoute = routesResp.routes.find((r: any) => r.id === "eth-sepolia-to-preprod");
    if (!ethRoute) {
      test.skip(true, "eth-sepolia-to-preprod route not configured in routes.json");
      return;
    }
    const cardanoDestAddr: string = (await apiGet("/api/test/wallet/address")).bech32;
    const evmAddr: string = (await apiGet("/api/test/evm/address")).address;
    console.log(`[UI test] evm: ${evmAddr}  cardano dest: ${cardanoDestAddr.slice(0, 24)}…`);

    // ── 1. Navigate to the bridge ─────────────────────────────────
    await page.goto("/app");
    await expect(page.locator("h2:has-text('Bridge Assets')")).toBeVisible({ timeout: 15_000 });
    // Give the routes API time to populate the dropdown options
    await page.waitForFunction(
      async () => {
        const r = await fetch("http://localhost:3001/api/routes").then((r) => r.json()).catch(() => null);
        return r?.routes?.length >= 4;
      },
      { timeout: 10_000 },
    );
    await page.waitForTimeout(800);
    await page.screenshot({ path: "test-results/eth-cardano-01-loaded.png", fullPage: true });
    console.log("[UI test] step 1 ✓ /app loaded");

    // ── 2. Set "From" = Ethereum Sepolia ──────────────────────────
    await page.getByTestId("network-dropdown-from-toggle").click();
    await page.waitForTimeout(300);
    await page.getByTestId("network-option-from-ethereum").click();
    await page.waitForTimeout(400);
    console.log("[UI test] step 2 ✓ From=Ethereum Sepolia");
    await page.screenshot({ path: "test-results/eth-cardano-02-from-eth.png", fullPage: true });

    // ── 3. Set "To" = Cardano Preprod ─────────────────────────────
    await page.getByTestId("network-dropdown-to-toggle").click();
    await page.waitForTimeout(300);
    await page.getByTestId("network-option-to-cardano").click();
    await page.waitForTimeout(400);
    console.log("[UI test] step 3 ✓ To=Cardano Preprod");
    await page.screenshot({ path: "test-results/eth-cardano-03-networks.png", fullPage: true });

    // ── 4. Connect sender (EVM) wallet ────────────────────────────
    await page.getByTestId("connect-source").click();
    await expect(page.locator("h3:has-text('Connect Wallet')")).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(400);
    await page.getByTestId("wallet-option-metamask").click();
    // The connected address appears in multiple places (header chip, inventory, sender row) — match any.
    await expect(page.locator(`text=${evmAddr.slice(0, 8)}`).first()).toBeVisible({ timeout: 10_000 });
    console.log("[UI test] step 4 ✓ EVM wallet connected");
    await page.screenshot({ path: "test-results/eth-cardano-04-evm-connected.png", fullPage: true });
    await page.waitForTimeout(400);

    // ── 5. Connect destination (Cardano) wallet via the new pill ──
    await page.getByTestId("connect-destination").click();
    await expect(page.locator("h3:has-text('Connect Wallet')")).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(400);
    await page.getByTestId("wallet-option-playwright").click();
    await expect(page.getByTestId("disconnect-destination")).toBeVisible({ timeout: 10_000 });
    console.log("[UI test] step 5 ✓ Cardano dest wallet connected");
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/eth-cardano-05-both-connected.png", fullPage: true });

    // ── 6. Enter amount — 0.001 ETH (above the route minDeposit) ──
    const amountInput = page
      .locator("input.text-white.text-\\[22px\\], input.text-white.text-\\[26px\\]")
      .first();
    await amountInput.click();
    await amountInput.fill("");
    await amountInput.type("0.001");
    await page.waitForTimeout(800);
    console.log("[UI test] step 6 ✓ amount entered");
    await page.screenshot({ path: "test-results/eth-cardano-06-form-filled.png", fullPage: true });

    // ── 7. Submit the bridge ──────────────────────────────────────
    // Capture the deposit tx hash from the success toast that fires after the
    // window.ethereum.eth_sendTransaction call returns.
    const txHashHandle = page.locator("text=/Deposit submitted! TX: 0x[a-fA-F0-9]+/");
    await page.getByTestId("bridge-cta").click();
    await expect(txHashHandle).toBeVisible({ timeout: 60_000 });
    const toastText = await txHashHandle.textContent();
    const txHashMatch = toastText?.match(/(0x[a-fA-F0-9]{8,})/);
    const txHashPrefix = txHashMatch?.[1];
    expect(txHashPrefix, "deposit tx hash should appear in toast").toBeTruthy();

    // The toast truncates the hash. Find the real one from the API's pending list.
    let depositTxHash = "";
    for (let i = 0; i < 30; i++) {
      const state = await apiGet("/api/state");
      const match = state.recentDeposits?.find(
        (d: any) =>
          d.senderAddress?.toLowerCase() === evmAddr.toLowerCase() &&
          d.depositTxHash?.toLowerCase().startsWith(txHashPrefix!.toLowerCase()),
      );
      if (match) {
        depositTxHash = match.depositTxHash;
        break;
      }
      await page.waitForTimeout(1_000);
    }
    expect(depositTxHash, "bridge API should know about the deposit").toBeTruthy();
    console.log(`[UI test] deposit on chain: ${depositTxHash}`);
    console.log(`[UI test] etherscan: https://sepolia.etherscan.io/tx/${depositTxHash}`);

    await page.screenshot({ path: "test-results/eth-cardano-04-submitted.png", fullPage: true });

    // ── 8. Scroll to the TransactionTracker so the video shows progress ─
    // The tracker renders below the BridgePanel once activeBridgeTx is set;
    // it shows step labels like "Waiting for Confirmations" → "Bridge Complete".
    const pendingLabel = page.locator("text=Waiting for Confirmations").first();
    await pendingLabel.waitFor({ state: "visible", timeout: 10_000 });
    await pendingLabel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.screenshot({ path: "test-results/eth-cardano-05-progress.png", fullPage: true });
    console.log("[UI test] step 8 ✓ tracker visible, scrolled into view");

    // ── 9. Wait for the on-page tracker to display "Bridge Complete" ─
    // It reads status from /api/deposit/:txHash via useDepositStatus,
    // so we don't need to poll the API ourselves — let the UI do it.
    const completeLabel = page.locator("text=Bridge Complete").first();
    await completeLabel.waitFor({ state: "visible", timeout: 5 * 60_000 });
    console.log("[UI test] step 9 ✓ tracker shows Bridge Complete");
    // Pause so the recording captures the final state legibly.
    await page.waitForTimeout(2_500);

    // ── 10. Read final state from the API for full hashes ─────────
    const final = await apiGet(`/api/deposit/${depositTxHash}`);
    const mirrorTxHash: string = final.mirrorTxHash;
    expect(final.status).toBe("CONFIRMED");
    expect(mirrorTxHash, "Cardano mirror tx hash").toBeTruthy();

    // Make sure the tracker (with mirror hash chip) is centered in the viewport
    // before the final screenshot — the chip uses a hash truncation.
    const mirrorChip = page.locator("text=/Mirror TX:.*0x|Mirror TX:.*[0-9a-f]/i").first();
    if (await mirrorChip.count()) {
      await mirrorChip.scrollIntoViewIfNeeded();
    }
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: "test-results/eth-cardano-06-confirmed.png", fullPage: true });

    // ── 11. Print full IDs in the run output ─────────────────────
    console.log("\n══════════════════════════════════════════════════════════════");
    console.log("✅ ETH→Cardano bridge round-trip via UI COMPLETE");
    console.log(`Sepolia deposit:   ${depositTxHash}`);
    console.log(`  https://sepolia.etherscan.io/tx/${depositTxHash}`);
    console.log(`Preprod mirror:    ${mirrorTxHash}`);
    console.log(`  https://preprod.cardanoscan.io/transaction/${mirrorTxHash}`);
    console.log("══════════════════════════════════════════════════════════════\n");

    testInfo.annotations.push({
      type: "result",
      description: `Sepolia deposit ${depositTxHash} → Preprod mint ${mirrorTxHash}`,
    });
  });
});
