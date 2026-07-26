import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { UMCToken } from "../typechain-types";
import { ROLE, grantRoles, revokeDeployerRoles, Assignment } from "../scripts/roles";

describe("role handover", function () {
  let token: UMCToken;
  let deployer: SignerWithAddress;
  let admin: SignerWithAddress;
  let upgrader: SignerWithAddress;
  let minter: SignerWithAddress;
  let assignments: Assignment[];

  beforeEach(async function () {
    [deployer, admin, upgrader, minter] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("UMCToken");
    token = (await upgrades.deployProxy(
      Factory,
      [deployer.address, ethers.parseUnits("1000000000", 6)],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as UMCToken;
    await token.waitForDeployment();

    assignments = [
      { role: ROLE.MINTER, name: "minter", holder: minter.address },
      { role: ROLE.UPGRADER, name: "upgrader", holder: upgrader.address },
      { role: ROLE.DEFAULT_ADMIN, name: "admin", holder: admin.address },
    ];
  });

  it("grants each role to its configured holder", async function () {
    await grantRoles(token, assignments);

    expect(await token.hasRole(ROLE.MINTER, minter.address)).to.equal(true);
    expect(await token.hasRole(ROLE.UPGRADER, upgrader.address)).to.equal(true);
    expect(await token.hasRole(ROLE.DEFAULT_ADMIN, admin.address)).to.equal(true);
  });

  it("leaves the deployer alone when revocation is disabled", async function () {
    await grantRoles(token, assignments);
    await revokeDeployerRoles(token, assignments, deployer.address, false);

    expect(await token.hasRole(ROLE.DEFAULT_ADMIN, deployer.address)).to.equal(true);
    expect(await token.hasRole(ROLE.MINTER, deployer.address)).to.equal(true);
  });

  it("strips every deployer role once real holders are in place", async function () {
    await grantRoles(token, assignments);
    await revokeDeployerRoles(token, assignments, deployer.address, true);

    expect(await token.hasRole(ROLE.MINTER, deployer.address)).to.equal(false);
    expect(await token.hasRole(ROLE.UPGRADER, deployer.address)).to.equal(false);
    expect(await token.hasRole(ROLE.DEFAULT_ADMIN, deployer.address)).to.equal(false);

    // The new admin must still be able to administer the contract afterwards.
    expect(await token.hasRole(ROLE.DEFAULT_ADMIN, admin.address)).to.equal(true);
    await expect(token.connect(admin).grantRole(ROLE.PAUSER, deployer.address)).to.not.be.reverted;
  });

  it("refuses to revoke anything if the intended holders lack their roles", async function () {
    // Roles were never granted. Revoking here would leave the contract with no
    // administrator at all, which is unrecoverable — and a partial revocation
    // (minter stripped, no replacement) is an outage of its own.
    await expect(
      revokeDeployerRoles(token, assignments, deployer.address, true)
    ).to.be.rejectedWith(/Refusing to revoke/);

    // Nothing may have been touched before the check failed.
    expect(await token.hasRole(ROLE.DEFAULT_ADMIN, deployer.address)).to.equal(true);
    expect(await token.hasRole(ROLE.MINTER, deployer.address)).to.equal(true);
    expect(await token.hasRole(ROLE.UPGRADER, deployer.address)).to.equal(true);
  });
});
