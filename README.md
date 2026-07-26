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

The contracts are written in Solidity 0.8.24, use OpenZeppelin's upgradeable library (UUPS pattern), and are live on Hedera Mainnet and Polygon Mainnet.

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
5. Calls `UMCToken.burnFrom(msg.sender, netAmount)` — only the net amount is burned
6. Calls `UMCToken.transferFrom(msg.sender, feeRecipient, fee)` — the fee is paid on-chain
7. Stores a `BridgeBurnRecord` keyed by nonce
8. Emits `BridgeBurn(nonce, hederaSender, polygonRecipient, amount, fee, netAmount, timestamp)`

Burning only the net amount keeps **burned-on-Hedera equal to minted-on-Polygon**, so total supply reconciles across both chains without an off-chain ledger of owed fees. The user's approval must cover the full gross amount, since it is spent by both the burn and the fee transfer.

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

### Reconciliation

The mirror-node poll in step 3 only ever looks forward from when the relayer started, so on its own it cannot see a burn that landed while the relayer was down. A reconcile sweep runs at startup and every `RECONCILE_INTERVAL_MS` to close that gap:

1. Read `bridgeNonce` from `UMCBridgeHedera` — every nonce below it has an on-chain burn record
2. For each nonce not already settled, read `getBurnRecord(nonce)` straight from contract storage
3. Check `UMCBridgePolygon.claimedNonces[nonce]`; if unclaimed, drive it through the normal attestation path
4. If it *is* claimed, cross-check `claims[nonce]` against the burn record — a mismatch means the Hedera and Polygon bridges come from different deployments and their nonce namespaces have collided

This depends only on authoritative state on both chains, so it also recovers from dropped mirror-node logs. A non-zero backlog is logged as `[WARN] [Reconcile] BACKLOG n unclaimed burn(s)` and is the signal worth alerting on: it means UMC is burned on Hedera but not yet minted on Polygon.

> **Deployment invariant:** the two bridges must be deployed as a pair. `bridgeNonce` restarts at 0 for a fresh `UMCBridgeHedera`, so pointing a new Hedera bridge at a `UMCBridgePolygon` that already has claims will collide. Redeploy both, or the reconcile sweep will flag the collision and dead-letter the affected burns.

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


### Hedera Mainnet — live

| Contract | Hedera ID | EVM Address |
|---|---|---|
| UMCToken (proxy) | `0.0.10783066` | `0x45F9cebca7F3A18fAD676D141004fD86728484DD` |
| UMCToken (impl) | — | `0x5A29ED0349D84c79c423E468cD33B3cd06049457` |
| UMCBridgeHedera (proxy) | `0.0.10783069` | `0xfc8aE77C4FD8BcaBF7784B7eF139050a8b5C0C4B` |
| UMCBridgeHedera (impl) | — | `0x74002E30bDb8Cbac3049db039D783467ebaD12Fb` |

- Deployer / operator: `0.0.10783060` (`0xEa3A8D8D79CA15758AA13b91fEF437cCB8bb8dD3`)
- Supply cap: 1,000,000,000 UMC — initial minter allowance 100,000,000 UMC
- Bridge limits: min 1 UMC, max 100,000 UMC, fee 25 bps, daily cap 1,000,000 UMC
- Deployed: 2026-07-26
- All four verified on Sourcify (`exact_match`) via `npx ts-node scripts/verifySourcifyV2.ts`

> **Identify Hedera contracts by their `0.0.x` ID, not their EVM address.**
> `CREATE` derives the address from deployer + nonce, so the same deployer at
> the same nonce produces an identical EVM address on every Hedera network —
> `0xfc8aE77C…0C4B` above is not unique to this deployment.

### Polygon Mainnet — live

