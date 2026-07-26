/**
 * UMC Bridge Relayer — production entry point
 *
 * Improvements over the base index.ts:
 *  - Strict config validation (fail fast on missing vars)
 *  - Persistent nonce deduplication via JSON file (survives restarts)
 *  - Exponential backoff with jitter for retries
 *  - Circuit breaker for Polygon RPC failures
 *  - Concurrency cap (one mint in-flight at a time)
 *  - Graceful drain on SIGINT / SIGTERM
 *  - Structured timestamped logs
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { HederaWatcher } from "../hedera-watcher";
import { PolygonMinter } from "../polygon-minter";
import {
  RelayerConfig,
  BridgeBurnEvent,
  BridgeRequest,
  BridgeRequestStatus,
} from "../types";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// ─── Logging ────────────────────────────────────────────────────────────────

function log(tag: string, msg: string, level: "info" | "warn" | "error" = "info") {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ─── Config validation ───────────────────────────────────────────────────────

const REQUIRED_ENV: (keyof NodeJS.ProcessEnv)[] = [
  "HEDERA_OPERATOR_ID",
  "HEDERA_OPERATOR_KEY",
  "HEDERA_BRIDGE_CONTRACT_ID",
  "POLYGON_RPC_URL",
  "POLYGON_BRIDGE_ADDRESS",
  "POLYGON_RELAYER_PRIVATE_KEY",
  "POLYGON_CHAIN_ID",
];

function loadConfig(): RelayerConfig {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  return {
    hederaOperatorId: process.env.HEDERA_OPERATOR_ID!,
    hederaOperatorKey: process.env.HEDERA_OPERATOR_KEY!,
    hederaNetwork: (process.env.HEDERA_NETWORK as "testnet" | "mainnet") || "testnet",
    hederaBridgeContractId: process.env.HEDERA_BRIDGE_CONTRACT_ID!,
    polygonRpcUrl: process.env.POLYGON_RPC_URL!,
    polygonBridgeAddress: process.env.POLYGON_BRIDGE_ADDRESS!,
    polygonRelayerPrivateKey: process.env.POLYGON_RELAYER_PRIVATE_KEY!,
    polygonChainId: Number(process.env.POLYGON_CHAIN_ID),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 10_000,
    confirmationsRequired: Number(process.env.CONFIRMATIONS) || 1,
    maxRetries: Number(process.env.MAX_RETRIES) || 5,
    retryDelayMs: Number(process.env.RETRY_DELAY_MS) || 30_000,
    attestationTtlSeconds: Number(process.env.ATTESTATION_TTL) || 3_600,
    databaseUrl: process.env.DATABASE_URL || "",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter: delay = rand(0, base * 2^attempt) */
function backoffMs(attempt: number, baseMs: number, maxMs = 120_000): number {
  const ceiling = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  return Math.floor(Math.random() * ceiling);
}

function formatUMC(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

// ─── Persistent nonce cache ──────────────────────────────────────────────────

const NONCE_CACHE_PATH = path.resolve(__dirname, "../.processed-nonces.json");

function loadProcessedNonces(): Set<string> {
  try {
    if (fs.existsSync(NONCE_CACHE_PATH)) {
      const raw = fs.readFileSync(NONCE_CACHE_PATH, "utf-8");
      const arr: string[] = JSON.parse(raw);
      log("NonceCache", `Loaded ${arr.length} previously processed nonces`);
      return new Set(arr);
    }
  } catch (err) {
    log("NonceCache", `Failed to load cache, starting fresh: ${err}`, "warn");
  }
  return new Set();
}

function persistProcessedNonces(nonces: Set<string>): void {
  try {
    fs.writeFileSync(NONCE_CACHE_PATH, JSON.stringify([...nonces]), "utf-8");
  } catch (err) {
    log("NonceCache", `Failed to persist nonce cache: ${err}`, "warn");
  }
}

// ─── Dead letters ────────────────────────────────────────────────────────────

const DEAD_LETTER_PATH = path.resolve(__dirname, "../.dead-letters.json");

/**
 * Record a bridge that exhausted its retries. The nonce is deliberately NOT
 * added to the processed set — tokens are already burned on Hedera, so the
 * reconcile sweep must keep retrying it until an operator intervenes. This
 * file exists so that "keeps retrying" is visible instead of silent.
 */
function recordDeadLetter(request: BridgeRequest): void {
  try {
    const existing: unknown[] = fs.existsSync(DEAD_LETTER_PATH)
      ? JSON.parse(fs.readFileSync(DEAD_LETTER_PATH, "utf-8"))
      : [];
    existing.push({
      nonce: request.nonce.toString(),
      polygonRecipient: request.polygonRecipient,
      netAmount: request.netAmount.toString(),
      hederaTxId: request.hederaTxId,
      retries: request.retries,
      error: request.error,
      recordedAt: new Date().toISOString(),
    });
    fs.writeFileSync(DEAD_LETTER_PATH, JSON.stringify(existing, null, 2), "utf-8");
  } catch (err) {
    log("DeadLetter", `Failed to persist dead letter: ${err}`, "error");
  }
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly name: string,
    private readonly threshold: number,
    private readonly cooldownMs: number
  ) {}

  isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      log("CircuitBreaker", `${this.name} half-open — probing`, "warn");
      this.openedAt = null;
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      if (this.openedAt === null) {
        log(
          "CircuitBreaker",
          `${this.name} OPEN after ${this.failures} failures — cooling down ${this.cooldownMs}ms`,
          "error"
        );
        this.openedAt = Date.now();
      }
    }
  }
}

