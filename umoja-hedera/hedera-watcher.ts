import {
  Client,
  ContractCallQuery,
  ContractId,
  AccountId,
  PrivateKey,
  ContractFunctionParameters,
} from "@hashgraph/sdk";
import { ethers } from "ethers";
import BigNumber from "bignumber.js";
import { BridgeBurnEvent, RelayerConfig } from "./types";

/**
 * HederaWatcher polls the Hedera mirror node for new BridgeBurn events.
 *
 * Hedera doesn't support native event subscriptions like Ethereum,
 * so we query the mirror node REST API for contract logs.
 */
export class HederaWatcher {
  private config: RelayerConfig;
  private mirrorBaseUrl: string;
  private lastTimestamp: string = `${Math.floor(Date.now() / 1000)}.000000000`;
  private bridgeContractEvmAddress: string = "";

  private readonly BRIDGE_BURN_TOPIC = ethers.id(
    "BridgeBurn(uint256,address,address,uint256,uint256,uint256,uint256)"
  );

  private client: Client | null = null;

  constructor(config: RelayerConfig) {
    this.config = config;
    this.mirrorBaseUrl =
      config.hederaNetwork === "mainnet"
        ? "https://mainnet-public.mirrornode.hedera.com"
        : "https://testnet.mirrornode.hedera.com";
  }

  async initialize(): Promise<void> {
    const contractId = ContractId.fromString(this.config.hederaBridgeContractId);
    this.bridgeContractEvmAddress = `0x${contractId.toEvmAddress()}`.toLowerCase();
    console.log(`[HederaWatcher] Watching: ${this.config.hederaBridgeContractId}`);
    console.log(`[HederaWatcher] EVM addr: ${this.bridgeContractEvmAddress}`);
  }

  /** One client for the process — the previous per-call construction leaked gRPC channels. */
  private getClient(): Client {
    if (this.client) return this.client;
    const client =
      this.config.hederaNetwork === "mainnet"
        ? Client.forMainnet()
        : Client.forTestnet();
    client.setOperator(
      AccountId.fromString(this.config.hederaOperatorId),
      PrivateKey.fromStringDer(this.config.hederaOperatorKey)
    );
    this.client = client;
    return client;
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }

  /**
   * Poll for new BridgeBurn events since last check.
   */
  async pollBurnEvents(): Promise<BridgeBurnEvent[]> {
    try {
      const url = new URL(
        `/api/v1/contracts/${this.config.hederaBridgeContractId}/results/logs`,
        this.mirrorBaseUrl
      );
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

      const data = (await response.json()) as {
        logs: Array<{
          topics: string[];
          data: string;
          timestamp: string;
          transaction_hash: string;
        }>;
      };

      if (!data.logs || data.logs.length === 0) return [];

      const events: BridgeBurnEvent[] = [];

      for (const log of data.logs) {
        try {
          const event = this.decodeBurnEvent(log);
          events.push(event);
          this.lastTimestamp = log.timestamp;
        } catch (err) {
          console.error(`[HederaWatcher] Decode error:`, err);
        }
      }

      if (events.length > 0) {
        console.log(`[HederaWatcher] ${events.length} new burn(s) detected`);
      }
      return events;
    } catch (error) {
      console.error(`[HederaWatcher] Poll error:`, error);
      return [];
    }
  }

  private decodeBurnEvent(log: {
    topics: string[];
    data: string;
    timestamp: string;
    transaction_hash: string;
  }): BridgeBurnEvent {
    const nonce = BigInt(log.topics[1]);
    const hederaSender = ethers.getAddress("0x" + log.topics[2].slice(26));
    const polygonRecipient = ethers.getAddress("0x" + log.topics[3].slice(26));

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const decoded = abiCoder.decode(
      ["uint256", "uint256", "uint256", "uint256"],
      log.data
    );

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
   * Highest nonce issued by the bridge so far. Every nonce below this has a
   * burn record on-chain, which is what makes reconciliation authoritative:
   * it never depends on having observed the event.
   */
  async getBridgeNonce(): Promise<bigint> {
    const result = await new ContractCallQuery()
      .setContractId(this.config.hederaBridgeContractId)
      .setGas(100_000)
      .setFunction("bridgeNonce")
      .execute(this.getClient());
    return BigInt(result.getUint256(0).toString());
  }

  /**
   * Read a burn straight from contract storage, for nonces whose event we
   * never saw (relayer was down, mirror node dropped the log).
   */
  async getBurnRecord(nonce: bigint): Promise<BridgeBurnEvent | null> {
    const result = await new ContractCallQuery()
      .setContractId(this.config.hederaBridgeContractId)
      .setGas(100_000)
      .setFunction(
        "getBurnRecord",
        new ContractFunctionParameters().addUint256(new BigNumber(nonce.toString()))
      )
      .execute(this.getClient());

    // BridgeBurnRecord is all static types, so it decodes as a flat tuple:
    // (hederaSender, polygonRecipient, amount, fee, netAmount, timestamp, exists)
    if (!result.getBool(6)) return null;

    return {
      nonce,
      hederaSender: ethers.getAddress(`0x${result.getAddress(0)}`),
      polygonRecipient: ethers.getAddress(`0x${result.getAddress(1)}`),
      amount: BigInt(result.getUint256(2).toString()),
      fee: BigInt(result.getUint256(3).toString()),
      netAmount: BigInt(result.getUint256(4).toString()),
      timestamp: BigInt(result.getUint256(5).toString()),
      transactionId: `reconciled:${nonce}`,
    };
  }

  /**
   * Verify a burn on-chain by querying the bridge contract directly.
   */
  async verifyBurnRecord(nonce: bigint): Promise<boolean> {
    try {
      const client = this.getClient();

      const query = new ContractCallQuery()
        .setContractId(this.config.hederaBridgeContractId)
        .setGas(100_000)
        .setFunction(
          "processedNonces",
          new ContractFunctionParameters().addUint256(new BigNumber(nonce.toString()))
        );

      const result = await query.execute(client);
      return result.getBool(0);
    } catch (error) {
      console.error(`[HederaWatcher] Verify failed nonce ${nonce}:`, error);
      return false;
    }
  }
}
