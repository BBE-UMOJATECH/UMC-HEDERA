import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { UMCToken } from "../typechain-types";

describe("UMCToken", function () {
  let umc: UMCToken;
  let admin: SignerWithAddress;
  let minter: SignerWithAddress;
  let pauser: SignerWithAddress;
  let blacklister: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const DECIMALS = 6;
  const SUPPLY_CAP = ethers.parseUnits("1000000000", DECIMALS); // $1B
  const MINTER_ALLOWANCE = ethers.parseUnits("100000000", DECIMALS); // $100M
  const MINT_AMOUNT = ethers.parseUnits("1000000", DECIMALS); // $1M

  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
  const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
  const BLACKLISTER_ROLE = ethers.keccak256(
    ethers.toUtf8Bytes("BLACKLISTER_ROLE")
  );
  const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));

  beforeEach(async function () {
    [admin, minter, pauser, blacklister, user1, user2] =
      await ethers.getSigners();

    const UMCFactory = await ethers.getContractFactory("UMCToken");
    umc = (await upgrades.deployProxy(UMCFactory, [admin.address, SUPPLY_CAP], {
      initializer: "initialize",
      kind: "uups",
    })) as unknown as UMCToken;
    await umc.waitForDeployment();

    // Grant roles
    await umc.connect(admin).grantRole(MINTER_ROLE, minter.address);
    await umc.connect(admin).grantRole(PAUSER_ROLE, pauser.address);
    await umc.connect(admin).grantRole(BLACKLISTER_ROLE, blacklister.address);

    // Set minter allowance
    await umc.connect(admin).setMinterAllowance(minter.address, MINTER_ALLOWANCE);
  });

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  describe("Initialization", function () {
    it("should have correct name and symbol", async function () {
      expect(await umc.name()).to.equal("UMC Stablecoin");
      expect(await umc.symbol()).to.equal("UMC");
    });

    it("should have 6 decimals", async function () {
      expect(await umc.decimals()).to.equal(6);
    });

    it("should set the correct supply cap", async function () {
      expect(await umc.supplyCap()).to.equal(SUPPLY_CAP);
    });

    it("should assign all roles to admin", async function () {
      const DEFAULT_ADMIN = ethers.ZeroHash;
      expect(await umc.hasRole(DEFAULT_ADMIN, admin.address)).to.be.true;
      expect(await umc.hasRole(MINTER_ROLE, admin.address)).to.be.true;
      expect(await umc.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
      expect(await umc.hasRole(BLACKLISTER_ROLE, admin.address)).to.be.true;
      expect(await umc.hasRole(UPGRADER_ROLE, admin.address)).to.be.true;
    });

    it("should not allow re-initialization", async function () {
      await expect(
        umc.initialize(admin.address, SUPPLY_CAP)
      ).to.be.revertedWithCustomError(umc, "InvalidInitialization");
    });

    it("should revert if initialized with zero address", async function () {
      const UMCFactory = await ethers.getContractFactory("UMCToken");
      await expect(
        upgrades.deployProxy(
          UMCFactory,
          [ethers.ZeroAddress, SUPPLY_CAP],
          { initializer: "initialize", kind: "uups" }
        )
      ).to.be.revertedWithCustomError(umc, "InvalidAddress");
    });

    it("should revert if initialized with zero cap", async function () {
      const UMCFactory = await ethers.getContractFactory("UMCToken");
      await expect(
        upgrades.deployProxy(UMCFactory, [admin.address, 0], {
          initializer: "initialize",
          kind: "uups",
        })
      ).to.be.revertedWithCustomError(umc, "InvalidCap");
    });
  });

  // ===========================================================================
  // MINTING
  // ===========================================================================

  describe("Minting", function () {
    it("should allow minter to mint within allowance", async function () {
      await umc.connect(minter).mint(user1.address, MINT_AMOUNT);
      expect(await umc.balanceOf(user1.address)).to.equal(MINT_AMOUNT);
    });

    it("should emit Mint event", async function () {
      await expect(umc.connect(minter).mint(user1.address, MINT_AMOUNT))
        .to.emit(umc, "Mint")
        .withArgs(minter.address, user1.address, MINT_AMOUNT);
    });

    it("should decrease minter allowance after minting", async function () {
      await umc.connect(minter).mint(user1.address, MINT_AMOUNT);
      const remaining = await umc.minterAllowance(minter.address);
      expect(remaining).to.equal(MINTER_ALLOWANCE - MINT_AMOUNT);
    });

    it("should revert if exceeding minter allowance", async function () {
      const overAllowance = MINTER_ALLOWANCE + 1n;
      await expect(
        umc.connect(minter).mint(user1.address, overAllowance)
      ).to.be.revertedWithCustomError(umc, "MinterAllowanceExceeded");
    });

    it("should revert if exceeding supply cap", async function () {
      // Set huge allowance for minter
      await umc.connect(admin).setMinterAllowance(minter.address, SUPPLY_CAP + 1n);
      await umc.connect(minter).mint(user1.address, SUPPLY_CAP);

      await umc.connect(admin).setMinterAllowance(minter.address, SUPPLY_CAP);
      await expect(
        umc.connect(minter).mint(user1.address, 1n)
      ).to.be.revertedWithCustomError(umc, "SupplyCapExceeded");
    });

    it("should revert if non-minter tries to mint", async function () {
      await expect(
        umc.connect(user1).mint(user1.address, MINT_AMOUNT)
      ).to.be.revertedWithCustomError(umc, "AccessControlUnauthorizedAccount");
    });

    it("should revert minting to zero address", async function () {
      await expect(
        umc.connect(minter).mint(ethers.ZeroAddress, MINT_AMOUNT)
      ).to.be.revertedWithCustomError(umc, "InvalidAddress");
    });

    it("should revert minting zero amount", async function () {
      await expect(
        umc.connect(minter).mint(user1.address, 0)
      ).to.be.revertedWithCustomError(umc, "InvalidAmount");
    });

    it("should revert minting to blacklisted address", async function () {
      await umc.connect(blacklister).blacklist(user1.address);
      await expect(
        umc.connect(minter).mint(user1.address, MINT_AMOUNT)
      ).to.be.revertedWithCustomError(umc, "AccountBlacklisted");
    });
  });

  // ===========================================================================
  // BURNING
  // ===========================================================================

  describe("Burning", function () {
    beforeEach(async function () {
      await umc.connect(minter).mint(user1.address, MINT_AMOUNT);
    });

    it("should allow token holder to burn their tokens", async function () {
      const burnAmount = ethers.parseUnits("500000", DECIMALS);
      await umc.connect(user1).burn(burnAmount);
      expect(await umc.balanceOf(user1.address)).to.equal(
        MINT_AMOUNT - burnAmount
      );
    });

    it("should emit Burn event", async function () {
      const burnAmount = ethers.parseUnits("500000", DECIMALS);
      await expect(umc.connect(user1).burn(burnAmount))
        .to.emit(umc, "Burn")
        .withArgs(user1.address, burnAmount);
    });

    it("should revert burning zero amount", async function () {
      await expect(
        umc.connect(user1).burn(0)
      ).to.be.revertedWithCustomError(umc, "InvalidAmount");
    });
  });

  // ===========================================================================
  // BLACKLISTING
  // ===========================================================================

  describe("Blacklisting", function () {
    beforeEach(async function () {
      await umc.connect(minter).mint(user1.address, MINT_AMOUNT);
    });

    it("should prevent blacklisted address from transferring", async function () {
      await umc.connect(blacklister).blacklist(user1.address);
      await expect(
        umc.connect(user1).transfer(user2.address, 100n)
      ).to.be.revertedWithCustomError(umc, "AccountBlacklisted");
    });

    it("should prevent transfers TO blacklisted address", async function () {
      await umc.connect(blacklister).blacklist(user2.address);
      await expect(
        umc.connect(user1).transfer(user2.address, 100n)
      ).to.be.revertedWithCustomError(umc, "AccountBlacklisted");
    });

    it("should allow unblacklisted address to transfer again", async function () {
      await umc.connect(blacklister).blacklist(user1.address);
      await umc.connect(blacklister).unBlacklist(user1.address);
      await umc.connect(user1).transfer(user2.address, 100n);
      expect(await umc.balanceOf(user2.address)).to.equal(100n);
    });

    it("should emit Blacklisted/UnBlacklisted events", async function () {
      await expect(umc.connect(blacklister).blacklist(user1.address))
        .to.emit(umc, "Blacklisted")
        .withArgs(user1.address);

      await expect(umc.connect(blacklister).unBlacklist(user1.address))
        .to.emit(umc, "UnBlacklisted")
        .withArgs(user1.address);
    });

    it("should revert if non-blacklister tries to blacklist", async function () {
      await expect(
        umc.connect(user1).blacklist(user2.address)
      ).to.be.revertedWithCustomError(umc, "AccessControlUnauthorizedAccount");
    });

    it("isBlacklisted should return correct status", async function () {
      expect(await umc.isBlacklisted(user1.address)).to.be.false;
      await umc.connect(blacklister).blacklist(user1.address);
      expect(await umc.isBlacklisted(user1.address)).to.be.true;
    });
  });

  // ===========================================================================
  // PAUSE / UNPAUSE
  // ===========================================================================

  describe("Pause", function () {
    beforeEach(async function () {
      await umc.connect(minter).mint(user1.address, MINT_AMOUNT);
    });

    it("should prevent transfers when paused", async function () {
      await umc.connect(pauser).pause();
      await expect(
        umc.connect(user1).transfer(user2.address, 100n)
      ).to.be.revertedWithCustomError(umc, "EnforcedPause");
    });

    it("should allow transfers after unpausing", async function () {
      await umc.connect(pauser).pause();
      await umc.connect(pauser).unpause();
      await umc.connect(user1).transfer(user2.address, 100n);
      expect(await umc.balanceOf(user2.address)).to.equal(100n);
    });

    it("should revert if non-pauser tries to pause", async function () {
      await expect(
        umc.connect(user1).pause()
      ).to.be.revertedWithCustomError(umc, "AccessControlUnauthorizedAccount");
    });
  });

  // ===========================================================================
  // SUPPLY CAP
  // ===========================================================================

  describe("Supply Cap", function () {
    it("should allow admin to increase supply cap", async function () {
      const newCap = ethers.parseUnits("2000000000", DECIMALS);
      await expect(umc.connect(admin).setSupplyCap(newCap))
        .to.emit(umc, "SupplyCapUpdated")
        .withArgs(SUPPLY_CAP, newCap);
      expect(await umc.supplyCap()).to.equal(newCap);
    });

    it("should revert setting cap below current supply", async function () {
      await umc.connect(minter).mint(user1.address, MINT_AMOUNT);
      await expect(
        umc.connect(admin).setSupplyCap(MINT_AMOUNT - 1n)
      ).to.be.revertedWithCustomError(umc, "InvalidCap");
    });

    it("should revert if non-admin sets supply cap", async function () {
      await expect(
        umc.connect(user1).setSupplyCap(SUPPLY_CAP)
      ).to.be.revertedWithCustomError(umc, "AccessControlUnauthorizedAccount");
    });
  });

  // ===========================================================================
  // MINTER ALLOWANCE
  // ===========================================================================

  describe("Minter Allowance", function () {
    it("should allow admin to set minter allowance", async function () {
      const newAllowance = ethers.parseUnits("50000000", DECIMALS);
      await expect(
        umc.connect(admin).setMinterAllowance(minter.address, newAllowance)
      )
        .to.emit(umc, "MinterAllowanceSet")
        .withArgs(minter.address, newAllowance);
    });

    it("should revert setting allowance for non-minter", async function () {
      await expect(
        umc
          .connect(admin)
          .setMinterAllowance(
            user1.address,
            ethers.parseUnits("1000", DECIMALS)
          )
      ).to.be.revertedWithCustomError(umc, "InvalidAddress");
    });

    it("should revert setting allowance for zero address", async function () {
      await expect(
        umc
          .connect(admin)
          .setMinterAllowance(ethers.ZeroAddress, 1000n)
      ).to.be.revertedWithCustomError(umc, "InvalidAddress");
    });
  });

  // ===========================================================================
  // UPGRADEABILITY
  // ===========================================================================

  describe("Upgradeability", function () {
    it("should allow upgrader to upgrade the contract", async function () {
      const UMCFactoryV2 = await ethers.getContractFactory("UMCToken");
      const upgraded = await upgrades.upgradeProxy(
        await umc.getAddress(),
        UMCFactoryV2.connect(admin)
      );
      expect(await upgraded.name()).to.equal("UMC Stablecoin");
    });

    it("should revert if non-upgrader tries to upgrade", async function () {
      const UMCFactoryV2 = await ethers.getContractFactory("UMCToken");
      await expect(
        upgrades.upgradeProxy(
          await umc.getAddress(),
          UMCFactoryV2.connect(user1)
        )
      ).to.be.reverted;
    });
  });

  // ===========================================================================
  // TRANSFERS
  // ===========================================================================

  describe("Transfers", function () {
    beforeEach(async function () {
      await umc.connect(minter).mint(user1.address, MINT_AMOUNT);
    });

    it("should transfer tokens between accounts", async function () {
      const amount = ethers.parseUnits("1000", DECIMALS);
      await umc.connect(user1).transfer(user2.address, amount);
      expect(await umc.balanceOf(user2.address)).to.equal(amount);
      expect(await umc.balanceOf(user1.address)).to.equal(
        MINT_AMOUNT - amount
      );
    });

    it("should handle approve and transferFrom", async function () {
      const amount = ethers.parseUnits("1000", DECIMALS);
      await umc.connect(user1).approve(user2.address, amount);
      await umc
        .connect(user2)
        .transferFrom(user1.address, user2.address, amount);
      expect(await umc.balanceOf(user2.address)).to.equal(amount);
    });
  });
});