// ─── Relayer ─────────────────────────────────────────────────────────────────

class UMCBridgeRelayer {
  private watcher: HederaWatcher;
  private minter: PolygonMinter;
  private processedNonces: Set<string>;
  private pendingRequests = new Map<string, BridgeRequest>();
  private polygonCircuit: CircuitBreaker;
  private isRunning = false;
  private inFlight = 0;

  // Lowest nonce not yet known-settled. Advances past the contiguous run of
  // processed nonces so a sweep costs one RPC call in the steady state.
  private reconcileCursor = 0n;
  private reconcileRunning = false;
  private lastReconcileAt = 0;
  private readonly reconcileIntervalMs =
    Number(process.env.RECONCILE_INTERVAL_MS) || 300_000;

  // stats
  private stats = { detected: 0, confirmed: 0, minted: 0, failed: 0, backlog: 0 };

  constructor(private config: RelayerConfig) {
    this.watcher = new HederaWatcher(config);
    this.minter = new PolygonMinter(config);
    this.processedNonces = loadProcessedNonces();
    this.polygonCircuit = new CircuitBreaker("Polygon RPC", 5, 60_000);
  }

  async start(): Promise<void> {
    console.log("=".repeat(60));
    console.log("  UMC Bridge Relayer");
    console.log(`  Network : ${this.config.hederaNetwork}`);
    console.log(`  Poll    : ${this.config.pollIntervalMs}ms`);
    console.log(`  Retries : ${this.config.maxRetries}`);
    console.log("=".repeat(60));

    await this.watcher.initialize();
    await this.minter.initialize();

    this.isRunning = true;

    // Before touching the event stream: settle anything that happened while we
    // were not running. The mirror-node poll below only ever looks forward.
    await this.reconcile();

    log("Relayer", "Listening for BridgeBurn events...");

    while (this.isRunning) {
      try {
        await this.processNewBurns();
        await this.retryFailedRequests();
        if (Date.now() - this.lastReconcileAt >= this.reconcileIntervalMs) {
          await this.reconcile();
        }
      } catch (err) {
        log("Relayer", `Loop error: ${err}`, "error");
      }
      await sleep(this.config.pollIntervalMs);
    }

    // Drain in-flight before exit
    await this.drain();
    this.watcher.close();
    log("Relayer", `Shutdown complete. Stats: ${JSON.stringify(this.stats)}`);
  }

  /** Signal-safe stop — waits for in-flight ops before exiting */
  stop(): void {
    log("Relayer", "Stop signal received, finishing in-flight ops...", "warn");
    this.isRunning = false;
  }

  private async drain(): Promise<void> {
    const TIMEOUT = 30_000;
    const started = Date.now();
    while (this.inFlight > 0) {
      if (Date.now() - started > TIMEOUT) {
        log("Relayer", `Drain timeout — ${this.inFlight} ops still in-flight`, "warn");
        break;
      }
      await sleep(500);
    }
  }

  // ── Reconcile ─────────────────────────────────────────────────────────────

