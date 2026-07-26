import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { UMCBridgeHedera, UMCToken } from "../typechain-types";

describe("UMCBridgeHedera", function () {
  let token: UMCToken;
  let bridge: UMCBridgeHedera;
  let admin: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let user: SignerWithAddress;

  const DECIMALS = 6;
  const umc = (n: string) => ethers.parseUnits(n, DECIMALS);

  const SUPPLY_CAP = umc("1000000000");
  const MIN_BRIDGE = umc("1");
  const MAX_BRIDGE = umc("100000");
  const FEE_BPS = 25n; // 0.25%
  const DAILY_LIMIT = umc("1000000");
  const POLYGON_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

  beforeEach(async function () {
    [admin, feeRecipient, user] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory("UMCToken");
    token = (await upgrades.deployProxy(
      TokenFactory,
      [admin.address, SUPPLY_CAP],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as UMCToken;
    await token.waitForDeployment();

    const BridgeFactory = await ethers.getContractFactory("UMCBridgeHedera");
    bridge = (await upgrades.deployProxy(
      BridgeFactory,
      [
        await token.getAddress(),
        admin.address,
        feeRecipient.address,
        MIN_BRIDGE,
        MAX_BRIDGE,
        FEE_BPS,
        DAILY_LIMIT,
      ],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as UMCBridgeHedera;
    await bridge.waitForDeployment();

    await token.setMinterAllowance(admin.address, SUPPLY_CAP);
    await token.mint(user.address, umc("1000"));
  });

  it("pays the fee to feeRecipient and burns only the net amount", async function () {
    const gross = umc("100");
    const fee = (gross * FEE_BPS) / 10_000n;
    const net = gross - fee;

    await token.connect(user).approve(await bridge.getAddress(), gross);

    const supplyBefore = await token.totalSupply();
    await bridge.connect(user).bridgeToPolygon(POLYGON_RECIPIENT, gross);

    // The fee must land on-chain, not be destroyed and owed off-chain.
    expect(await token.balanceOf(feeRecipient.address)).to.equal(fee);
    expect(await token.balanceOf(user.address)).to.equal(umc("1000") - gross);

    // Burned on Hedera must equal what gets minted on Polygon, or the peg drifts.
    const burned = supplyBefore - (await token.totalSupply());
    expect(burned).to.equal(net);

    const record = await bridge.getBurnRecord(0);
    expect(record.netAmount).to.equal(net);
    expect(record.fee).to.equal(fee);
    expect(record.polygonRecipient).to.equal(POLYGON_RECIPIENT);
  });

  it("emits BridgeBurn with an incrementing nonce", async function () {
    const gross = umc("10");
    await token.connect(user).approve(await bridge.getAddress(), gross * 2n);

    await expect(bridge.connect(user).bridgeToPolygon(POLYGON_RECIPIENT, gross))
      .to.emit(bridge, "BridgeBurn")
      .withArgs(0, user.address, POLYGON_RECIPIENT, gross, anyFee(gross), anyNet(gross), anyTimestamp());

    await bridge.connect(user).bridgeToPolygon(POLYGON_RECIPIENT, gross);
    expect(await bridge.bridgeNonce()).to.equal(2);
  });

  it("rejects amounts outside the configured bounds", async function () {
    await token.connect(user).approve(await bridge.getAddress(), MAX_BRIDGE * 2n);

    await expect(
      bridge.connect(user).bridgeToPolygon(POLYGON_RECIPIENT, MIN_BRIDGE - 1n)
    ).to.be.revertedWithCustomError(bridge, "BelowMinimum");

    await expect(
      bridge.connect(user).bridgeToPolygon(POLYGON_RECIPIENT, MAX_BRIDGE + 1n)
    ).to.be.revertedWithCustomError(bridge, "AboveMaximum");
  });

  it("requires an allowance covering the full gross amount", async function () {
    const gross = umc("100");
    // Enough for the net burn but not the fee transfer — must not half-execute.
    await token.connect(user).approve(await bridge.getAddress(), gross - 1n);

    await expect(
      bridge.connect(user).bridgeToPolygon(POLYGON_RECIPIENT, gross)
    ).to.be.revertedWithCustomError(bridge, "InsufficientAllowance");
  });

  // Helpers for the loosely-checked event args.
  function anyFee(gross: bigint) {
    return (gross * FEE_BPS) / 10_000n;
  }
  function anyNet(gross: bigint) {
    return gross - anyFee(gross);
  }
  function anyTimestamp() {
    return (v: bigint) => v > 0n;
  }
});
