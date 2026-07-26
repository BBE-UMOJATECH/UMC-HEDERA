/**
 * End-to-end bridge test
 *
 * Steps:
 *  1. Mint UMC to the test wallet on Hedera
 *  2. Approve the bridge contract
 *  3. Call bridgeToPolygon → emits BridgeBurn
 *  4. Poll the relayer's output and the Polygon bridge for the resulting mint
 *
 * Usage:
 *   npx hardhat run scripts/testBridge.ts --network hederaTestnet
 */

import {
  Client,
  AccountId,
  PrivateKey,
  ContractId,
  ContractExecuteTransaction,
  ContractCallQuery,
  ContractFunctionParameters,
  TransactionId,
} from "@hashgraph/sdk";
import { ethers } from "ethers";
import BigNumber from "bignumber.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const BRIDGE_AMOUNT_UMC = 10;              // gross UMC to bridge
const DECIMALS = 6;
const toUnits = (n: number) => BigInt(n) * BigInt(10 ** DECIMALS);

const POLYGON_BRIDGE_ABI = [
  "function isNonceClaimed(uint256 nonce) external view returns (bool)",
];

// ─── Hedera helpers ───────────────────────────────────────────────────────────

function hederaClient(): Client {
  const network = (process.env.HEDERA_NETWORK || "testnet") as "testnet" | "mainnet";
  const client = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(
    AccountId.fromString(process.env.HEDERA_OPERATOR_ID!),
    PrivateKey.fromStringDer(process.env.HEDERA_OPERATOR_KEY!)
  );
  return client;
}

async function callContractVoid(
  client: Client,
  contractId: ContractId,
  fn: string,
  params: ContractFunctionParameters,
  gas = 300_000
): Promise<void> {
  const operatorId = AccountId.fromString(process.env.HEDERA_OPERATOR_ID!);
  const tx = await new ContractExecuteTransaction()
    .setTransactionId(TransactionId.generate(operatorId))
    .setContractId(contractId)
    .setGas(gas)
    .setFunction(fn, params)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  console.log(`  [Hedera] ${fn}: ${receipt.status}`);
}