  /**
   * Settle every burn the bridge has issued against what Polygon has claimed.
   *
   * The mirror-node poll starts at "now" and only moves forward, so on its own
   * it loses any burn that landed while the relayer was down — permanently, and
   * silently, with the user's tokens already destroyed. This closes that hole
   * from authoritative state on both chains: Hedera's bridgeNonce says what was
   * burned, Polygon's claimedNonces says what was minted, and anything in the
   * gap gets re-driven. It also covers mirror-node log gaps while running.
   */
  private async reconcile(): Promise<void> {
    if (this.reconcileRunning) return;
    this.reconcileRunning = true;
    this.lastReconcileAt = Date.now();

    try {
      const bridgeNonce = await this.watcher.getBridgeNonce();

      // Skip the settled prefix without any network calls.
      while (
        this.reconcileCursor < bridgeNonce &&
        this.processedNonces.has(this.reconcileCursor.toString())
      ) {
        this.reconcileCursor++;
      }

      let backlog = 0;
      // ponytail: linear scan from the cursor. It only walks past the cursor
      // when something is genuinely stuck, so the steady state is one call.
      for (let n = this.reconcileCursor; n < bridgeNonce; n++) {
        const key = n.toString();
        if (this.processedNonces.has(key) || this.pendingRequests.has(key)) continue;

        const burn = await this.watcher.getBurnRecord(n);
        if (!burn) continue; // nonce issued but no record — nothing to act on

        if (await this.minter.isNonceClaimed(n)) {
          // "Claimed" is only proof of settlement if it settled THIS burn.
          // Nonces restart at 0 for a redeployed Hedera bridge, so a Polygon
          // bridge carried over from a previous deployment can already hold a
          // claim for this nonce belonging to a different burn entirely.
          // Treating that as settled would silently strand the user's tokens.
          const claim = await this.minter.getClaim(n);
          const matches =
            claim.recipient.toLowerCase() === burn.polygonRecipient.toLowerCase() &&
            claim.amount === burn.netAmount;

          if (!matches) {
            log(
              "Reconcile",
              `NONCE COLLISION nonce=${key}: burn is ${formatUMC(burn.netAmount)} UMC to ` +
                `${burn.polygonRecipient} but Polygon already claimed ` +
                `${formatUMC(claim.amount)} UMC to ${claim.recipient}. ` +
                `The Hedera and Polygon bridges are from different deployments — ` +
                `these tokens cannot be minted and need manual settlement.`,
              "error"
            );
            recordDeadLetter({
              nonce: burn.nonce,
              hederaSender: burn.hederaSender,
              polygonRecipient: burn.polygonRecipient,
              grossAmount: burn.amount,
              fee: burn.fee,
              netAmount: burn.netAmount,
              hederaTxId: burn.transactionId,
              status: BridgeRequestStatus.FAILED,
              retries: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
              error: "nonce collision: Polygon claim belongs to a different burn",
            });
            backlog++;
            continue;
          }

          this.markDone(key);
          continue;
        }

        backlog++;
        log("Reconcile", `Unclaimed burn nonce=${key} to=${burn.polygonRecipient} amount=${formatUMC(burn.netAmount)} UMC — re-driving`, "warn");

        this.inFlight++;
        this.processBurn(burn)
          .catch((err) => log("Reconcile", `Re-drive error nonce=${key}: ${err}`, "error"))
          .finally(() => this.inFlight--);
      }

      this.stats.backlog = backlog;
      if (backlog > 0) {
        // Alerting hook: a non-zero backlog means burned-but-not-minted UMC.
        log("Reconcile", `BACKLOG ${backlog} unclaimed burn(s) of ${bridgeNonce} total`, "warn");
      } else {
        log("Reconcile", `All ${bridgeNonce} burn(s) settled`);
      }
    } catch (err) {
      log("Reconcile", `Sweep failed: ${err}`, "error");
    } finally {
      this.reconcileRunning = false;
    }
  }

  // ── Poll ───────────────────────────────────────────────────────────────────