| Contract | EVM Address |
|---|---|
| UMCToken (Polygon, proxy) | `0xc77F608895D140997dDdEBD4e139cb1A53D0cf85` |
| UMCToken (impl) | `0xaf766F9b026e59D5da7Cb19Fc263469D39112a88` |
| UMCBridgePolygon (proxy) | `0x017111d2D841228517A6cF806BD4E35C660a7249` |
| UMCBridgePolygon (impl) | `0xA34D412B5ED8207e4f7871dce4cea5431A047Eef` |

- Deployer / relayer: `0xA1a9E8c73Ecf86AE7F4858D5Cb72E689cDc9eb3e`
- Admin / upgrader: `0xEa3A8D8D79CA15758AA13b91fEF437cCB8bb8dD3`
- `UMCBridgePolygon` holds `MINTER_ROLE` on the Polygon `UMCToken` with a 100,000,000 UMC allowance
- Claim window: 86,400s — `ATTESTATION_TTL` must stay below it
- Deployed: 2026-07-26
- All four verified on Sourcify (`exact_match`) via `npx ts-node scripts/verifySourcifyV2.ts polygon`


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
| `preflight.ts` | `npx hardhat run scripts/preflight.ts --network hederaMainnet` | Pre-deploy checks: funding, key/account consistency, role separation. Run before every deploy |
| `deploy.ts` | `npx hardhat run scripts/deploy.ts --network hederaMainnet` | Deploy `UMCToken` to Hedera, initialise, set minter allowance |
| `deployBridgeHedera.ts` | `npx hardhat run scripts/deployBridgeHedera.ts --network hederaMainnet` | Deploy `UMCBridgeHedera` (reads token address from `deployments/mainnet.json`) |
| `deployBridgePolygon.ts` | `npx hardhat run scripts/deployBridgePolygon.ts --network polygon` | Deploy `UMCToken` + `UMCBridgePolygon` on Polygon, wire `MINTER_ROLE` to bridge |
| `mint.ts` | `npx ts-node scripts/mint.ts` | Mint UMC tokens to a target address on Hedera |
| `bridgeToPolygon.ts` | `npm run bridge:polygon -- --amount 10 --hedera-account-id 0.0.12345 --polygon-recipient 0xabc...` | One-shot bridge from Hedera to Polygon: approve UMC, call `bridgeToPolygon`, resolve the burn nonce, and optionally wait for Polygon claim |
| `updateMinterRole.ts` | `npx hardhat run scripts/updateMinterRole.ts --network polygon` | Grant/revoke `MINTER_ROLE` and set minter allowance |
| `testBridge.ts` | `npx hardhat run scripts/testBridge.ts --network hederaMainnet` | Full E2E bridge test: mint → approve → burn on Hedera, poll Polygon for mint confirmation |
| `simulateBridgeUsers.ts` | `npx ts-node scripts/simulateBridgeUsers.ts --once --wait-for-claim` | Drive bridge traffic from the accounts in `SIM_BRIDGE_USERS` |
| `verifySourcifyV2.ts` | `npx ts-node scripts/verifySourcifyV2.ts [polygon]` | Verify proxies + implementations on Sourcify |
| `relayer.ts` | `npx ts-node scripts/relayer.ts` | Run the production relayer process |

### `bridgeToPolygon.ts`

Bridges UMC from a Hedera account controlled by `HEDERA_OPERATOR_KEY` to a Polygon recipient. The script:

1. Checks the Hedera sender's HBAR balance and tops it up from `HEDERA_OPERATOR_ID` if needed.
2. Queries the bridge contract for the expected fee and net amount.
3. Calls `approve()` on the Hedera UMC token.
4. Calls `bridgeToPolygon()` on `UMCBridgeHedera`.
5. Reads the emitted `BridgeBurn` nonce from the Hedera mirror node.
6. Optionally polls the Polygon bridge until the relayer claims that nonce.

Usage:

```bash
cd umoja-hedera
npm run bridge:polygon -- \
  --amount 10 \
  --hedera-account-id 0.0.12345 \
  --polygon-recipient 0xA1a9E8c73Ecf86AE7F4858D5Cb72E689cDc9eb3e \
  --wait-for-claim
```

