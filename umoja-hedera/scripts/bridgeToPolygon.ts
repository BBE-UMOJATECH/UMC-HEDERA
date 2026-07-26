import {
  AccountBalanceQuery,
  AccountId,
  Client,
  ContractCallQuery,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  PrivateKey,
  TransferTransaction,
  TransactionId
} from "@hashgraph/sdk";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DECIMALS = 6;
const MIN_HBAR_BALANCE = 0.5;
const TOPUP_HBAR_AMOUNT = 2;
const BRIDGE_BURN_TOPIC0 = ethers.id(
  "BridgeBurn(uint256,address,address,uint256,uint256,uint256,uint256)"
);
const POLYGON_BRIDGE_ABI = [
  "function isNonceClaimed(uint256 nonce) external view returns (bool)"
];

type CliArgs = {
  hederaAccountId: string;
  polygonRecipient: string;
  amount: string;
  waitForClaim: boolean;
  timeoutMs: number;
};

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string> = {};
  let waitForClaim = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--wait-for-claim") {
      waitForClaim = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    values[arg.slice(2)] = next;
    index += 1;
  }

  return {
    hederaAccountId: values["hedera-account-id"] || process.env.HEDERA_OPERATOR_ID || "",
    polygonRecipient:
      values["polygon-recipient"] ||
      process.env.POLYGON_RECIPIENT ||
      process.env.POLYGON_RELAYER_ADDRESS ||
      "",
    amount: values.amount || "",
    waitForClaim,
    timeoutMs: Number(values["timeout-ms"] || 120_000)
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function buildClient(accountId: string): Client {
  const network = (process.env.HEDERA_NETWORK || "testnet") as "testnet" | "mainnet";
  const client = network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), PrivateKey.fromStringDer(requireEnv("HEDERA_OPERATOR_KEY")));
  return client;
}

function mirrorBaseUrl(): string {
  return process.env.HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

function parseAmountToRawUnits(value: string): bigint {
  if (!value.trim()) throw new Error("Amount is required");
  const amount = ethers.parseUnits(value, DECIMALS);
  if (amount <= 0n) throw new Error("Amount must be greater than 0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount is too large for Hedera SDK uint256 parameter encoding");
  }
  return amount;
}

function formatUnits(value: bigint): string {
  return ethers.formatUnits(value, DECIMALS);
}

async function ensureHbarBalance(senderAccountId: AccountId): Promise<void> {
  const operatorId = requireEnv("HEDERA_OPERATOR_ID");
  const operatorClient = buildClient(operatorId);

  try {
    const balance = await new AccountBalanceQuery().setAccountId(senderAccountId).execute(operatorClient);
    const currentHbar = balance.hbars.toBigNumber().toNumber();

    if (currentHbar >= MIN_HBAR_BALANCE) return;
    if (senderAccountId.toString() === operatorId) {
      throw new Error(
        `Sender ${operatorId} has only ${currentHbar} HBAR. Fund the operator account before bridging.`
      );
    }

    console.log(
      `[Hedera] ${senderAccountId.toString()} has ${currentHbar} HBAR, topping up to ${TOPUP_HBAR_AMOUNT} HBAR`
    );

    const transferTx = await new TransferTransaction()
      .addHbarTransfer(senderAccountId, new Hbar(TOPUP_HBAR_AMOUNT))
      .addHbarTransfer(AccountId.fromString(operatorId), new Hbar(-TOPUP_HBAR_AMOUNT))
      .execute(operatorClient);

    const receipt = await transferTx.getReceipt(operatorClient);
    console.log(`[Hedera] top-up status: ${receipt.status.toString()}`);
  } finally {
    operatorClient.close();
  }
}

async function queryBridgeQuote(
  client: Client,
  bridgeContractId: ContractId,
  amountRaw: bigint
): Promise<{ netAmount: bigint; fee: bigint }> {
  const result = await new ContractCallQuery()
    .setContractId(bridgeContractId)
    .setGas(100_000)
    .setFunction("calculateBridgeAmount", new ContractFunctionParameters().addUint256(Number(amountRaw)))
    .execute(client);

  return {
    netAmount: BigInt(result.getUint256(0).toString()),
    fee: BigInt(result.getUint256(1).toString())
  };
}

async function executeContract(
  client: Client,
  senderAccountId: AccountId,
  contractId: ContractId,
  fn: string,
  params: ContractFunctionParameters,
  gas: number
): Promise<void> {
  const tx = await new ContractExecuteTransaction()
    .setTransactionId(TransactionId.generate(senderAccountId))
    .setContractId(contractId)
    .setGas(gas)
    .setFunction(fn, params)
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const status = receipt.status.toString();
  console.log(`[Hedera] ${fn} status: ${status}`);

  if (status !== "SUCCESS") {
    throw new Error(`${fn} failed with status ${status}`);
  }
}

