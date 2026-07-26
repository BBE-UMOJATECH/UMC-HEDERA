import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const [admin] = await ethers.getSigners();

  const tokenAddress = process.env.UMC_TOKEN_ADDRESS;
  const newMinter = process.env.NEW_MINTER_ADDRESS;
  const revokeMinter = process.env.REVOKE_MINTER_ADDRESS;
  const allowance = process.env.MINTER_ALLOWANCE;

  if (!tokenAddress) {
    throw new Error("UMC_TOKEN_ADDRESS is required");
  }
  if (!newMinter) {
    throw new Error("NEW_MINTER_ADDRESS is required");
  }

  const token = await ethers.getContractAt("UMCToken", tokenAddress);
  const minterRole = await token.MINTER_ROLE();

  console.log("Admin:", admin.address);
  console.log("Token:", tokenAddress);
  console.log("New minter:", newMinter);
  if (revokeMinter) console.log("Revoke minter:", revokeMinter);
  if (allowance) console.log("Allowance (UMC units):", allowance);

  const hasRole = await token.hasRole(minterRole, newMinter);
  if (!hasRole) {
    console.log("Granting MINTER_ROLE...");
    const tx = await token.grantRole(minterRole, newMinter);
    console.log("Tx:", tx.hash);
    await tx.wait();
  } else {
    console.log("New minter already has MINTER_ROLE");
  }

  if (allowance) {
    const parsed = ethers.parseUnits(allowance, 6);
    console.log("Setting minter allowance...");
    const tx = await token.setMinterAllowance(newMinter, parsed);
    console.log("Tx:", tx.hash);
    await tx.wait();
  }

  if (revokeMinter) {
    const revokeHasRole = await token.hasRole(minterRole, revokeMinter);
    if (revokeHasRole) {
      console.log("Revoking MINTER_ROLE...");
      const tx = await token.revokeRole(minterRole, revokeMinter);
      console.log("Tx:", tx.hash);
      await tx.wait();
    } else {
      console.log("Revoke address does not have MINTER_ROLE");
    }
  }

  console.log("Done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
