import {
  Client,
  AccountId,
  PrivateKey,
  ContractCreateFlow,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractCallQuery,
  Hbar,
} from "@hashgraph/sdk";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

// =============================================================================
// CONFIGURATION
// =============================================================================

interface DeployConfig {
  /** Hedera account ID (0.0.XXXXX) */
  operatorId: string;
  /** Hedera account private key (DER or hex) */
  operatorKey: string;
  /** "testnet" | "mainnet" | "previewnet" */
  network: "testnet" | "mainnet" | "previewnet";
  /** Initial supply cap in UMC (human-readable, e.g., 1_000_000_000 = $1B) */
  initialSupplyCapUMC: number;
  /** Initial minter allowance in UMC */
  initialMinterAllowanceUMC: number;
  /** Max gas for contract creation */
  maxGas: number;
}

const config: DeployConfig = {
  operatorId: process.env.HEDERA_OPERATOR_ID || "",
  operatorKey: process.env.HEDERA_OPERATOR_KEY || "",
  network: (process.env.HEDERA_NETWORK as DeployConfig["network"]) || "testnet",
  initialSupplyCapUMC: Number(process.env.INITIAL_SUPPLY_CAP) || 1_000_000_000, // $1B
  initialMinterAllowanceUMC:
    Number(process.env.INITIAL_MINTER_ALLOWANCE) || 100_000_000, // $100M
  maxGas: 4_000_000,
};

// UMC uses 6 decimals
const DECIMALS = 6;
const toSmallestUnit = (amount: number): bigint =>
  BigInt(amount) * BigInt(10 ** DECIMALS);

// =============================================================================
// DEPLOYMENT
// =============================================================================

