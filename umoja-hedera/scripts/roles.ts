/**
 * Role assignment for deployments.
 *
 * Both bridge contracts and the token grant every role to a single address in
 * their initializer. That is fine for a testnet spike and wrong for mainnet,
 * where the key that signs attestations should not also be able to upgrade the
 * contract. This module lets each role be pointed at its own address via env,
 * defaulting to the deployer so existing flows keep working unchanged.
 */
import { ethers } from "hardhat";

export const ROLE = {
  DEFAULT_ADMIN: ethers.ZeroHash,
  MINTER: ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE")),
  PAUSER: ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
  BLACKLISTER: ethers.keccak256(ethers.toUtf8Bytes("BLACKLISTER_ROLE")),
  UPGRADER: ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE")),
  OPERATOR: ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE")),
  RELAYER: ethers.keccak256(ethers.toUtf8Bytes("RELAYER_ROLE")),
} as const;

export interface RoleConfig {
  admin: string;
  upgrader: string;
  pauser: string;
  blacklister: string;
  minter: string;
  operator: string;
  relayer: string;
  feeRecipient: string;
  /** Strip every role from the deployer once the real holders are in place. */
  revokeDeployer: boolean;
}

function addr(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!ethers.isAddress(raw)) {
    throw new Error(`${name}=${raw} is not a valid address`);
  }
  if (raw === ethers.ZeroAddress) {
    throw new Error(`${name} must not be the zero address`);
  }
  return ethers.getAddress(raw);
}

export function loadRoleConfig(deployer: string): RoleConfig {
  return {
    admin: addr("ADMIN_ADDRESS", deployer),
    upgrader: addr("UPGRADER_ADDRESS", addr("ADMIN_ADDRESS", deployer)),
    pauser: addr("PAUSER_ADDRESS", addr("ADMIN_ADDRESS", deployer)),
    blacklister: addr("BLACKLISTER_ADDRESS", addr("ADMIN_ADDRESS", deployer)),
    minter: addr("MINTER_ADDRESS", deployer),
    operator: addr("OPERATOR_ADDRESS", addr("ADMIN_ADDRESS", deployer)),
    relayer: addr("RELAYER_ADDRESS", deployer),
    feeRecipient: addr("FEE_RECIPIENT_ADDRESS", addr("ADMIN_ADDRESS", deployer)),
    revokeDeployer: process.env.REVOKE_DEPLOYER_ROLES === "true",
  };
}

export function describeRoles(cfg: RoleConfig, deployer: string): void {
  const mark = (a: string) => (a === deployer ? " (deployer)" : "");
  console.log("\n  Role assignment:");
  console.log(`    admin        ${cfg.admin}${mark(cfg.admin)}`);
  console.log(`    upgrader     ${cfg.upgrader}${mark(cfg.upgrader)}`);
  console.log(`    operator     ${cfg.operator}${mark(cfg.operator)}`);
  console.log(`    pauser       ${cfg.pauser}${mark(cfg.pauser)}`);
  console.log(`    blacklister  ${cfg.blacklister}${mark(cfg.blacklister)}`);
  console.log(`    minter       ${cfg.minter}${mark(cfg.minter)}`);
  console.log(`    relayer      ${cfg.relayer}${mark(cfg.relayer)}`);
  console.log(`    feeRecipient ${cfg.feeRecipient}${mark(cfg.feeRecipient)}`);
  console.log(`    revoke deployer roles when done: ${cfg.revokeDeployer}`);
}

export type Assignment = { role: string; name: string; holder: string };

/** Grant each role to its configured holder. Deployer keeps everything for now. */
export async function grantRoles(
  contract: any,
  assignments: Assignment[]
): Promise<void> {
  for (const { role, name, holder } of assignments) {
    if (await contract.hasRole(role, holder)) {
      console.log(`    ${name}: already held by ${holder}`);
      continue;
    }
    await (await contract.grantRole(role, holder)).wait();
    console.log(`    ${name}: granted to ${holder}`);
  }
}

/**
 * Strip the deployer's roles once the real holders are in place.
 *
 * Call this LAST — after every admin-only configuration step, since the
 * deployer loses DEFAULT_ADMIN_ROLE here. That role is revoked only after
 * confirming the incoming admin actually holds it; doing it in the other order
 * leaves the contract with nobody able to grant anything, permanently.
 */
export async function revokeDeployerRoles(
  contract: any,
  assignments: Assignment[],
  deployer: string,
  enabled: boolean
): Promise<void> {
  if (!enabled) {
    console.log("    (deployer retains its roles — set REVOKE_DEPLOYER_ROLES=true to strip them)");
    return;
  }

  // Validate before revoking anything. A partial revocation is its own outage:
  // strip MINTER_ROLE from the deployer while the intended minter never got it
  // and nobody can mint until an admin intervenes.
  const orphaned: string[] = [];
  for (const { role, name, holder } of assignments) {
    if (holder === deployer) continue;
    if (!(await contract.hasRole(role, holder))) orphaned.push(`${name} → ${holder}`);
  }
  if (orphaned.length > 0) {
    throw new Error(
      `Refusing to revoke: intended holders do not have their roles yet ` +
        `(${orphaned.join(", ")}). Run grantRoles first. ` +
        `Revoking now would leave the contract with no administrator or no minter.`
    );
  }

  for (const { role, name, holder } of assignments) {
    if (role === ROLE.DEFAULT_ADMIN || holder === deployer) continue;
    if (!(await contract.hasRole(role, deployer))) continue;
    await (await contract.revokeRole(role, deployer)).wait();
    console.log(`    ${name}: revoked from deployer`);
  }

  // Admin last: until this point the deployer is what makes the steps above
  // possible, and after it the deployer can undo nothing.
  const admin = assignments.find((a) => a.role === ROLE.DEFAULT_ADMIN)?.holder;
  if (!admin || admin === deployer) return;
  await (await contract.revokeRole(ROLE.DEFAULT_ADMIN, deployer)).wait();
  console.log(`    admin: revoked from deployer — ${admin} is now sole admin`);
}
