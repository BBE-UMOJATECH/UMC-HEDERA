import { ethers } from "ethers";
import {
  RelayerConfig,
  BridgeBurnEvent,
  MintAttestation,
} from "./types";

const BRIDGE_POLYGON_ABI = [
  "function claimMint(uint256 hederaNonce, address polygonRecipient, uint256 amount, uint256 deadline, bytes[] signatures) external",
  "function isNonceClaimed(uint256 nonce) external view returns (bool)",
  "function computeMintDigest(uint256 hederaNonce, address polygonRecipient, uint256 amount, uint256 deadline) external view returns (bytes32)",
];

/**
 * PolygonMinter signs EIP-712 attestations and submits
 * claimMint transactions on Polygon.
 */
export class PolygonMinter {
  private config: RelayerConfig;
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private bridgeContract: ethers.Contract;

  private readonly EIP712_DOMAIN = {
    name: "UMCBridge",
    version: "1",
    chainId: 0,
    verifyingContract: "",
  };

  private readonly MINT_TYPES = {
    MintAttestation: [
      { name: "hederaNonce", type: "uint256" },
      { name: "polygonRecipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  constructor(config: RelayerConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
    this.signer = new ethers.Wallet(config.polygonRelayerPrivateKey, this.provider);
    this.bridgeContract = new ethers.Contract(
      config.polygonBridgeAddress,
      BRIDGE_POLYGON_ABI,
      this.signer
    );
  }

  async initialize(): Promise<void> {
    const network = await this.provider.getNetwork();
    this.EIP712_DOMAIN.chainId = Number(network.chainId);
    this.EIP712_DOMAIN.verifyingContract = this.config.polygonBridgeAddress;

    console.log("[PolygonMinter] Chain:", network.chainId.toString());
    console.log("[PolygonMinter] Relayer:", this.signer.address);
    console.log("[PolygonMinter] Bridge:", this.config.polygonBridgeAddress);

    const balance = await this.provider.getBalance(this.signer.address);
    console.log("[PolygonMinter] POL balance:", ethers.formatEther(balance));
  }

  /**
   * Sign an EIP-712 mint attestation for a detected burn event.
   */
  async signAttestation(burnEvent: BridgeBurnEvent): Promise<MintAttestation> {
    const deadline = BigInt(Math.floor(Date.now() / 1000)) +
      BigInt(this.config.attestationTtlSeconds);

    const value = {
      hederaNonce: burnEvent.nonce,
      polygonRecipient: burnEvent.polygonRecipient,
      amount: burnEvent.netAmount,
      deadline,
    };

    const signature = await this.signer.signTypedData(
      this.EIP712_DOMAIN,
      this.MINT_TYPES,
      value
    );

    console.log(
      `[PolygonMinter] Signed nonce ${burnEvent.nonce} -> ${burnEvent.polygonRecipient} (${ethers.formatUnits(burnEvent.netAmount, 6)} UMC)`
    );

    return {
      hederaNonce: burnEvent.nonce,
      polygonRecipient: burnEvent.polygonRecipient,
      amount: burnEvent.netAmount,
      deadline,
      signature,
    };
  }

  /**
   * Submit claimMint tx on Polygon.
   */
  async submitMint(attestation: MintAttestation): Promise<string> {
    const alreadyClaimed = await this.bridgeContract.isNonceClaimed(attestation.hederaNonce);
    if (alreadyClaimed) {
      console.log(`[PolygonMinter] Nonce ${attestation.hederaNonce} already claimed`);
      return "";
    }

    console.log(`[PolygonMinter] Submitting mint nonce ${attestation.hederaNonce}...`);

    const tx = await this.bridgeContract.claimMint(
      attestation.hederaNonce,
      attestation.polygonRecipient,
      attestation.amount,
      attestation.deadline,
      [attestation.signature],
      { gasLimit: 500_000 }
    );

    console.log(`[PolygonMinter] Tx: ${tx.hash}`);
    const receipt = await tx.wait(2);
    console.log(`[PolygonMinter] Confirmed block ${receipt!.blockNumber}`);

    return tx.hash;
  }

  async isNonceClaimed(nonce: bigint): Promise<boolean> {
    return this.bridgeContract.isNonceClaimed(nonce);
  }
}
