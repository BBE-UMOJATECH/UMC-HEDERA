import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { UMCBridgePolygon, UMCToken } from "../typechain-types";

describe("UMCBridgePolygon", function () {
  let token: UMCToken;
  let bridge: UMCBridgePolygon;
  let admin: SignerWithAddress;
  let relayer: SignerWithAddress;
  let relayerTwo: SignerWithAddress;
  let recipient: SignerWithAddress;

  const DECIMALS = 6;
  const CLAIM_WINDOW = 86_400n;
  const TOKEN_SUPPLY_CAP = ethers.parseUnits("1000000000", DECIMALS);
  const BRIDGE_ALLOWANCE = ethers.parseUnits("100000000", DECIMALS);
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));

  const mintTypes = {
    MintAttestation: [
      { name: "hederaNonce", type: "uint256" },
      { name: "polygonRecipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  beforeEach(async function () {
    [admin, relayer, relayerTwo, recipient] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory("UMCToken");
    token = (await upgrades.deployProxy(
      TokenFactory,
      [admin.address, TOKEN_SUPPLY_CAP],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as UMCToken;
    await token.waitForDeployment();

    const BridgeFactory = await ethers.getContractFactory("UMCBridgePolygon");
    bridge = (await upgrades.deployProxy(
      BridgeFactory,
      [await token.getAddress(), admin.address, relayer.address, CLAIM_WINDOW],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as UMCBridgePolygon;
    await bridge.waitForDeployment();

    await token.connect(admin).grantRole(MINTER_ROLE, await bridge.getAddress());
    await token.connect(admin).setMinterAllowance(await bridge.getAddress(), BRIDGE_ALLOWANCE);
  });

  async function signMintAttestation(
    signer: SignerWithAddress,
    hederaNonce: bigint,
    polygonRecipient: string,
    amount: bigint,
    deadline: bigint
  ): Promise<string> {
    const network = await ethers.provider.getNetwork();
    return signer.signTypedData(
      {
        name: "UMCBridge",
        version: "1",
        chainId: Number(network.chainId),
        verifyingContract: await bridge.getAddress(),
      },
      mintTypes,
      {
        hederaNonce,
        polygonRecipient,
        amount,
        deadline,
      }
    );
  }

  describe("Signature configuration", function () {
    it("rejects zero required signatures", async function () {
      await expect(
        bridge.connect(admin).setSignatureConfig(0, ethers.parseUnits("1000", DECIMALS), 1)
      ).to.be.revertedWithCustomError(bridge, "InvalidSignatureConfig");
    });

    it("rejects zero required signatures for high-value claims", async function () {
      await expect(
        bridge.connect(admin).setSignatureConfig(1, ethers.parseUnits("1000", DECIMALS), 0)
      ).to.be.revertedWithCustomError(bridge, "InvalidSignatureConfig");
    });

    it("rejects high-value quorum below the base quorum", async function () {
      await expect(
        bridge.connect(admin).setSignatureConfig(2, ethers.parseUnits("1000", DECIMALS), 1)
      ).to.be.revertedWithCustomError(bridge, "InvalidSignatureConfig");
    });
  });

  describe("Claim window", function () {
    it("rejects zero claim window updates", async function () {
      await expect(
        bridge.connect(admin).setClaimWindow(0)
      ).to.be.revertedWithCustomError(bridge, "InvalidClaimWindow");
    });

    it("rejects attestations whose deadline exceeds the configured claim window", async function () {
      await bridge.connect(admin).setClaimWindow(60);

      const amount = ethers.parseUnits("10", DECIMALS);
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = BigInt(latestBlock!.timestamp) + 3_600n;
      const signature = await signMintAttestation(
        relayer,
        1n,
        recipient.address,
        amount,
        deadline
      );

      await expect(
        bridge
          .connect(recipient)
          .claimMint(1n, recipient.address, amount, deadline, [signature])
      ).to.be.revertedWithCustomError(bridge, "DeadlineExceedsClaimWindow");
    });

    it("allows a valid claim whose deadline is within the configured window", async function () {
      const amount = ethers.parseUnits("10", DECIMALS);
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = BigInt(latestBlock!.timestamp) + CLAIM_WINDOW;
      const signature = await signMintAttestation(
        relayer,
        2n,
        recipient.address,
        amount,
        deadline
      );

      await bridge
        .connect(recipient)
        .claimMint(2n, recipient.address, amount, deadline, [signature]);

      expect(await token.balanceOf(recipient.address)).to.equal(amount);
      expect(await bridge.isNonceClaimed(2n)).to.equal(true);
    });
  });
});
