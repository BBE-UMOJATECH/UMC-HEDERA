import { HederaWatcher } from "./hedera-watcher";
import { PolygonMinter } from "./polygon-minter";
import {
  RelayerConfig,
  BridgeBurnEvent,
  BridgeRequest,
  BridgeRequestStatus,
} from "./types";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * UMC Bridge Relayer
 *
 * Pipeline:
 *   1. Poll Hedera mirror node for BridgeBurn events
 *   2. Verify each burn on-chain
 *   3. Sign EIP-712 attestation
 *   4. Submit claimMint on Polygon
 *   5. Track status and retry failures
 */
class UMCBridgeRelayer {
  private config: RelayerConfig;
  private hederaWatcher: HederaWatcher;
  private polygonMinter: PolygonMinter;
  private pendingRequests: Map<string, BridgeRequest> = new Map();
  private processedNonces: Set<string> = new Set();
  private isRunning: boolean = false;

  constructor(config: RelayerConfig) {
    this.config = config;
    this.hederaWatcher = new HederaWatcher(config);
    this.polygonMinter = new PolygonMinter(config);
  }

  async start(): Promise<void> {
    console.log("=".repeat(60));
    console.log("  UMC Bridge Relayer");
    console.log("=".repeat(60));

    await this.hederaWatcher.initialize();
    await this.polygonMinter.initialize();

    this.isRunning = true;
    console.log("[Relayer] Listening for burns...\n");

    while (this.isRunning) {
      try {
        await this.processNewBurns();
        await this.retryFailedRequests();
      } catch (error) {
        console.error("[Relayer] Loop error:", error);
      }
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  stop(): void {
    console.log("[Relayer] Shutting down...");
    this.isRunning = false;
  }

  private async processNewBurns(): Promise<void> {
    const burns = await this.hederaWatcher.pollBurnEvents();

    for (const burn of burns) {
      const nonceKey = burn.nonce.toString();
      if (this.processedNonces.has(nonceKey)) continue;

      console.log(`\n[Relayer] Burn detected nonce=${nonceKey}`);
      console.log(`  From:  ${burn.hederaSender}`);
      console.log(`  To:    ${burn.polygonRecipient}`);
      console.log(`  Net:   ${this.formatUMC(burn.netAmount)} UMC`);

      await this.processBurn(burn);
    }
  }

  private async processBurn(burn: BridgeBurnEvent): Promise<void> {
    const nonceKey = burn.nonce.toString();

    const request: BridgeRequest = {
      nonce: burn.nonce,
      hederaSender: burn.hederaSender,
      polygonRecipient: burn.polygonRecipient,
      grossAmount: burn.amount,
      fee: burn.fee,
      netAmount: burn.netAmount,
      hederaTxId: burn.transactionId,
      status: BridgeRequestStatus.DETECTED,
      retries: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.pendingRequests.set(nonceKey, request);

    try {
      // 1. Verify burn on-chain
      const isValid = await this.hederaWatcher.verifyBurnRecord(burn.nonce);
      if (!isValid) throw new Error("Burn not verified on-chain");
      request.status = BridgeRequestStatus.CONFIRMED;

      // 2. Check if already claimed on Polygon
      const alreadyClaimed = await this.polygonMinter.isNonceClaimed(burn.nonce);
      if (alreadyClaimed) {
        console.log(`[Relayer] Nonce ${nonceKey} already claimed`);
        this.processedNonces.add(nonceKey);
        this.pendingRequests.delete(nonceKey);
        return;
      }

      // 3. Sign EIP-712 attestation
      const attestation = await this.polygonMinter.signAttestation(burn);
      request.attestation = attestation;
      request.status = BridgeRequestStatus.ATTESTATION_SIGNED;

      // 4. Submit mint on Polygon
      request.status = BridgeRequestStatus.MINT_SUBMITTED;
      const txHash = await this.polygonMinter.submitMint(attestation);

      if (txHash) {
        request.polygonTxHash = txHash;
        request.status = BridgeRequestStatus.MINT_CONFIRMED;
        console.log(`[Relayer] Bridge complete! Polygon tx: ${txHash}`);
      }

      this.processedNonces.add(nonceKey);
      this.pendingRequests.delete(nonceKey);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      request.error = errMsg;
      request.status = BridgeRequestStatus.FAILED;
      request.retries++;
      request.updatedAt = new Date();
      console.error(`[Relayer] Failed nonce ${nonceKey}: ${errMsg}`);
    }
  }

  private async retryFailedRequests(): Promise<void> {
    for (const [nonceKey, request] of this.pendingRequests) {
      if (
        request.status === BridgeRequestStatus.FAILED &&
        request.retries < this.config.maxRetries
      ) {
        console.log(
          `[Relayer] Retry nonce ${nonceKey} (${request.retries + 1}/${this.config.maxRetries})`
        );

        const burn: BridgeBurnEvent = {
          nonce: request.nonce,
          hederaSender: request.hederaSender,
          polygonRecipient: request.polygonRecipient,
          amount: request.grossAmount,
          fee: request.fee,
          netAmount: request.netAmount,
          timestamp: BigInt(Math.floor(request.createdAt.getTime() / 1000)),
          transactionId: request.hederaTxId,
        };

        await this.processBurn(burn);
        await this.sleep(this.config.retryDelayMs);
      }
    }
  }

  private formatUMC(amount: bigint): string {
    const whole = amount / 1_000_000n;
    const frac = (amount % 1_000_000n).toString().padStart(6, "0");
    return `${whole}.${frac}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

function loadConfig(): RelayerConfig {
  return {
    hederaOperatorId: process.env.HEDERA_OPERATOR_ID || "",
    hederaOperatorKey: process.env.HEDERA_OPERATOR_KEY || "",
    hederaNetwork: (process.env.HEDERA_NETWORK as "testnet" | "mainnet") || "testnet",
    hederaBridgeContractId: process.env.HEDERA_BRIDGE_CONTRACT_ID || "",
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonBridgeAddress: process.env.POLYGON_BRIDGE_ADDRESS || "",
    polygonRelayerPrivateKey: process.env.POLYGON_RELAYER_PRIVATE_KEY || "",
    polygonChainId: Number(process.env.POLYGON_CHAIN_ID) || 137,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 10_000,
    confirmationsRequired: Number(process.env.CONFIRMATIONS) || 1,
    maxRetries: Number(process.env.MAX_RETRIES) || 5,
    retryDelayMs: Number(process.env.RETRY_DELAY_MS) || 30_000,
    attestationTtlSeconds: Number(process.env.ATTESTATION_TTL) || 86_400,
    databaseUrl: process.env.DATABASE_URL || "",
  };
}

const config = loadConfig();
const relayer = new UMCBridgeRelayer(config);

process.on("SIGINT", () => relayer.stop());
process.on("SIGTERM", () => relayer.stop());

relayer.start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