Notes:
- `--amount` is required and is expressed in UMC units with 6 decimals.
- `--hedera-account-id` defaults to `HEDERA_OPERATOR_ID`.
- `--polygon-recipient` defaults to `POLYGON_RECIPIENT`, then `POLYGON_RELAYER_ADDRESS`.
- `--wait-for-claim` requires `POLYGON_RPC_URL` and `POLYGON_BRIDGE_ADDRESS`.
- The script burns on Hedera only. The actual Polygon mint still depends on the relayer processing the emitted `BridgeBurn` event.

---

## Environment Variables

Create a `.env` file in the `umoja-hedera/` directory:

```env
# Hedera
HEDERA_OPERATOR_ID=0.0.XXXXXX
HEDERA_OPERATOR_KEY=<DER-encoded private key>
HEDERA_OPERATOR_KEY_HEX=<hex private key for Hardhat network config>
HEDERA_NETWORK=mainnet
HEDERA_TOKEN_CONTRACT_ID=<Hedera contract ID, e.g. 0.0.XXXXXX>
HEDERA_BRIDGE_CONTRACT_ID=<Hedera contract ID, e.g. 0.0.XXXXXX>
HEDERA_BRIDGE_EVM_ADDRESS=<0x... proxy address of UMCBridgeHedera>
HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api

# Polygon
# relayer.ts requires this exact name and it must point at mainnet.
POLYGON_RPC_URL=<paid, dedicated Polygon mainnet endpoint>
POLYGON_BRIDGE_ADDRESS=0x017111d2D841228517A6cF806BD4E35C660a7249
POLYGON_RELAYER_PRIVATE_KEY=<hex private key for the address holding RELAYER_ROLE>
POLYGON_CHAIN_ID=137

# Relayer tuning (optional — defaults shown)
POLL_INTERVAL_MS=10000
CONFIRMATIONS=1
MAX_RETRIES=5
RETRY_DELAY_MS=30000
RECONCILE_INTERVAL_MS=300000
ATTESTATION_TTL=3600

# Deploy-time only
INITIAL_SUPPLY_CAP=1000000000
INITIAL_MINTER_ALLOWANCE=100000000

# Mainnet only — no public fallback is configured on purpose
POLYGON_MAINNET_RPC_URL=<paid, dedicated Polygon mainnet endpoint>

# Role holders — each defaults to the deploying key when unset
ADMIN_ADDRESS=<0x... ideally a multisig; DEFAULT_ADMIN_ROLE>
UPGRADER_ADDRESS=<0x... can replace contract logic; defaults to ADMIN_ADDRESS>
OPERATOR_ADDRESS=<0x... pause/unpause; defaults to ADMIN_ADDRESS>
PAUSER_ADDRESS=<0x... token pause; defaults to ADMIN_ADDRESS>
BLACKLISTER_ADDRESS=<0x... token freeze; defaults to ADMIN_ADDRESS>
MINTER_ADDRESS=<0x... mints UMC on Hedera; defaults to the deployer>
RELAYER_ADDRESS=<0x... signs attestations; MUST differ from UPGRADER_ADDRESS>
FEE_RECIPIENT_ADDRESS=<0x... receives bridge fees; defaults to ADMIN_ADDRESS>
REVOKE_DEPLOYER_ROLES=false   # set true on mainnet to strip the deploying key
```

### Controlling who holds which role

By default every role goes to the deploying key, which puts total control of a live stablecoin behind one hot key. Set the `*_ADDRESS` variables above to split them. The deploy scripts:

1. Initialise the contract with the **deployer** as admin, so the remaining setup steps (`setMinterAllowance`, granting the bridge `MINTER_ROLE`) can run
2. Grant each role to its configured holder
3. Only then, if `REVOKE_DEPLOYER_ROLES=true`, strip the deployer — non-admin roles first, `DEFAULT_ADMIN_ROLE` last

