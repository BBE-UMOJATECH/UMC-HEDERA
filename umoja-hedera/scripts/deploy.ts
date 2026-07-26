/**
 * Deploy UMCToken behind a UUPS proxy on Hedera.
 *
 * The initializer runs inside the proxy constructor, so there is no window
 * between contract creation and initialize() in which someone else can claim
 * DEFAULT_ADMIN_ROLE — and the token stays upgradeable, which a bare
 * implementation deployed via ContractCreateFlow is not.
 *
 *   npm run deploy:testnet   (hardhat --network hederaTestnet)
 *   npm run deploy:mainnet   (hardhat --network hederaMainnet)
 */
import { ethers, upgrades, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  ROLE,
  grantRoles,
  revokeDeployerRoles,
  describeRoles,
  loadRoleConfig,
} from "./roles";

dotenv.config();

const DECIMALS = 6;

const HEDERA_CHAINS: Record<number, { name: "testnet" | "mainnet"; mirror: string }> = {
  296: { name: "testnet", mirror: "https://testnet.mirrornode.hedera.com" },
  295: { name: "mainnet", mirror: "https://mainnet-public.mirrornode.hedera.com" },
};

const SUPPLY_CAP_UMC = Number(process.env.INITIAL_SUPPLY_CAP) || 1_000_000_000;
const MINTER_ALLOWANCE_UMC = Number(process.env.INITIAL_MINTER_ALLOWANCE) || 100_000_000;

/** Resolve the Hedera entity ID (0.0.x) for a freshly deployed EVM address. */
async function resolveContractId(mirror: string, evmAddress: string): Promise<string> {
  // The mirror node indexes a few seconds behind consensus.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await fetch(`${mirror}/api/v1/contracts/${evmAddress}`);
    if (res.ok) {
      const data = (await res.json()) as { contract_id?: string };
      if (data.contract_id) return data.contract_id;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Mirror node did not index ${evmAddress} in time`);
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const chain = HEDERA_CHAINS[chainId];
  if (!chain) {
    throw new Error(
      `Refusing to deploy: chainId ${chainId} is not Hedera (expected 296 or 295). ` +
        `Check the --network flag.`
    );
  }
  if (process.env.HEDERA_NETWORK && process.env.HEDERA_NETWORK !== chain.name) {
    throw new Error(
      `HEDERA_NETWORK=${process.env.HEDERA_NETWORK} but --network ${network.name} is ` +
        `${chain.name}. Refusing to deploy against a mismatched config.`
    );
  }

  const [deployer] = await ethers.getSigners();
  const roles = loadRoleConfig(deployer.address);
  const supplyCap = ethers.parseUnits(String(SUPPLY_CAP_UMC), DECIMALS);
  const minterAllowance = ethers.parseUnits(String(MINTER_ALLOWANCE_UMC), DECIMALS);

  console.log("=".repeat(60));
  console.log("  UMC Stablecoin - Hedera Deployment");
  console.log("=".repeat(60));
  console.log(`  Network:     ${chain.name} (chainId ${chainId})`);
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Supply Cap:  $${SUPPLY_CAP_UMC.toLocaleString()}`);
  describeRoles(roles, deployer.address);
  console.log("=".repeat(60));

  console.log("\n📦 Deploying UMCToken behind a UUPS proxy...");
  const UMCToken = await ethers.getContractFactory("UMCToken");
  const token = await upgrades.deployProxy(UMCToken, [deployer.address, supplyCap], {
    initializer: "initialize",
    kind: "uups",
  });
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("✅ UMCToken proxy:", tokenAddress);
  console.log("   Implementation:", await upgrades.erc1967.getImplementationAddress(tokenAddress));

  // Grant MINTER_ROLE before setting the allowance — setMinterAllowance reverts
  // for an address that is not already a minter.
  const assignments = [
    { role: ROLE.MINTER, name: "minter", holder: roles.minter },
    { role: ROLE.PAUSER, name: "pauser", holder: roles.pauser },
    { role: ROLE.BLACKLISTER, name: "blacklister", holder: roles.blacklister },
    { role: ROLE.UPGRADER, name: "upgrader", holder: roles.upgrader },
    { role: ROLE.DEFAULT_ADMIN, name: "admin", holder: roles.admin },
  ];

  console.log("\n🔑 Assigning roles...");
  await grantRoles(token, assignments);

  console.log("\n💰 Setting minter allowance...");
  await (await (token as any).setMinterAllowance(roles.minter, minterAllowance)).wait();

  console.log("\n🔍 Verifying deployment...");
  console.log("  Token Name:   ", await (token as any).name());
  console.log("  Token Symbol: ", await (token as any).symbol());
  console.log("  Decimals:     ", await (token as any).decimals());
  console.log("  Supply Cap:   ", (await (token as any).supplyCap()).toString());

  const contractId = await resolveContractId(chain.mirror, tokenAddress);
  console.log("  Hedera ID:    ", contractId);

  // Last, because everything above needs the deployer to still be admin.
  console.log("\n🔒 Finalising role handover...");
  await revokeDeployerRoles(token, assignments, deployer.address, roles.revokeDeployer);

  const info = {
    network: chain.name,
    contractId,
    // Consumers read this as `0x${evmAddress}` — keep it unprefixed.
    evmAddress: tokenAddress.toLowerCase().replace(/^0x/, ""),
    supplyCap: SUPPLY_CAP_UMC,
    minterAllowance: MINTER_ALLOWANCE_UMC,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };

  const outputPath = path.join(__dirname, "../deployments", `${chain.name}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(info, null, 2));

  console.log("\n" + "=".repeat(60));
  console.log("  🎉 UMC STABLECOIN DEPLOYED");
  console.log(`  Contract ID: ${contractId}`);
  console.log("=".repeat(60));
  console.log(`\n📄 Saved → ${outputPath}`);
  console.log("\n  Add to .env:");
  console.log(`  HEDERA_TOKEN_CONTRACT_ID=${contractId}`);
}

main().catch((error) => {
  console.error("\n❌ Deployment failed:", error);
  process.exit(1);
});