async function queryUint256(
  client: Client,
  contractId: ContractId,
  fn: string,
  params: ContractFunctionParameters
): Promise<bigint> {
  const res = await new ContractCallQuery()
    .setContractId(contractId)
    .setGas(100_000)
    .setFunction(fn, params)
    .execute(client);
  return BigInt(res.getUint256(0).toString());
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load deployments
  const network = process.env.HEDERA_NETWORK || "testnet";
  const tokenDeployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/${network}.json`), "utf-8")
  );
  const bridgeDeployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/hedera-bridge-testnet.json`), "utf-8")
  );

  const tokenContractId = ContractId.fromString(tokenDeployment.contractId);
  const hederaBridgeId = bridgeDeployment.hederaContractId || process.env.HEDERA_BRIDGE_CONTRACT_ID;
  if (!hederaBridgeId) throw new Error("HEDERA_BRIDGE_CONTRACT_ID not found in deployment or .env");
  const bridgeContractId = ContractId.fromString(hederaBridgeId);
  const bridgeEvmAddress = bridgeDeployment.bridgeAddress;

  const client = hederaClient();

  // Resolve the operator's actual EVM address from the mirror node.
  // AccountId.toEvmAddress() only returns the zero-padded account num,
  // which differs from msg.sender when the account has an ECDSA alias.
  const mirrorBase = network === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
  const accountRes = await fetch(`${mirrorBase}/api/v1/accounts/${process.env.HEDERA_OPERATOR_ID}`);
  const accountData = await accountRes.json() as { evm_address?: string };
  const operatorEvmAddress = accountData.evm_address
    ? accountData.evm_address.toLowerCase()
    : `0x${AccountId.fromString(process.env.HEDERA_OPERATOR_ID!).toEvmAddress()}`;

  // The Polygon recipient — use the relayer address or any wallet you control on Polygon
  const polygonRecipient = process.env.POLYGON_RECIPIENT || process.env.POLYGON_RELAYER_ADDRESS || "";
  if (!polygonRecipient) {
    throw new Error("Set POLYGON_RECIPIENT or POLYGON_RELAYER_ADDRESS in .env");
  }

  const gross = toUnits(BRIDGE_AMOUNT_UMC);

  console.log("=".repeat(60));
  console.log("  UMC Bridge — End-to-End Test");
  console.log("=".repeat(60));
  console.log(`  Hedera token:   ${tokenContractId}`);
  console.log(`  Hedera bridge:  ${bridgeContractId}`);
  console.log(`  Polygon bridge: ${process.env.POLYGON_BRIDGE_ADDRESS}`);
  console.log(`  Sender (EVM):   ${operatorEvmAddress}`);
  console.log(`  Polygon recip:  ${polygonRecipient}`);
  console.log(`  Amount:         ${BRIDGE_AMOUNT_UMC} UMC`);
  console.log("=".repeat(60));

  // ── Step 1: Mint UMC to the operator ────────────────────────────────────────
  console.log("\n[1/4] Minting UMC to operator...");
  await callContractVoid(
    client, tokenContractId, "mint",
    new ContractFunctionParameters()
      .addAddress(operatorEvmAddress)
      .addUint256(new BigNumber(gross.toString()))
  );

  const balance = await queryUint256(
    client, tokenContractId, "balanceOf",
    new ContractFunctionParameters().addAddress(operatorEvmAddress)
  );
  console.log(`  Balance: ${Number(balance) / 10 ** DECIMALS} UMC`);

  // ── Step 2: Approve bridge to spend ─────────────────────────────────────────
  console.log("\n[2/4] Approving bridge...");
  await callContractVoid(
    client, tokenContractId, "approve",
    new ContractFunctionParameters()
      .addAddress(bridgeEvmAddress)
      .addUint256(new BigNumber(gross.toString()))
  );

  // ── Step 3: Call bridgeToPolygon ─────────────────────────────────────────────
  console.log("\n[3/4] Calling bridgeToPolygon...");
  await callContractVoid(
    client, bridgeContractId, "bridgeToPolygon",
    new ContractFunctionParameters()
      .addAddress(polygonRecipient)
      .addUint256(new BigNumber(gross.toString())),
    500_000
  );
  console.log("  BridgeBurn event emitted — relayer should pick this up.");

  // ── Step 4: Poll Polygon for the mint ────────────────────────────────────────
  console.log("\n[4/4] Polling Polygon for claimMint confirmation...");
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL!);
  const polygonBridge = new ethers.Contract(
    process.env.POLYGON_BRIDGE_ADDRESS!,
    POLYGON_BRIDGE_ABI,
    provider
  );

  // Get the latest nonce from the Hedera mirror node
  const topic0 = ethers.id("BridgeBurn(uint256,address,address,uint256,uint256,uint256,uint256)");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const logsUrl = `${mirrorBase}/api/v1/contracts/${hederaBridgeId}/results/logs?topic0=${topic0}&timestamp=gt:${nowSeconds - 60}.000000000&timestamp=lt:${nowSeconds + 300}.999999999&order=desc&limit=1`;

  let nonce: bigint | null = null;

  // Give mirror node a moment to index the transaction
  await new Promise((r) => setTimeout(r, 5000));

  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(logsUrl);
      const data = await res.json() as { logs?: Array<{ topics: string[] }> };
      if (data.logs && data.logs.length > 0) {
        nonce = BigInt(data.logs[0].topics[1]);
        console.log(`  Detected nonce: ${nonce}`);
        break;
      }
    } catch {}
    console.log(`  Waiting for mirror node to index... (${i + 1}/5)`);
    await new Promise((r) => setTimeout(r, 4000));
  }

  if (nonce === null) {
    console.log("  Could not read nonce from mirror node. Check the relayer logs manually.");
    return;
  }

  console.log(`\n  Waiting for relayer to submit claimMint (nonce=${nonce})...`);
  const POLL_TIMEOUT = 120_000; // 2 minutes
  const started = Date.now();

  while (Date.now() - started < POLL_TIMEOUT) {
    const claimed = await polygonBridge.isNonceClaimed(nonce);
    if (claimed) {
      console.log(`\n✅ SUCCESS — nonce ${nonce} claimed on Polygon!`);
      console.log("=".repeat(60));
      return;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log(`\n⚠️  Timed out waiting for nonce ${nonce} to be claimed. Check relayer logs.`);
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
