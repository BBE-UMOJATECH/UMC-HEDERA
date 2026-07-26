import { ethers, upgrades } from "hardhat";
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

const HEDERA_CHAINS: Record<number, { name: "testnet" | "mainnet"; mirror: string }> = {
  296: { name: "testnet", mirror: "https://testnet.mirrornode.hedera.com" },
  295: { name: "mainnet", mirror: "https://mainnet-public.mirrornode.hedera.com" },
};

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const chain = HEDERA_CHAINS[chainId];
  if (!chain) {
    throw new Error(
      `Refusing to deploy: chainId ${chainId} is not Hedera (expected 296 or 295).`
    );
  }

  const [deployer] = await ethers.getSigners();
  const roles = loadRoleConfig(deployer.address);
  console.log("=".repeat(60));
  console.log(`  Deploying UMCBridgeHedera — ${chain.name} (chainId ${chainId})`);
  console.log("=".repeat(60));
  console.log("  Deployer:", deployer.address);
  describeRoles(roles, deployer.address);

  // Token address comes from the deploy.ts run on *this* network. Reading the
  // wrong file points the bridge at a token that does not exist here.
  const tokenPath = path.join(__dirname, `../deployments/${chain.name}.json`);
  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `${tokenPath} not found — deploy UMCToken on ${chain.name} first (scripts/deploy.ts).`
    );
  }
  const tokenDeployment = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
  const umcTokenAddress = `0x${tokenDeployment.evmAddress}`;
  console.log("  UMCToken:", umcTokenAddress);

  if ((await ethers.provider.getCode(umcTokenAddress)) === "0x") {
    throw new Error(
      `No contract at ${umcTokenAddress} on ${chain.name}. ` +
        `deployments/${chain.name}.json is stale or from another network.`
    );
  }

  const UMCBridgeHedera = await ethers.getContractFactory("UMCBridgeHedera");

  const bridge = await upgrades.deployProxy(
    UMCBridgeHedera,
    [
      umcTokenAddress,
      deployer.address,                          // admin — handed over below
      roles.feeRecipient,                        // feeRecipient
      ethers.parseUnits("1", 6),                 // minBridgeAmount: 1 UMC
      ethers.parseUnits("100000", 6),            // maxBridgeAmount: 100k UMC
      25,                                        // feeBasisPoints: 0.25%
      ethers.parseUnits("1000000", 6),           // dailyVolumeLimit: 1M UMC
    ],
    { initializer: "initialize", kind: "uups" }
  );

  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();

  // Resolve Hedera entity ID from EVM address
  const mirrorRes = await fetch(`${chain.mirror}/api/v1/contracts/${bridgeAddress}`);
  const mirrorData = await mirrorRes.json() as { contract_id?: string };
  const hederaContractId = mirrorData.contract_id ?? "";

  const assignments = [
    { role: ROLE.OPERATOR, name: "operator", holder: roles.operator },
    { role: ROLE.UPGRADER, name: "upgrader", holder: roles.upgrader },
    { role: ROLE.DEFAULT_ADMIN, name: "admin", holder: roles.admin },
  ];
  console.log("\n🔑 Assigning roles...");
  await grantRoles(bridge, assignments);
  console.log("\n🔒 Finalising role handover...");
  await revokeDeployerRoles(bridge, assignments, deployer.address, roles.revokeDeployer);

  console.log("\n✅ UMCBridgeHedera deployed to:", bridgeAddress);
  console.log("   Hedera contract ID:", hederaContractId);
  console.log("=".repeat(60));

  const info = {
    network: chain.name,
    bridgeAddress,
    hederaContractId,
    umcToken: umcTokenAddress,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };

  const outName = `hedera-bridge-${chain.name}.json`;
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, `../deployments/${outName}`),
    JSON.stringify(info, null, 2)
  );
  console.log(`  Saved → deployments/${outName}`);
  console.log("\n  Add to .env:");
  console.log(`  HEDERA_BRIDGE_CONTRACT_ID=${hederaContractId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