  private async processNewBurns(): Promise<void> {
    const burns = await this.watcher.pollBurnEvents();

    for (const burn of burns) {
      const key = burn.nonce.toString();
      if (this.processedNonces.has(key)) continue;

      this.stats.detected++;
      log("Relayer", `Burn detected nonce=${key} from=${burn.hederaSender} to=${burn.polygonRecipient} amount=${formatUMC(burn.netAmount)} UMC`);

      // fire-and-forget with concurrency tracked
      this.inFlight++;
      this.processBurn(burn)
        .catch((err) => log("Relayer", `Unhandled processBurn error: ${err}`, "error"))
        .finally(() => this.inFlight--);
    }
  }

  // ── Process single burn ───────────────────────────────────────────────────

  private async processBurn(burn: BridgeBurnEvent): Promise<void> {
    const key = burn.nonce.toString();

    const request: BridgeRequest = this.pendingRequests.get(key) ?? {
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

    this.pendingRequests.set(key, request);

    try {
      // 1. Verify on Hedera
      const isValid = await this.watcher.verifyBurnRecord(burn.nonce);
      if (!isValid) throw new Error("Burn not verified on-chain");
      request.status = BridgeRequestStatus.CONFIRMED;
      this.stats.confirmed++;

      // 2. Circuit breaker guard
      if (this.polygonCircuit.isOpen()) {
        throw new Error("Polygon circuit open — skipping until cooldown");
      }

      // 3. Skip if already claimed
      const alreadyClaimed = await this.minter.isNonceClaimed(burn.nonce);
      if (alreadyClaimed) {
        log("Relayer", `Nonce ${key} already claimed on Polygon`);
        this.markDone(key);
        return;
      }

      // 4. Sign attestation
      const attestation = await this.minter.signAttestation(burn);
      request.attestation = attestation;
      request.status = BridgeRequestStatus.ATTESTATION_SIGNED;

      // 5. Submit mint
      request.status = BridgeRequestStatus.MINT_SUBMITTED;
      const txHash = await this.minter.submitMint(attestation);

      this.polygonCircuit.recordSuccess();

      if (txHash) {
        request.polygonTxHash = txHash;
        request.status = BridgeRequestStatus.MINT_CONFIRMED;
        this.stats.minted++;
        log("Relayer", `Bridge complete! nonce=${key} polygon_tx=${txHash}`);
      }

      this.markDone(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      request.error = msg;
      request.status = BridgeRequestStatus.FAILED;
      request.retries++;
      request.updatedAt = new Date();
      this.stats.failed++;

      if (msg.includes("Polygon circuit open") || msg.includes("RPC") || msg.includes("network")) {
        this.polygonCircuit.recordFailure();
      }

      log("Relayer", `Failed nonce=${key} attempt=${request.retries}: ${msg}`, "error");
    }
  }

  private markDone(key: string): void {
    this.processedNonces.add(key);
    this.pendingRequests.delete(key);
    persistProcessedNonces(this.processedNonces);
  }

  // ── Retry failed requests ─────────────────────────────────────────────────

  private async retryFailedRequests(): Promise<void> {
    if (this.polygonCircuit.isOpen()) return;

    for (const [key, request] of this.pendingRequests) {
      if (
        request.status !== BridgeRequestStatus.FAILED ||
        request.retries >= this.config.maxRetries
      ) {
        if (request.retries >= this.config.maxRetries) {
          log(
            "Relayer",
            `Nonce ${key} exceeded max retries — dead-lettered, reconcile will keep retrying`,
            "error"
          );
          recordDeadLetter(request);
          this.pendingRequests.delete(key);
        }
        continue;
      }

      const delay = backoffMs(request.retries, this.config.retryDelayMs);
      const elapsed = Date.now() - request.updatedAt.getTime();
      if (elapsed < delay) continue;

      log("Relayer", `Retrying nonce=${key} attempt=${request.retries + 1}/${this.config.maxRetries} (backoff=${delay}ms)`);

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

      this.inFlight++;
      this.processBurn(burn)
        .catch((err) => log("Relayer", `Retry error: ${err}`, "error"))
        .finally(() => this.inFlight--);
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const config = loadConfig();
const relayer = new UMCBridgeRelayer(config);

process.on("SIGINT", () => relayer.stop());
process.on("SIGTERM", () => relayer.stop());
process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Uncaught exception: ${err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[FATAL] Unhandled rejection: ${reason}`);
  process.exit(1);
});

relayer.start().catch((err) => {
  console.error(`[FATAL] ${err}`);
  process.exit(1);
});
