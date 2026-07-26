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

const CLAIM_WINDOW = Number(process.env.CLAIM_WINDOW_SECONDS) || 86_400;

async function main() {
  const [deployer] = await ethers.getSigners();
  const roles = loadRoleConfig(deployer.address);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  // ATTESTATION_TTL must stay under claimWindow or claimMint reverts with
  // DeadlineExceedsClaimWindow; catch the misconfiguration before deploying.
  const ttl = Number(process.env.ATTESTATION_TTL) || 3_600;
  if (ttl >= CLAIM_WINDOW) {
    throw new Error(
      `ATTESTATION_TTL=${ttl} must be less than CLAIM_WINDOW_SECONDS=${CLAIM_WINDOW}`
    );
  }

  console.log("=".repeat(60));
  console.log(`  Deploying UMCToken + UMCBridgePolygon on ${network.name} (chainId ${chainId})`);
  console.log("=".repeat(60));
  console.log("  Deployer:", deployer.address);
  console.log("  Claim window:", CLAIM_WINDOW, "s");
  describeRoles(roles, deployer.address);

  console.log("\n📦 Deploying UMCToken (Polygon)...");
  const UMCToken = await ethers.getContractFactory("UMCToken");
  const token = await upgrades.deployProxy(
    UMCToken,
    [
      deployer.address,
      ethers.parseUnits("1000000000", 6), // $1B supply cap
    ],
    { initializer: "initialize", kind: "uups" }
  );
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("✅ UMCToken (Polygon):", tokenAddress);

  // 2. Deploy UMCBridgePolygon
  console.log("\n📦 Deploying UMCBridgePolygon...");
  const UMCBridgePolygon = await ethers.getContractFactory("UMCBridgePolygon");
  const bridge = await upgrades.deployProxy(
    UMCBridgePolygon,
    [
      tokenAddress,
      deployer.address,   // admin — handed over below
      roles.relayer,      // relayer
      CLAIM_WINDOW,
    ],
    { initializer: "initialize", kind: "uups" }
  );
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  console.log("✅ UMCBridgePolygon:", bridgeAddress);

  // 3. Grant MINTER_ROLE on UMCToken to the bridge
  console.log("\n🔑 Granting MINTER_ROLE to bridge...");
  await (await (token as any).grantRole(ROLE.MINTER, bridgeAddress)).wait();

  // 4. Set minter allowance for the bridge ($100M)
  console.log("💰 Setting minter allowance...");
  await (
    await (token as any).setMinterAllowance(
      bridgeAddress,
      ethers.parseUnits("100000000", 6)
    )
  ).wait();

  // 5. Hand the remaining roles to their configured holders.
  const tokenAssignments = [
    // On Polygon the bridge is the only legitimate minter — UMC here exists
    // solely as the mint side of a Hedera burn. Naming it here means the
    // deployer's MINTER_ROLE gets stripped during handover.
    { role: ROLE.MINTER, name: "token minter", holder: bridgeAddress },
    { role: ROLE.PAUSER, name: "token pauser", holder: roles.pauser },
    { role: ROLE.BLACKLISTER, name: "token blacklister", holder: roles.blacklister },
    { role: ROLE.UPGRADER, name: "token upgrader", holder: roles.upgrader },
    { role: ROLE.DEFAULT_ADMIN, name: "token admin", holder: roles.admin },
  ];
  const bridgeAssignments = [
    { role: ROLE.RELAYER, name: "bridge relayer", holder: roles.relayer },
    { role: ROLE.OPERATOR, name: "bridge operator", holder: roles.operator },
    { role: ROLE.UPGRADER, name: "bridge upgrader", holder: roles.upgrader },
    { role: ROLE.DEFAULT_ADMIN, name: "bridge admin", holder: roles.admin },
  ];

  console.log("\n🔑 Assigning roles...");
  await grantRoles(token, tokenAssignments);
  await grantRoles(bridge, bridgeAssignments);

  console.log("\n🔒 Finalising role handover...");
  await revokeDeployerRoles(token, tokenAssignments, deployer.address, roles.revokeDeployer);
  await revokeDeployerRoles(bridge, bridgeAssignments, deployer.address, roles.revokeDeployer);

  console.log("\n" + "=".repeat(60));
  console.log("  ✅ Polygon deployment complete");
  console.log("=".repeat(60));

  const info = {
    network: network.name,
    chainId,
    umcToken: tokenAddress,
    bridgeAddress,
    deployer: deployer.address,
    roles: {
      admin: roles.admin,
      upgrader: roles.upgrader,
      operator: roles.operator,
      relayer: roles.relayer,
    },
    timestamp: new Date().toISOString(),
  };

  const outName =
    network.name === "polygon"
      ? "polygon-bridge-mainnet.json"
      : "polygon-bridge-amoy.json";
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, `../deployments/${outName}`),
    JSON.stringify(info, null, 2)
  );
  console.log(`  Saved → deployments/${outName}`);
  console.log("\n  Add to .env:");
  console.log(`  POLYGON_BRIDGE_ADDRESS=${bridgeAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
