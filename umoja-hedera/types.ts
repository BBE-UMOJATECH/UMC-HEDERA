export interface RelayerConfig {
  // Hedera
  hederaOperatorId: string;
  hederaOperatorKey: string;
  hederaNetwork: "testnet" | "mainnet";
  hederaBridgeContractId: string;

  // Polygon
  polygonRpcUrl: string;
  polygonBridgeAddress: string;
  polygonRelayerPrivateKey: string; // EIP-712 signing key
  polygonChainId: number;

  // Relayer settings
  pollIntervalMs: number;
  confirmationsRequired: number;
  maxRetries: number;
  retryDelayMs: number;
  attestationTtlSeconds: number; // How long mint attestations are valid

  // Database (for persistence)
  databaseUrl: string;
}

export interface BridgeBurnEvent {
  nonce: bigint;
  hederaSender: string;
  polygonRecipient: string;
  amount: bigint;
  fee: bigint;
  netAmount: bigint;
  timestamp: bigint;
  transactionId: string;
}

export interface MintAttestation {
  hederaNonce: bigint;
  polygonRecipient: string;
  amount: bigint;
  deadline: bigint;
  signature: string;
}

export enum BridgeRequestStatus {
  DETECTED = "DETECTED",
  CONFIRMED = "CONFIRMED",
  ATTESTATION_SIGNED = "ATTESTATION_SIGNED",
  MINT_SUBMITTED = "MINT_SUBMITTED",
  MINT_CONFIRMED = "MINT_CONFIRMED",
  FAILED = "FAILED",
}

export interface BridgeRequest {
  nonce: bigint;
  hederaSender: string;
  polygonRecipient: string;
  grossAmount: bigint;
  fee: bigint;
  netAmount: bigint;
  hederaTxId: string;
  status: BridgeRequestStatus;
  attestation?: MintAttestation;
  polygonTxHash?: string;
  retries: number;
  createdAt: Date;
  updatedAt: Date;
  error?: string;
}
