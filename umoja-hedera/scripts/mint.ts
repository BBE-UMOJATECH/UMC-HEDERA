import {
  Client,
  AccountId,
  PrivateKey,
  ContractId,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractCallQuery,
  AccountInfoQuery,
} from "@hashgraph/sdk";
import BigNumber from "bignumber.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const DECIMALS = 6;
const toSmallestUnit = (amount: number): bigint =>
  BigInt(amount) * BigInt(10 ** DECIMALS);

async function mintUMC(to: string, amountUMC: number): Promise<void> {
  const operatorId = AccountId.fromString(process.env.HEDERA_OPERATOR_ID || "");
  const operatorKey = PrivateKey.fromStringDer(process.env.HEDERA_OPERATOR_KEY || "");

  const network = (process.env.HEDERA_NETWORK || "testnet") as "testnet" | "mainnet";
  const client = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(operatorId, operatorKey);

  // Load deployed contract address
  const deploymentPath = path.join(__dirname, `../deployments/${network}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found at ${deploymentPath}. Run deploy first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const contractId = ContractId.fromString(deployment.contractId);

  console.log("=".repeat(60));
  console.log("  UMC Token - Mint");
  console.log("=".repeat(60));
  console.log(`  Contract:   ${contractId.toString()}`);
  console.log(`  Recipient:  ${to}`);
  console.log(`  Amount:     ${amountUMC.toLocaleString()} UMC`);
  console.log("=".repeat(60));

  // Check recipient balance before
  const balanceBefore = await queryBalance(client, contractId, to);
  console.log(`\n  Balance before: ${formatUMC(balanceBefore)} UMC`);

  // Mint tokens directly to recipient
  console.log("\n🪙  Minting...");
  const amount = toSmallestUnit(amountUMC);

  const mintTx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(300_000)
    .setFunction(
      "mint",
      new ContractFunctionParameters()
        .addAddress(to)
        .addUint256(new BigNumber(amount.toString()))
    );

  const response = await mintTx.execute(client);
  const receipt = await response.getReceipt(client);
  console.log(`✅ Mint status: ${receipt.status.toString()}`);

  // Check recipient balance after
  const balanceAfter = await queryBalance(client, contractId, to);
  console.log(`\n  Balance after:  ${formatUMC(balanceAfter)} UMC`);
  console.log("\n" + "=".repeat(60));
  console.log(`  ✅ Minted ${amountUMC.toLocaleString()} UMC to ${to}`);
  console.log("=".repeat(60));
}

async function queryBalance(
  client: Client,
  contractId: ContractId,
  address: string
): Promise<bigint> {
  const result = await new ContractCallQuery()
    .setContractId(contractId)
    .setGas(100_000)
    .setFunction(
      "balanceOf",
      new ContractFunctionParameters().addAddress(address)
    )
    .execute(client);
  return BigInt(result.getUint256(0).toString());
}

function formatUMC(smallest: bigint): string {
  const whole = smallest / BigInt(10 ** DECIMALS);
  return whole.toLocaleString();
}

// Entry point — mint 1,000,000 UMC to the target address
mintUMC("0xea3a8d8d79ca15758aa13b91fef437ccb8bb8dd3", 1_000_000)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Mint failed:", err);
    process.exit(1);
  });

  
