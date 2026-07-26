import { ethers } from "ethers";
import {
  RelayerConfig,
  BridgeBurnEvent,
  MintAttestation,
} from "./types";

const BRIDGE_POLYGON_ABI = [
  "function claimMint(uint256 hederaNonce, address polygonRecipient, uint256 amount, uint256 deadline, bytes[] signatures) external",
  "function isNonceClaimed(uint256 nonce) external view returns (bool)",
  "function claims(uint256 nonce) external view returns (address recipient, uint256 amount, uint256 hederaNonce, uint256 claimedAt)",
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
    const chainId = Number(network.chainId);

    if (chainId !== this.config.polygonChainId) {
      throw new Error(
        `POLYGON_CHAIN_ID=${this.config.polygonChainId} but POLYGON_RPC_URL reports ` +
          `chainId ${chainId}. Refusing to start.`
      );
    }

    const code = await this.provider.getCode(this.config.polygonBridgeAddress);
    if (code === "0x") {
      throw new Error(
        `No contract at POLYGON_BRIDGE_ADDRESS=${this.config.polygonBridgeAddress} ` +
          `on chain ${chainId}. Refusing to start.`
      );
    }

    this.EIP712_DOMAIN.chainId = chainId;
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

  /** What was actually minted for a nonce, for cross-checking against the burn. */
  async getClaim(nonce: bigint): Promise<{ recipient: string; amount: bigint }> {
    const claim = await this.bridgeContract.claims(nonce);
    return { recipient: claim.recipient, amount: claim.amount };
  }
}
