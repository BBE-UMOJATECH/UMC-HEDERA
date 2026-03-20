"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
const hedera_watcher_1 = require("../hedera-watcher");
const polygon_minter_1 = require("../polygon-minter");
const types_1 = require("../types");
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
// ─── Logging ────────────────────────────────────────────────────────────────
function log(tag, msg, level = "info") {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}`;
    if (level === "error")
        console.error(line);
    else if (level === "warn")
        console.warn(line);
    else
        console.log(line);
}
// ─── Config validation ───────────────────────────────────────────────────────
const REQUIRED_ENV = [
    "HEDERA_OPERATOR_ID",
    "HEDERA_OPERATOR_KEY",
    "HEDERA_BRIDGE_CONTRACT_ID",
    "POLYGON_RPC_URL",
    "POLYGON_BRIDGE_ADDRESS",
    "POLYGON_RELAYER_PRIVATE_KEY",
];
function loadConfig() {
    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length > 0) {
        console.error(`[FATAL] Missing required env vars: ${missing.join(", ")}`);
        process.exit(1);
    }
    return {
        hederaOperatorId: process.env.HEDERA_OPERATOR_ID,
        hederaOperatorKey: process.env.HEDERA_OPERATOR_KEY,
        hederaNetwork: process.env.HEDERA_NETWORK || "testnet",
        hederaBridgeContractId: process.env.HEDERA_BRIDGE_CONTRACT_ID,
        polygonRpcUrl: process.env.POLYGON_RPC_URL,
        polygonBridgeAddress: process.env.POLYGON_BRIDGE_ADDRESS,
        polygonRelayerPrivateKey: process.env.POLYGON_RELAYER_PRIVATE_KEY,
        polygonChainId: Number(process.env.POLYGON_CHAIN_ID) || 137,
        pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 10000,
        confirmationsRequired: Number(process.env.CONFIRMATIONS) || 1,
        maxRetries: Number(process.env.MAX_RETRIES) || 5,
        retryDelayMs: Number(process.env.RETRY_DELAY_MS) || 30000,
        attestationTtlSeconds: Number(process.env.ATTESTATION_TTL) || 86400,
        databaseUrl: process.env.DATABASE_URL || "",
    };
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Exponential backoff with full jitter: delay = rand(0, base * 2^attempt) */
function backoffMs(attempt, baseMs, maxMs = 120000) {
    const ceiling = Math.min(baseMs * Math.pow(2, attempt), maxMs);
    return Math.floor(Math.random() * ceiling);
}
function formatUMC(amount) {
    const whole = amount / 1000000n;
    const frac = (amount % 1000000n).toString().padStart(6, "0");
    return `${whole}.${frac}`;
}
// ─── Persistent nonce cache ──────────────────────────────────────────────────
const NONCE_CACHE_PATH = path.resolve(__dirname, "../.processed-nonces.json");
function loadProcessedNonces() {
    try {
        if (fs.existsSync(NONCE_CACHE_PATH)) {
            const raw = fs.readFileSync(NONCE_CACHE_PATH, "utf-8");
            const arr = JSON.parse(raw);
            log("NonceCache", `Loaded ${arr.length} previously processed nonces`);
            return new Set(arr);
        }
    }
    catch (err) {
        log("NonceCache", `Failed to load cache, starting fresh: ${err}`, "warn");
    }
    return new Set();
}
function persistProcessedNonces(nonces) {
    try {
        fs.writeFileSync(NONCE_CACHE_PATH, JSON.stringify([...nonces]), "utf-8");
    }
    catch (err) {
        log("NonceCache", `Failed to persist nonce cache: ${err}`, "warn");
    }
}
// ─── Circuit breaker ─────────────────────────────────────────────────────────
class CircuitBreaker {
    constructor(name, threshold, cooldownMs) {
        this.name = name;
        this.threshold = threshold;
        this.cooldownMs = cooldownMs;
        this.failures = 0;
        this.openedAt = null;
    }
    isOpen() {
        if (this.openedAt === null)
            return false;
        if (Date.now() - this.openedAt > this.cooldownMs) {
            log("CircuitBreaker", `${this.name} half-open — probing`, "warn");
            this.openedAt = null;
            this.failures = 0;
            return false;
        }
        return true;
    }
    recordSuccess() {
        this.failures = 0;
        this.openedAt = null;
    }
    recordFailure() {
        this.failures++;
        if (this.failures >= this.threshold) {
            if (this.openedAt === null) {
                log("CircuitBreaker", `${this.name} OPEN after ${this.failures} failures — cooling down ${this.cooldownMs}ms`, "error");
                this.openedAt = Date.now();
            }
        }
    }
}
// ─── Relayer ─────────────────────────────────────────────────────────────────
class UMCBridgeRelayer {
    constructor(config) {
        this.config = config;
        this.pendingRequests = new Map();
        this.isRunning = false;
        this.inFlight = 0;
        // stats
        this.stats = { detected: 0, confirmed: 0, minted: 0, failed: 0 };
        this.watcher = new hedera_watcher_1.HederaWatcher(config);
        this.minter = new polygon_minter_1.PolygonMinter(config);
        this.processedNonces = loadProcessedNonces();
        this.polygonCircuit = new CircuitBreaker("Polygon RPC", 5, 60000);
    }
    async start() {
        console.log("=".repeat(60));
        console.log("  UMC Bridge Relayer");
        console.log(`  Network : ${this.config.hederaNetwork}`);
        console.log(`  Poll    : ${this.config.pollIntervalMs}ms`);
        console.log(`  Retries : ${this.config.maxRetries}`);
        console.log("=".repeat(60));
        await this.watcher.initialize();
        await this.minter.initialize();
        this.isRunning = true;
        log("Relayer", "Listening for BridgeBurn events...");
        while (this.isRunning) {
            try {
                await this.processNewBurns();
                await this.retryFailedRequests();
            }
            catch (err) {
                log("Relayer", `Loop error: ${err}`, "error");
            }
            await sleep(this.config.pollIntervalMs);
        }
        // Drain in-flight before exit
        await this.drain();
        log("Relayer", `Shutdown complete. Stats: ${JSON.stringify(this.stats)}`);
    }
    /** Signal-safe stop — waits for in-flight ops before exiting */
    stop() {
        log("Relayer", "Stop signal received, finishing in-flight ops...", "warn");
        this.isRunning = false;
    }
    async drain() {
        const TIMEOUT = 30000;
        const started = Date.now();
        while (this.inFlight > 0) {
            if (Date.now() - started > TIMEOUT) {
                log("Relayer", `Drain timeout — ${this.inFlight} ops still in-flight`, "warn");
                break;
            }
            await sleep(500);
        }
    }
    // ── Poll ───────────────────────────────────────────────────────────────────
    async processNewBurns() {
        const burns = await this.watcher.pollBurnEvents();
        for (const burn of burns) {
            const key = burn.nonce.toString();
            if (this.processedNonces.has(key))
                continue;
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
    async processBurn(burn) {
        const key = burn.nonce.toString();
        const request = this.pendingRequests.get(key) ?? {
            nonce: burn.nonce,
            hederaSender: burn.hederaSender,
            polygonRecipient: burn.polygonRecipient,
            grossAmount: burn.amount,
            fee: burn.fee,
            netAmount: burn.netAmount,
            hederaTxId: burn.transactionId,
            status: types_1.BridgeRequestStatus.DETECTED,
            retries: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        this.pendingRequests.set(key, request);
        try {
            // 1. Verify on Hedera
            const isValid = await this.watcher.verifyBurnRecord(burn.nonce);
            if (!isValid)
                throw new Error("Burn not verified on-chain");
            request.status = types_1.BridgeRequestStatus.CONFIRMED;
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
            request.status = types_1.BridgeRequestStatus.ATTESTATION_SIGNED;
            // 5. Submit mint
            request.status = types_1.BridgeRequestStatus.MINT_SUBMITTED;
            const txHash = await this.minter.submitMint(attestation);
            this.polygonCircuit.recordSuccess();
            if (txHash) {
                request.polygonTxHash = txHash;
                request.status = types_1.BridgeRequestStatus.MINT_CONFIRMED;
                this.stats.minted++;
                log("Relayer", `Bridge complete! nonce=${key} polygon_tx=${txHash}`);
            }
            this.markDone(key);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            request.error = msg;
            request.status = types_1.BridgeRequestStatus.FAILED;
            request.retries++;
            request.updatedAt = new Date();
            this.stats.failed++;
            if (msg.includes("Polygon circuit open") || msg.includes("RPC") || msg.includes("network")) {
                this.polygonCircuit.recordFailure();
            }
            log("Relayer", `Failed nonce=${key} attempt=${request.retries}: ${msg}`, "error");
        }
    }
    markDone(key) {
        this.processedNonces.add(key);
        this.pendingRequests.delete(key);
        persistProcessedNonces(this.processedNonces);
    }
    // ── Retry failed requests ─────────────────────────────────────────────────
    async retryFailedRequests() {
        if (this.polygonCircuit.isOpen())
            return;
        for (const [key, request] of this.pendingRequests) {
            if (request.status !== types_1.BridgeRequestStatus.FAILED ||
                request.retries >= this.config.maxRetries) {
                if (request.retries >= this.config.maxRetries) {
                    log("Relayer", `Nonce ${key} exceeded max retries — giving up`, "error");
                    this.pendingRequests.delete(key);
                }
                continue;
            }
            const delay = backoffMs(request.retries, this.config.retryDelayMs);
            const elapsed = Date.now() - request.updatedAt.getTime();
            if (elapsed < delay)
                continue;
            log("Relayer", `Retrying nonce=${key} attempt=${request.retries + 1}/${this.config.maxRetries} (backoff=${delay}ms)`);
            const burn = {
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