async function deployUMCToken(): Promise<string> {
  // Validate config
  if (!config.operatorId || !config.operatorKey) {
    throw new Error(
      "Missing HEDERA_OPERATOR_ID or HEDERA_OPERATOR_KEY in .env"
    );
  }

  console.log("=".repeat(60));
  console.log("  UMC Stablecoin - Hedera Deployment");
  console.log("=".repeat(60));
  console.log(`  Network:     ${config.network}`);
  console.log(`  Operator:    ${config.operatorId}`);
  console.log(`  Supply Cap:  $${config.initialSupplyCapUMC.toLocaleString()}`);
  console.log("=".repeat(60));

  // Initialize Hedera client
  const operatorId = AccountId.fromString(config.operatorId);
  const operatorKey = PrivateKey.fromStringDer(config.operatorKey);

  let client: Client;
  switch (config.network) {
    case "mainnet":
      client = Client.forMainnet();
      break;
    case "testnet":
      client = Client.forTestnet();
      break;
    case "previewnet":
      client = Client.forPreviewnet();
      break;
  }
  client.setOperator(operatorId, operatorKey);

  // Read compiled contract bytecode
  // You must compile with: npx hardhat compile
  const artifactPath = path.join(
    __dirname,
    "../artifacts/contracts/UMCToken.sol/UMCToken.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Compiled artifact not found at ${artifactPath}. Run 'npx hardhat compile' first.`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const bytecode = artifact.bytecode;

  console.log("\n📦 Deploying UMC implementation contract...");

  // For UUPS, we deploy via a proxy. For simplicity, this deploys the
  // implementation directly. In production, use a proxy factory like
  // OpenZeppelin's ERC1967Proxy deployed via Hedera.
  const supplyCap = toSmallestUnit(config.initialSupplyCapUMC);

  // Encode the initialize function call
  const contractCreate = new ContractCreateFlow()
    .setBytecode(bytecode)
    .setGas(config.maxGas)
    .setConstructorParameters(
      new ContractFunctionParameters()
        // The UUPS pattern uses an initializer, not a constructor.
        // Deploy implementation first, then proxy pointing to it.
        // For direct deployment (non-proxy), we call initialize after.
    );

  const txResponse = await contractCreate.execute(client);
  const receipt = await txResponse.getReceipt(client);
  const contractId = receipt.contractId!;

  console.log(`✅ Contract deployed: ${contractId.toString()}`);
  console.log(
    `   EVM Address: ${contractId.toSolidityAddress()}`
  );

  // Initialize the contract
  console.log("\n🔧 Initializing UMC Token...");

  const initTx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(500_000)
    .setFunction(
      "initialize",
      new ContractFunctionParameters()
        .addAddress(operatorId.toSolidityAddress())
        .addUint256(supplyCap)
    );

  const initResponse = await initTx.execute(client);
  const initReceipt = await initResponse.getReceipt(client);
  console.log(`✅ Initialized: ${initReceipt.status.toString()}`);

  // Set minter allowance for the operator
  console.log("\n💰 Setting minter allowance...");

  const minterAllowance = toSmallestUnit(config.initialMinterAllowanceUMC);
  const allowanceTx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(200_000)
    .setFunction(
      "setMinterAllowance",
      new ContractFunctionParameters()
        .addAddress(operatorId.toSolidityAddress())
        .addUint256(minterAllowance)
    );

  const allowanceResponse = await allowanceTx.execute(client);
  const allowanceReceipt = await allowanceResponse.getReceipt(client);
  console.log(
    `✅ Minter allowance set: $${config.initialMinterAllowanceUMC.toLocaleString()}`
  );

  // Verify deployment
  console.log("\n🔍 Verifying deployment...");
  await verifyDeployment(client, contractId);

  // Save deployment info
  const deploymentInfo = {
    network: config.network,
    contractId: contractId.toString(),
    evmAddress: contractId.toSolidityAddress(),
    supplyCap: config.initialSupplyCapUMC,
    minterAllowance: config.initialMinterAllowanceUMC,
    deployer: config.operatorId,
    timestamp: new Date().toISOString(),
  };

  const outputPath = path.join(__dirname, "../deployments", `${config.network}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\n📄 Deployment info saved to: ${outputPath}`);

  return contractId.toString();
}

// =============================================================================
// VERIFICATION
// =============================================================================

async function verifyDeployment(
  client: Client,
  contractId: any
): Promise<void> {
  // Query token name
  const nameQuery = new ContractCallQuery()
    .setContractId(contractId)
    .setGas(100_000)
    .setFunction("name");

  const nameResult = await nameQuery.execute(client);
  const name = nameResult.getString(0);
  console.log(`  Token Name:    ${name}`);

  // Query token symbol
  const symbolQuery = new ContractCallQuery()
    .setContractId(contractId)
    .setGas(100_000)
    .setFunction("symbol");

  const symbolResult = await symbolQuery.execute(client);
  const symbol = symbolResult.getString(0);
  console.log(`  Token Symbol:  ${symbol}`);

  // Query decimals
  const decimalsQuery = new ContractCallQuery()
    .setContractId(contractId)
    .setGas(100_000)
    .setFunction("decimals");

  const decimalsResult = await decimalsQuery.execute(client);
  const dec = decimalsResult.getUint8(0);
  console.log(`  Decimals:      ${dec}`);

  // Query supply cap
  const capQuery = new ContractCallQuery()
    .setContractId(contractId)
    .setGas(100_000)
    .setFunction("supplyCap");

  const capResult = await capQuery.execute(client);
  const cap = capResult.getUint256(0);
  console.log(`  Supply Cap:    ${cap.toString()} (smallest unit)`);
}

// =============================================================================
// OPERATIONAL HELPERS
// =============================================================================

/**
 * Mint UMC tokens to a recipient address.
 */
async function mintTokens(
  client: Client,
  contractId: string,
  to: string,
  amountUMC: number
): Promise<void> {
  const amount = toSmallestUnit(amountUMC);
  const tx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(300_000)
    .setFunction(
      "mint",
      new ContractFunctionParameters()
        .addAddress(to)
        .addUint256(amount)
    );

  const response = await tx.execute(client);
  const receipt = await response.getReceipt(client);
  console.log(
    `Minted ${amountUMC.toLocaleString()} UMC to ${to}: ${receipt.status}`
  );
}

/**
 * Blacklist an address for compliance.
 */
async function blacklistAddress(
  client: Client,
  contractId: string,
  account: string
): Promise<void> {
  const tx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(200_000)
    .setFunction(
      "blacklist",
      new ContractFunctionParameters().addAddress(account)
    );

  const response = await tx.execute(client);
  const receipt = await response.getReceipt(client);
  console.log(`Blacklisted ${account}: ${receipt.status}`);
}

/**
 * Pause all transfers (emergency).
 */
async function pauseContract(
  client: Client,
  contractId: string
): Promise<void> {
  const tx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(200_000)
    .setFunction("pause");

  const response = await tx.execute(client);
  const receipt = await response.getReceipt(client);
  console.log(`Contract paused: ${receipt.status}`);
}

// =============================================================================
// ENTRY POINT
// =============================================================================

deployUMCToken()
  .then((contractId) => {
    console.log("\n" + "=".repeat(60));
    console.log("  🎉 UMC STABLECOIN DEPLOYED SUCCESSFULLY");
    console.log(`  Contract ID: ${contractId}`);
    console.log("=".repeat(60));
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });

export { deployUMCToken, mintTokens, blacklistAddress, pauseContract };