Step 3 refuses to touch anything unless every intended holder already has its role, because a partial revocation is its own outage: strip `MINTER_ROLE` from the deployer while the replacement minter never received it and nobody can mint until an admin intervenes. Revoking `DEFAULT_ADMIN_ROLE` with no valid replacement is unrecoverable, so that check is a hard failure, not a warning. `test/roles.test.ts` covers all four paths.

The one pairing to get right is **`RELAYER_ADDRESS` must not equal `UPGRADER_ADDRESS`**. The relayer key is online and signing continuously; if it can also upgrade the contracts, compromising it means losing everything rather than losing one signer. Preflight fails on this for mainnet.

On Polygon, `MINTER_ROLE` on the token is handed to the **bridge contract** — UMC there exists only as the mint side of a Hedera burn, so no human key should be able to mint it.

---

## Mainnet Deployment

Run preflight before each step. It exits non-zero on anything blocking.

```bash
npm run preflight -- --network hederaMainnet
npm run deploy:mainnet              # UMCToken proxy on Hedera
npm run deploy:bridge-hedera        # UMCBridgeHedera proxy

npm run preflight -- --network polygon
npm run deploy:bridge-polygon       # UMCToken + UMCBridgePolygon
```

Then update `.env` with the four addresses, `npm run build` from the repo root, and restart the relayer.

What preflight checks:

| Check | Why |
|---|---|
| Deployer balance vs a per-chain minimum | A deploy that halts midway leaves a token proxy with no bridge holding `MINTER_ROLE` |
| Hedera `0.0.x` EVM alias matches the hex key's address | Otherwise `deploy.ts` (hardhat) and `mint.ts` (SDK) are different identities and roles land on an address the minting path cannot use |
| `POLYGON_CHAIN_ID` matches the RPC | It is part of the EIP-712 domain; a mismatch produces unclaimable attestations |
| `ATTESTATION_TTL` < claim window | Equal values revert intermittently with `DeadlineExceedsClaimWindow` |
| Max bridge amount vs the high-value threshold | A burn above the threshold needs 2 signatures but the relayer submits 1 — those burns would be unclaimable |
| `RELAYER_ADDRESS` ≠ `UPGRADER_ADDRESS`, roles off the deployer | Blast radius of the online signing key |

> **Deploy both bridges together.** `bridgeNonce` restarts at 0 for a fresh `UMCBridgeHedera`, so pairing it with an existing `UMCBridgePolygon` collides on already-claimed nonces.

Notes on the values that are easy to get wrong:

| Variable | Why it matters |
|---|---|
| `POLYGON_CHAIN_ID` | Required, never defaulted. It is part of the EIP-712 domain, so a wrong value produces attestations that recover to a non-relayer address and fail at `claimMint`. `PolygonMinter` asserts it against the RPC at boot and refuses to start on a mismatch. |
| `ATTESTATION_TTL` | Must stay **below** the Polygon bridge's `claimWindow` (default 86400). The relayer signs `deadline` off the local clock while `claimMint` compares against block time, so a TTL equal to the window reverts intermittently with `DeadlineExceedsClaimWindow`. |
| `RECONCILE_INTERVAL_MS` | How often the relayer re-checks Hedera burns against Polygon claims. Lower means faster recovery from a missed burn, at the cost of more RPC calls. |

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

# Pre-deploy checks — run before every deploy
npx hardhat run scripts/preflight.ts --network hederaMainnet

# Deploy UMCToken to Hedera
npx hardhat run scripts/deploy.ts --network hederaMainnet

# Deploy bridge contracts
npx hardhat run scripts/deployBridgeHedera.ts --network hederaMainnet
npx hardhat run scripts/deployBridgePolygon.ts --network polygon

# Run the E2E bridge test
npx hardhat run scripts/testBridge.ts --network hederaMainnet

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

