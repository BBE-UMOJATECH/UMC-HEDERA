"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HederaWatcher = void 0;
const sdk_1 = require("@hashgraph/sdk");
const ethers_1 = require("ethers");
const bignumber_js_1 = __importDefault(require("bignumber.js"));
/**
 * HederaWatcher polls the Hedera mirror node for new BridgeBurn events.
 *
 * Hedera doesn't support native event subscriptions like Ethereum,
 * so we query the mirror node REST API for contract logs.
 */
class HederaWatcher {
    constructor(config) {
        this.lastTimestamp = `${Math.floor(Date.now() / 1000)}.000000000`;
        this.bridgeContractEvmAddress = "";
        this.BRIDGE_BURN_TOPIC = ethers_1.ethers.id("BridgeBurn(uint256,address,address,uint256,uint256,uint256,uint256)");
        this.config = config;
        this.mirrorBaseUrl =
            config.hederaNetwork === "mainnet"
                ? "https://mainnet-public.mirrornode.hedera.com"
                : "https://testnet.mirrornode.hedera.com";
    }
    async initialize() {
        const contractId = sdk_1.ContractId.fromString(this.config.hederaBridgeContractId);
        this.bridgeContractEvmAddress = `0x${contractId.toEvmAddress()}`.toLowerCase();
        console.log(`[HederaWatcher] Watching: ${this.config.hederaBridgeContractId}`);
        console.log(`[HederaWatcher] EVM addr: ${this.bridgeContractEvmAddress}`);
    }
    /**
     * Poll for new BridgeBurn events since last check.
     */
    async pollBurnEvents() {
        try {
            const url = new URL(`/api/v1/contracts/${this.config.hederaBridgeContractId}/results/logs`, this.mirrorBaseUrl);
            const nowSeconds = Math.floor(Date.now() / 1000);
            url.searchParams.set("topic0", this.BRIDGE_BURN_TOPIC);
            url.searchParams.append("timestamp", `gt:${this.lastTimestamp}`);
            url.searchParams.append("timestamp", `lt:${nowSeconds}.999999999`);
            url.searchParams.set("order", "asc");
            url.searchParams.set("limit", "100");
            const response = await fetch(url.toString());
            if (!response.ok) {
                throw new Error(`Mirror node ${response.status}: ${await response.text()}`);
            }
            const data = (await response.json());
            if (!data.logs || data.logs.length === 0)
                return [];
            const events = [];
            for (const log of data.logs) {
                try {
                    const event = this.decodeBurnEvent(log);
                    events.push(event);
                    this.lastTimestamp = log.timestamp;
                }
                catch (err) {
                    console.error(`[HederaWatcher] Decode error:`, err);
                }
            }
            if (events.length > 0) {
                console.log(`[HederaWatcher] ${events.length} new burn(s) detected`);
            }
            return events;
        }
        catch (error) {
            console.error(`[HederaWatcher] Poll error:`, error);
            return [];
        }
    }
    decodeBurnEvent(log) {
        const nonce = BigInt(log.topics[1]);
        const hederaSender = ethers_1.ethers.getAddress("0x" + log.topics[2].slice(26));
        const polygonRecipient = ethers_1.ethers.getAddress("0x" + log.topics[3].slice(26));
        const abiCoder = ethers_1.ethers.AbiCoder.defaultAbiCoder();
        const decoded = abiCoder.decode(["uint256", "uint256", "uint256", "uint256"], log.data);
        return {
            nonce,
            hederaSender,
            polygonRecipient,
            amount: decoded[0],
            fee: decoded[1],
            netAmount: decoded[2],
            timestamp: decoded[3],
            transactionId: log.transaction_hash,
        };
    }
    /**
     * Verify a burn on-chain by querying the bridge contract directly.
     */
    async verifyBurnRecord(nonce) {
        try {
            const client = this.config.hederaNetwork === "mainnet"
                ? sdk_1.Client.forMainnet()
                : sdk_1.Client.forTestnet();
            client.setOperator(sdk_1.AccountId.fromString(this.config.hederaOperatorId), sdk_1.PrivateKey.fromStringDer(this.config.hederaOperatorKey));
            const query = new sdk_1.ContractCallQuery()
                .setContractId(this.config.hederaBridgeContractId)
                .setGas(100000)
                .setFunction("processedNonces", new sdk_1.ContractFunctionParameters().addUint256(new bignumber_js_1.default(nonce.toString())));
            const result = await query.execute(client);
            return result.getBool(0);
        }
        catch (error) {
            console.error(`[HederaWatcher] Verify failed nonce ${nonce}:`, error);
            return false;
        }
    }
}
exports.HederaWatcher = HederaWatcher;
