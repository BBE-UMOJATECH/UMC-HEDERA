# umoja-hedera

Smart contracts, bridge infrastructure, and off-chain relayer for the UMC Stablecoin on Hedera and Polygon.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Contracts](#contracts)
   - [UMCToken](#umctoken)
   - [UMCBridgeHedera](#umcbridgehedera)
   - [UMCBridgePolygon](#umcbridgepolygon)
4. [Off-Chain Relayer](#off-chain-relayer)
   - [HederaWatcher](#hederawatcher)
   - [PolygonMinter](#polygonminter)
   - [UMCBridgeRelayer](#umcbridgerelayer)
5. [Bridge Flow (End-to-End)](#bridge-flow-end-to-end)
6. [Security Model](#security-model)
7. [Contract Addresses](#contract-addresses)
8. [Role Reference](#role-reference)
9. [Scripts](#scripts)
10. [Environment Variables](#environment-variables)
11. [Development Setup](#development-setup)
12. [Use Case in the Umoja App](#use-case-in-the-umoja-app)

---

## Overview

`umoja-hedera` is the on-chain and bridge layer for the **UMC Stablecoin** — a USD-pegged token deployed on the Hedera network. The system consists of three Solidity contracts and a TypeScript off-chain relayer service that together enable:

- Minting and managing UMC on Hedera's EVM-compatible Smart Contract Service (HSCS)
- A trust-minimised, nonce-protected cross-chain bridge from **Hedera to Polygon** using burn-and-mint semantics
- EIP-712 signed attestations for secure mint authorisation on Polygon
- Production-grade relayer with circuit breaking, exponential backoff, and persistent nonce deduplication

The contracts are written in Solidity 0.8.24, use OpenZeppelin's upgradeable library (UUPS pattern), and are deployed to Hedera Testnet and Polygon Amoy.

---

## Architecture

```
+------------------------------------------------------------------+
|                          HEDERA NETWORK                          |
|                                                                  |
|   +-------------+   approve + burnFrom   +------------------+   |
|   |  UMCToken   |<-----------------------| UMCBridgeHedera  |   |
|   |  (ERC-20)   |                        |  (burn + nonce)  |   |
|   +-------------+                        +--------+---------+   |
|                                                   |             |
|                                            BridgeBurn event     |
+---------------------------------------------------+--------------+
                                                    |
                                    +---------------v--------------+
                                    |       OFF-CHAIN RELAYER      |
                                    |                              |
                                    |  HederaWatcher               |
                                    |  - Polls mirror node for     |
                                    |    BridgeBurn events         |
                                    |  - Verifies burn on-chain    |
                                    |                              |
                                    |  PolygonMinter               |
                                    |  - Signs EIP-712 attestation |
                                    |  - Submits claimMint tx      |
                                    |                              |
                                    |  UMCBridgeRelayer            |
                                    |  - Orchestrates pipeline     |
                                    |  - Retry / circuit breaker   |
                                    |  - Persistent nonce cache    |
                                    +---------------+--------------+
                                                    |
                                          claimMint(attestation)
                                                    |
+---------------------------------------------------+--------------+
|                         POLYGON NETWORK           |              |
|                                                   v              |
|   +-------------+   mint(recipient, amount)  +---------------+  |
|   |  UMCToken   |<---------------------------|UMCBridgePolygon|  |
|   |  (ERC-20)   |                            | (EIP-712 +    |  |
|   +-------------+                            |  nonce guard) |  |
|                                              +---------------+  |
+------------------------------------------------------------------+
```

---

## Contracts

### UMCToken

**File:** `contracts/UMCToken.sol`

The core USD-pegged stablecoin. Deployed on both Hedera (primary) and Polygon (bridge recipient). Follows the USDC/USDT convention of 6 decimal places.

#### Key Design Decisions

| Decision | Rationale |
|---|---|
| UUPS upgradeable proxy | Allows logic fixes without migrating balances or re-issuing tokens |
| Per-minter allowance | Each authorised minter has a cap on how much it can mint, limiting blast radius from a compromised key |
| Global supply cap | Hard ceiling on total circulating supply, enforced at the contract level |
| Blacklisting | Regulatory compliance — specific addresses can be frozen without pausing the whole system |
| 6 decimals | USD stablecoin standard, consistent with USDC and USDT |

#### Roles

| Role | Capability |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Grant/revoke all roles, set supply cap, set minter allowances |
| `MINTER_ROLE` | Call `mint()` (subject to per-minter allowance and global cap) |
| `PAUSER_ROLE` | Call `pause()` / `unpause()` to halt all transfers |
| `BLACKLISTER_ROLE` | Call `blacklist()` / `unBlacklist()` on individual addresses |
| `UPGRADER_ROLE` | Authorise UUPS proxy upgrades |

#### Core Functions

```solidity
// Mint tokens — only MINTER_ROLE, enforces per-minter allowance and supply cap
function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE)

// Burn tokens from caller's balance (bridge burn-side or voluntary redemption)
function burn(uint256 amount) public override

// Admin: set how much a specific minter address is allowed to mint
function setMinterAllowance(address minter, uint256 allowance) external onlyRole(DEFAULT_ADMIN_ROLE)

// Admin: adjust the global supply ceiling
function setSupplyCap(uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE)

// Compliance: freeze / unfreeze an address
function blacklist(address account) external onlyRole(BLACKLISTER_ROLE)
function unBlacklist(address account) external onlyRole(BLACKLISTER_ROLE)
```

#### Events

| Event | Emitted When |
|---|---|
| `Mint(minter, to, amount)` | Tokens are minted |
| `Burn(burner, amount)` | Tokens are burned |
| `Blacklisted(account)` | An address is blacklisted |
| `UnBlacklisted(account)` | An address is removed from the blacklist |
| `SupplyCapUpdated(oldCap, newCap)` | Supply cap is changed |
| `MinterAllowanceSet(minter, allowance)` | A minter's allowance is updated |

---

### UMCBridgeHedera

**File:** `contracts/UMCBridgeHedera.sol`

The **burn side** of the Hedera to Polygon bridge. Users call `bridgeToPolygon()` to lock/destroy their UMC on Hedera. An auto-incrementing nonce is assigned to each burn and stored on-chain, giving the relayer a verifiable record to act on.

#### Bridge Parameters (configured at deploy)

| Parameter | Default (deploy script) | Description |
|---|---|---|
| `minBridgeAmount` | 1 UMC (1,000,000 units) | Prevents dust attacks |
| `maxBridgeAmount` | 100,000 UMC | Limits single-tx exposure |
| `feeBasisPoints` | 25 (0.25%) | Fee deducted from gross amount |
| `dailyVolumeLimit` | 1,000,000 UMC | Rolling daily cap across all users |

#### Bridge Flow (Hedera side)

1. User calls `UMCToken.approve(bridgeAddress, amount)`
2. User calls `UMCBridgeHedera.bridgeToPolygon(polygonRecipient, amount)`
3. Contract validates amount bounds and daily limit
4. Calculates `fee = amount * feeBasisPoints / 10_000` and `netAmount = amount - fee`
5. Calls `UMCToken.burnFrom(msg.sender, amount)` — full gross amount is burned
6. Stores a `BridgeBurnRecord` keyed by nonce
7. Emits `BridgeBurn(nonce, hederaSender, polygonRecipient, amount, fee, netAmount, timestamp)`

The relayer watches for `BridgeBurn` events and verifies each burn by querying `processedNonces[nonce]` directly on-chain before proceeding.

#### Key Functions

```solidity
// Initiate a bridge transfer — burns UMC and emits BridgeBurn
function bridgeToPolygon(address polygonRecipient, uint256 amount) external whenNotPaused

// Read-only: calculate fee + net for a given gross amount
function calculateBridgeAmount(uint256 grossAmount) external view returns (uint256 netAmount, uint256 fee)

// Read-only: how much daily volume is left today
function remainingDailyVolume() external view returns (uint256)

// Read-only: retrieve on-chain burn details by nonce (used by relayer for verification)
function getBurnRecord(uint256 nonce) external view returns (BridgeBurnRecord memory)

// Admin: update bridge limits and fee
function updateBridgeConfig(uint256 min, uint256 max, uint256 feeBps, uint256 dailyLimit) external onlyRole(DEFAULT_ADMIN_ROLE)
```

---

### UMCBridgePolygon

**File:** `contracts/UMCBridgePolygon.sol`

The **mint side** of the bridge. Accepts EIP-712 typed-data signatures from authorised relayers and mints UMC on Polygon for the specified recipient.

#### Security Properties

- **EIP-712 typed signatures** — prevent signature replay across chains or contracts (domain includes `chainId` and `verifyingContract`)
- **Nonce replay protection** — each Hedera burn nonce can only trigger one mint; `claimedNonces[nonce]` is set atomically before minting
- **Value-tiered signatures** — amounts above `highValueThreshold` (default: 1,000,000 UMC) require more relayer signatures than standard transfers
- **Time-bounded attestations** — each signature includes a `deadline`; expired attestations are rejected
- **RELAYER_ROLE enforcement** — recovered signer must hold `RELAYER_ROLE`; duplicate signers within one call are rejected

#### EIP-712 Type

```solidity
MintAttestation(
  uint256 hederaNonce,
  address polygonRecipient,
  uint256 amount,
  uint256 deadline
)
```

Domain name: `"UMCBridge"`, version: `"1"`.

#### Key Functions

```solidity
// Claim bridged UMC — verifies signatures and mints
function claimMint(
    uint256 hederaNonce,
    address polygonRecipient,
    uint256 amount,
    uint256 deadline,
    bytes[] calldata signatures
) external whenNotPaused

// Read-only: check if a nonce has already been claimed
function isNonceClaimed(uint256 nonce) external view returns (bool)

// Read-only: reproduce the EIP-712 digest for off-chain signing
function computeMintDigest(
    uint256 hederaNonce,
    address polygonRecipient,
    uint256 amount,
    uint256 deadline
) external view returns (bytes32)

// Admin: update signature threshold and high-value config
function setSignatureConfig(uint256 required, uint256 hvThreshold, uint256 hvRequired) external onlyRole(DEFAULT_ADMIN_ROLE)
```

---

## Off-Chain Relayer

The relayer is a TypeScript service that bridges the gap between the two chains. It has three main classes and two entry points.

### HederaWatcher

**File:** `hedera-watcher.ts`

Polls the **Hedera Mirror Node REST API** for `BridgeBurn` log entries since the last check. Hedera does not support native WebSocket event subscriptions at the contract level, so polling the mirror node is the standard approach.

**Key implementation details:**

- Tracks a `lastTimestamp` cursor — each successful poll advances this so events are never double-processed in a single session
- Decodes ABI-encoded event data manually: topics 1–3 are the indexed fields (nonce, sender, recipient); the data field carries amount/fee/netAmount/timestamp
- `verifyBurnRecord()` makes a `ContractCallQuery` directly against the Hedera consensus node (not the mirror) to confirm `processedNonces[nonce] == true` before signing an attestation — this prevents acting on stale or manipulated mirror node data

```typescript
// Poll returns decoded BridgeBurnEvent objects since the last call
async pollBurnEvents(): Promise<BridgeBurnEvent[]>

// On-chain verification via ContractCallQuery — queries the consensus node directly
async verifyBurnRecord(nonce: bigint): Promise<boolean>
```

---

### PolygonMinter

**File:** `polygon-minter.ts`

Signs EIP-712 `MintAttestation` typed data with the relayer's private key and submits `claimMint` transactions to `UMCBridgePolygon` on Polygon.

**Key implementation details:**

- EIP-712 domain is initialised lazily at `initialize()` time — `chainId` and `verifyingContract` are resolved from the live network to prevent accidental cross-chain signature reuse
- `signAttestation()` sets `deadline = now + attestationTtlSeconds` (default 24h) — gives the relayer a reasonable retry window without keeping attestations valid indefinitely
- `submitMint()` waits for 2 block confirmations before returning the tx hash
- Checks `isNonceClaimed()` before submitting to avoid wasting gas on already-claimed nonces

```typescript
async signAttestation(burn: BridgeBurnEvent): Promise<MintAttestation>
async submitMint(attestation: MintAttestation): Promise<string>
async isNonceClaimed(nonce: bigint): Promise<boolean>
```

---

### UMCBridgeRelayer

**Entry points:**
- `index.ts` — basic relayer suitable for local testing and development
- `scripts/relayer.ts` — production-grade relayer

The production relayer (`scripts/relayer.ts`) adds several critical features over the base version:

| Feature | Description |
|---|---|
| Strict config validation | Fails fast on startup if required env vars are missing |
| Persistent nonce cache | Processed nonces are written to `.processed-nonces.json` — survives process restarts without double-minting |
| Exponential backoff with jitter | Retry delay = `rand(0, baseDelay * 2^attempt)` — avoids thundering-herd on RPC recovery |
| Circuit breaker | After 5 consecutive Polygon RPC failures the circuit opens for 60s, preventing further mint attempts until the RPC recovers |
| Concurrency tracking | `inFlight` counter enables graceful drain: on SIGINT/SIGTERM the relayer stops accepting new burns and waits up to 30s for in-flight operations to complete |
| Structured logs | ISO timestamp + level + tag on every log line |
| Fatal error handlers | `uncaughtException` and `unhandledRejection` both exit with code 1 rather than silently swallowing errors |

#### Bridge Request State Machine

```
DETECTED
   |
   v
CONFIRMED          <- verifyBurnRecord() returns true
   |
   v
ATTESTATION_SIGNED <- EIP-712 signature created
   |
   v
MINT_SUBMITTED     <- claimMint tx sent to Polygon
   |
   v
MINT_CONFIRMED     <- tx confirmed (2 blocks)

At any step -> FAILED -> retry with exponential backoff (up to maxRetries)
```

---

## Bridge Flow (End-to-End)

```
User (Hedera)
  |
  +-- 1. approve(bridge, amount)                    [UMCToken on Hedera]
  +-- 2. bridgeToPolygon(polygonAddress, amount)    [UMCBridgeHedera]
  |       Burns UMC, stores BridgeBurnRecord, emits BridgeBurn(nonce, ...)
  |
Relayer (off-chain)
  |
  +-- 3. pollBurnEvents()     [HederaWatcher -> mirror node]
  +-- 4. verifyBurnRecord()   [HederaWatcher -> Hedera consensus node]
  +-- 5. signAttestation()    [PolygonMinter -> EIP-712 sign]
  +-- 6. isNonceClaimed()     [PolygonMinter -> Polygon read]
  +-- 7. submitMint()         [PolygonMinter -> UMCBridgePolygon.claimMint()]
          Verifies signatures, marks nonce claimed, mints UMC

User (Polygon)
  +-- 8. Receives UMC at their Polygon address
```

---

## Security Model

### Trust Assumptions

- The relayer's private key (`POLYGON_RELAYER_PRIVATE_KEY`) is the critical secret. Compromise allows minting on Polygon for any burn detected on Hedera, bounded by the minter allowance set on `UMCToken`.
- The Hedera bridge contract is the ground truth. The relayer always verifies burns directly on-chain (`verifyBurnRecord`) before signing, so a manipulated mirror node response cannot trigger a false mint.
- Nonces are the double-spend prevention mechanism. Once `claimedNonces[nonce] = true` is written on Polygon, that nonce can never be used again regardless of how many times the relayer retries or restarts.

### Mitigation Layers

| Threat | Mitigation |
|---|---|
| Relayer key compromise | Value-tiered multi-sig on `UMCBridgePolygon` (large transfers require more relayer keys); minter allowance cap on `UMCToken` |
| Mirror node manipulation | `verifyBurnRecord()` queries the Hedera consensus node directly, not the mirror |
| Replay attack (same chain) | `claimedNonces` mapping on Polygon; `processedNonces` mapping on Hedera |
| Cross-chain replay | EIP-712 domain binds signature to `chainId` + `verifyingContract` |
| Stale attestations | `deadline` field in every attestation; rejected if `block.timestamp > deadline` |
| Dust / griefing | `minBridgeAmount` rejects tiny bridge requests |
| Volume spike / exploit amplification | `dailyVolumeLimit` on Hedera bridge; `maxBridgeAmount` per tx |
| Emergency | Both bridge contracts and the token are pausable |
| Contract bugs | UUPS upgradeable — logic can be patched without migrating token state |

---

## Contract Addresses

### Hedera Testnet

| Contract | Hedera ID | EVM Address |
|---|---|---|
| UMCToken | `0.0.8081174` | `0x00000000000000000000000000000000007b4f16` |
| UMCBridgeHedera | — | `0x45F9cebca7F3A18fAD676D141004fD86728484DD` |

- Supply cap: 1,000,000,000 UMC ($1B)
- Initial minter allowance: 100,000,000 UMC ($100M)
- Deployer account: `0.0.8064975`
- Deployed: 2026-03-04

### Polygon Amoy (Testnet)

| Contract | EVM Address |
|---|---|
| UMCToken (Polygon) | `0xaD6C18d9E1dfF333007989C192fc0127B72C6387` |
| UMCBridgePolygon | `0xe9DBE0A46B4d3b15ceab0c79aBA998678AcC20B7` |

- Deployer: `0x4C3CB0eD1098b4848cB2590E7c7020958037F340`
- Deployed: 2026-03-18
- `UMCBridgePolygon` holds `MINTER_ROLE` on the Polygon `UMCToken` with a $100M allowance

> Deployment artifacts are persisted in `deployments/testnet.json`, `deployments/hedera-bridge-testnet.json`, and `deployments/polygon-bridge-amoy.json`.

---

## Role Reference

### UMCToken (both chains)

| Role constant | Key | Purpose |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `bytes32(0)` | Full admin — grants/revokes all roles |
| `MINTER_ROLE` | `keccak256("MINTER_ROLE")` | Mint new tokens (within allowance) |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` | Pause / unpause transfers |
| `BLACKLISTER_ROLE` | `keccak256("BLACKLISTER_ROLE")` | Freeze / unfreeze addresses |
| `UPGRADER_ROLE` | `keccak256("UPGRADER_ROLE")` | Authorise UUPS upgrades |

### UMCBridgeHedera

| Role constant | Purpose |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Update bridge config and fee recipient |
| `OPERATOR_ROLE` | Pause / unpause the bridge |
| `UPGRADER_ROLE` | Authorise upgrades |

### UMCBridgePolygon

| Role constant | Purpose |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Update signature config, claim window |
| `RELAYER_ROLE` | Sign EIP-712 mint attestations |
| `OPERATOR_ROLE` | Pause / unpause |
| `UPGRADER_ROLE` | Authorise upgrades |

---

## Scripts

All scripts live in `scripts/` and are executed via Hardhat or `ts-node`.

| Script | Command | Description |
|---|---|---|
| `deploy.ts` | `npx hardhat run scripts/deploy.ts --network hederaTestnet` | Deploy `UMCToken` to Hedera, initialise, set minter allowance |
| `deployBridgeHedera.ts` | `npx hardhat run scripts/deployBridgeHedera.ts --network hederaTestnet` | Deploy `UMCBridgeHedera` (reads token address from `deployments/testnet.json`) |
| `deployBridgePolygon.ts` | `npx hardhat run scripts/deployBridgePolygon.ts --network polygonAmoy` | Deploy `UMCToken` + `UMCBridgePolygon` on Polygon, wire `MINTER_ROLE` to bridge |
| `mint.ts` | `npx ts-node scripts/mint.ts` | Mint UMC tokens to a target address on Hedera |
| `updateMinterRole.ts` | `npx hardhat run scripts/updateMinterRole.ts --network polygonAmoy` | Grant/revoke `MINTER_ROLE` and set minter allowance |
| `testBridge.ts` | `npx hardhat run scripts/testBridge.ts --network hederaTestnet` | Full E2E bridge test: mint → approve → burn on Hedera, poll Polygon for mint confirmation |
| `relayer.ts` | `npx ts-node scripts/relayer.ts` | Run the production relayer process |

---

## Environment Variables

Create a `.env` file in the `umoja-hedera/` directory:

```env
# Hedera
HEDERA_OPERATOR_ID=0.0.XXXXXX
HEDERA_OPERATOR_KEY=<DER-encoded private key>
HEDERA_OPERATOR_KEY_HEX=<hex private key for Hardhat network config>
HEDERA_NETWORK=testnet
HEDERA_BRIDGE_CONTRACT_ID=<Hedera contract ID, e.g. 0.0.XXXXXX>
HEDERA_TESTNET_RPC=https://testnet.hashio.io/api

# Polygon
POLYGON_RPC_URL=https://rpc-amoy.polygon.technology
POLYGON_BRIDGE_ADDRESS=0xe9DBE0A46B4d3b15ceab0c79aBA998678AcC20B7
POLYGON_RELAYER_PRIVATE_KEY=<hex private key for the address holding RELAYER_ROLE>
POLYGON_CHAIN_ID=80002

# Relayer tuning (optional — defaults shown)
POLL_INTERVAL_MS=10000
CONFIRMATIONS=1
MAX_RETRIES=5
RETRY_DELAY_MS=30000
ATTESTATION_TTL=86400

# Deploy-time only
INITIAL_SUPPLY_CAP=1000000000
INITIAL_MINTER_ALLOWANCE=100000000
```

---

## Development Setup

**Prerequisites:** Node.js 20+, npm

```bash
cd umoja-hedera
npm install

# Compile contracts
npx hardhat compile

# Run unit tests
npx hardhat test

# Deploy UMCToken to Hedera Testnet
npx hardhat run scripts/deploy.ts --network hederaTestnet

# Deploy bridge contracts
npx hardhat run scripts/deployBridgeHedera.ts --network hederaTestnet
npx hardhat run scripts/deployBridgePolygon.ts --network polygonAmoy

# Run the E2E bridge test
npx hardhat run scripts/testBridge.ts --network hederaTestnet

# Start the production relayer
npx ts-node scripts/relayer.ts
```

---

## Use Case in the Umoja App

The Umoja application is a multi-chain fintech platform where users hold balances denominated in UMC (the USD-pegged stablecoin) across both Hedera and Polygon. The `umoja-hedera` package is the blockchain settlement layer that the main API (`src/`) depends on.

### How It Fits In

**1. User Account Wallets on Hedera**

The main Umoja API provisions smart contract accounts for each user via an `AccountFactory` on Hedera. Each user's on-chain wallet is an EVM-compatible Hedera account. The UMC balance on this wallet is the canonical representation of the user's spendable balance within the app — every top-up mints UMC to the user's Hedera wallet and every spend debits from it.

**2. On/Off-Ramp Settlement**

When a user buys UMC via Transak, MoonPay, or Coinbase Onramp (configured in `src/config/env.ts`), the API calls `UMCToken.mint()` on Hedera to issue the corresponding UMC to the user's wallet after payment is confirmed. When a user redeems (withdraws), the API calls `burn()`. The `ERC20_SETTLEMENT_ACCOUNT_ID` env var in the main API designates the account used for settlement accounting.

**3. Polygon Transfers and Cross-Chain Liquidity**

The main API includes a dedicated `PolygonTransfer` listener (`src/shared/polygon-transfers/`) that watches `Transfer` events on the Polygon UMC token (`POLYGON_UMC_TOKEN_ADDRESS`). When UMC arrives at a user's Polygon address — either via the bridge or a direct on-chain transfer — the API credits the user's internal balance accordingly.

The bridge enables:
- Users who hold UMC on Polygon (from a DeFi protocol or CEX withdrawal) to move funds into the Umoja app's Hedera-native wallet
- The platform to route liquidity between chains for settlement or treasury operations
- Integration with Polygon-native services (DEXes, yield protocols) without requiring users to manage the bridge themselves

**4. Hedera Bridge Worker**

The `src/shared/hedera-bridge/` worker in the main API is the internal consumer of the bridge. It detects user-initiated bridge requests, coordinates the `approve` + `bridgeToPolygon` flow on behalf of users, and reconciles the resulting Polygon mint with the user's internal account balance once the relayer confirms the mint on Polygon.

**5. Compliance and Emergency Controls**

`UMCToken`'s blacklisting and pause capabilities map directly to compliance requirements in the Umoja API. If an account is flagged by the abuse detection layer (ASN/IP denylist, geo-impossible travel, Tor blocking — all configured in `src/config/env.ts`), the compliance system can freeze that address's UMC on-chain in addition to API-level restrictions, ensuring a flagged user cannot circumvent restrictions via direct on-chain interaction.


---