async function fetchBurnNonce(bridgeContractId: string, afterSeconds: number): Promise<bigint> {
  const url =
    `${mirrorBaseUrl()}/api/v1/contracts/${bridgeContractId}/results/logs` +
    `?topic0=${BRIDGE_BURN_TOPIC0}` +
    `&timestamp=gt:${afterSeconds}.000000000` +
    `&timestamp=lt:${afterSeconds + 300}.999999999` +
    `&order=desc&limit=1`;

  await sleep(5_000);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      const data = (await response.json()) as { logs?: Array<{ topics: string[] }> };
      if (data.logs?.length) {
        return BigInt(data.logs[0].topics[1]);
      }
    }

    console.log(`[Mirror] waiting for BridgeBurn log... (${attempt + 1}/6)`);
    await sleep(4_000);
  }

  throw new Error("BridgeBurn event was not indexed by the mirror node in time");
}

/**
 * POLYGON_RPC_URL is Amoy — hardhat.config.ts uses it for the polygonAmoy
 * network, so it cannot be repointed at mainnet. Follow HEDERA_NETWORK instead,
 * the same switch the rest of this script uses; polling the wrong chain reports
 * a mainnet nonce as unclaimed forever.
 */
async function waitForPolygonClaim(nonce: bigint, timeoutMs: number): Promise<void> {
  const rpc =
    process.env.HEDERA_NETWORK === "mainnet"
      ? requireEnv("POLYGON_MAINNET_RPC_URL")
      : requireEnv("POLYGON_RPC_URL");
  const provider = new ethers.JsonRpcProvider(rpc);
  const bridgeContract = new ethers.Contract(
    requireEnv("POLYGON_BRIDGE_ADDRESS"),
    POLYGON_BRIDGE_ABI,
    provider
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const claimed = await bridgeContract.isNonceClaimed(nonce);
    if (claimed) {
      console.log(`[Polygon] nonce ${nonce.toString()} claimed`);
      return;
    }

    process.stdout.write(".");
    await sleep(5_000);
  }

  process.stdout.write("\n");
  throw new Error(`Timed out waiting for Polygon claim for nonce ${nonce.toString()}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage(): void {
  console.log(`Usage:
  npx ts-node scripts/bridgeToPolygon.ts --amount 10 --hedera-account-id 0.0.12345 --polygon-recipient 0xabc...

Options:
  --amount <umc>                 Amount to bridge in UMC units (6 decimals)
  --hedera-account-id <id>       Hedera account to burn from; defaults to HEDERA_OPERATOR_ID
  --polygon-recipient <address>  Polygon recipient; defaults to POLYGON_RECIPIENT
  --wait-for-claim               Poll Polygon bridge until the relayer claims the nonce
  --timeout-ms <ms>              Wait timeout for --wait-for-claim (default: 120000)
`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.amount) {
    printUsage();
    throw new Error("--amount is required");
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(args.polygonRecipient)) {
    throw new Error("polygon recipient must be a valid EVM address");
  }

  requireEnv("HEDERA_OPERATOR_KEY");
  requireEnv("HEDERA_TOKEN_CONTRACT_ID");
  requireEnv("HEDERA_BRIDGE_CONTRACT_ID");
  requireEnv("HEDERA_BRIDGE_EVM_ADDRESS");

  const senderAccountId = AccountId.fromString(args.hederaAccountId);
  const tokenContractId = ContractId.fromString(requireEnv("HEDERA_TOKEN_CONTRACT_ID"));
  const bridgeContractId = ContractId.fromString(requireEnv("HEDERA_BRIDGE_CONTRACT_ID"));
  const amountRaw = parseAmountToRawUnits(args.amount);
  const client = buildClient(args.hederaAccountId);

  try {
    await ensureHbarBalance(senderAccountId);

    const quote = await queryBridgeQuote(client, bridgeContractId, amountRaw);

    console.log("=".repeat(60));
    console.log("  Hedera -> Polygon Bridge");
    console.log("=".repeat(60));
    console.log(`  Hedera sender:    ${args.hederaAccountId}`);
    console.log(`  Polygon recipient:${args.polygonRecipient}`);
    console.log(`  Gross amount:     ${formatUnits(amountRaw)} UMC`);
    console.log(`  Bridge fee:       ${formatUnits(quote.fee)} UMC`);
    console.log(`  Net amount:       ${formatUnits(quote.netAmount)} UMC`);
    console.log(`  Hedera token:     ${tokenContractId.toString()}`);
    console.log(`  Hedera bridge:    ${bridgeContractId.toString()}`);
    console.log("=".repeat(60));

    const startedAtSeconds = Math.floor(Date.now() / 1000);

    await executeContract(
      client,
      senderAccountId,
      tokenContractId,
      "approve",
      new ContractFunctionParameters()
        .addAddress(requireEnv("HEDERA_BRIDGE_EVM_ADDRESS"))
        .addUint256(Number(amountRaw)),
      300_000
    );

    await executeContract(
      client,
      senderAccountId,
      bridgeContractId,
      "bridgeToPolygon",
      new ContractFunctionParameters()
        .addAddress(args.polygonRecipient)
        .addUint256(Number(amountRaw)),
      500_000
    );

    const nonce = await fetchBurnNonce(requireEnv("HEDERA_BRIDGE_CONTRACT_ID"), startedAtSeconds);
    console.log(`[Hedera] BridgeBurn nonce: ${nonce.toString()}`);

    if (args.waitForClaim) {
      console.log("[Polygon] waiting for relayer claim");
      await waitForPolygonClaim(nonce, args.timeoutMs);
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("\nBridge failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
