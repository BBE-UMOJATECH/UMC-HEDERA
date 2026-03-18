# UMC Stablecoin + Hedera ↔ Polygon Bridge

This repository contains a Hedera-based USD-pegged ERC-20 implementation (UMC), a Hedera burn contract, a Polygon mint contract, and a Node/TypeScript relayer that ties the burn/mint flow together. It is intended as a reference implementation and a starting point for production hardening.

The codebase is split into three domains:

1. On-chain UMC token (Hedera EVM)
2. Cross-chain bridge contracts (Hedera burn side + Polygon mint side)
3. Off-chain relayer (Hedera mirror-node poller + Polygon signer/minter)

From a senior engineering perspective, the operational model is straightforward: **burn on Hedera, attest off-chain, mint on Polygon**. The contracts are upgradeable (UUPS) and use role-based access control throughout.

## Repository Layout

- `UMCToken.sol`: Upgradeable ERC-20 with 6 decimals, supply cap, mint allowance, blacklist, and pause controls.
- `UMCBridgeHedera.sol`: Burn-side bridge contract for Hedera → Polygon.
- `UMCBridgePolygon.sol`: Mint-side bridge contract for Hedera → Polygon.
- `hedera-watcher.ts`: Polls Hedera mirror node logs for burn events.
- `polygon-minter.ts`: Signs EIP-712 attestations and submits `claimMint` transactions to Polygon.
- `index.ts`: Relayer entrypoint; orchestrates polling, verification, attestation, and mint submission.
- `deploy.ts`: Hedera deployment script (direct contract deployment + initializer call).
- `UMCToken.test.ts`: Hardhat tests for the UMC token.
- `hardhat.config.ts`: Hardhat build/test config.
- `package.json`: Tooling and scripts.

## High-Level Architecture

**UMC token**
- Upgradeable UUPS ERC-20 using OpenZeppelin upgradeable libraries.
- 6 decimals to align with USD stablecoin conventions (USDC/USDT).
- Supply cap enforced at mint time.
- Per-minter allowances enforced at mint time.
- Blacklist enforced on all transfers (excluding mint/burn).
- Pausable transfers for emergency response.

**Bridge (Hedera → Polygon)**
- Users burn UMC via `UMCBridgeHedera.bridgeToPolygon`.
- Burn emits `BridgeBurn` events that the relayer polls from Hedera mirror nodes.
- Relayer verifies burn records on-chain (Hedera).
- Relayer signs EIP-712 attestation and submits `claimMint` on Polygon.
- Polygon bridge verifies signatures and mints UMC on Polygon.

**Security controls**
- Role-based access control on all critical methods.
- Nonce-based replay protection on bridge flow.
- Min/max bridge amounts and daily volume caps.
- Optional multi-sig on admin roles is expected in production.
- Upgrade authorization restricted to `UPGRADER_ROLE`.

## Contracts

### `UMCToken.sol`

Key features:
- `decimals()` returns 6.
- Minting controlled by `MINTER_ROLE` + per-minter allowance + global cap.
- `blacklist()`/`unBlacklist()` enforced in `_update` hook for transfers.
- `pause()`/`unpause()` implemented via `ERC20PausableUpgradeable`.
- UUPS upgradeable proxy support with `_authorizeUpgrade` gate.

Core roles:
- `DEFAULT_ADMIN_ROLE`: grants/revokes roles, sets supply cap, sets minter allowances
- `MINTER_ROLE`: minting authority
- `PAUSER_ROLE`: pause/unpause transfers
- `BLACKLISTER_ROLE`: blacklist management
- `UPGRADER_ROLE`: upgrade authorization

### `UMCBridgeHedera.sol`

Burn-side contract for Hedera.

Core flow:
- `bridgeToPolygon(polygonRecipient, amount)` burns UMC from user.
- Emits `BridgeBurn` including nonce, sender, recipient, gross, fee, net, timestamp.
- Enforces:
  - `minBridgeAmount` / `maxBridgeAmount`
  - `dailyVolumeLimit`
  - allowance + balance checks
  - `feeBasisPoints` (basis points)

Nonce handling:
- `bridgeNonce` increments per burn.
- `processedNonces` tracks used nonces.
- `burnRecords` stores canonical burn data used for relayer verification.

### `UMCBridgePolygon.sol`

Mint-side contract for Polygon.

Core flow:
- `claimMint(hederaNonce, polygonRecipient, amount, deadline, signatures)`
- Validates:
  - nonce unused
  - deadline not expired
  - required signature count based on amount tier
  - signer roles and no duplicate signers

EIP-712:
- `UMCBridge` domain, version `1`
- `MintAttestation` typed struct with nonce, recipient, amount, deadline

Signature policy:
- `requiredSignatures` for normal amounts
- `highValueRequiredSignatures` for amounts ≥ `highValueThreshold`

## Off-Chain Relayer

**Entry point:** `index.ts`

Workflow:
1. Poll Hedera mirror node logs for `BridgeBurn` events.
2. Verify each burn on-chain (Hedera bridge contract).
3. Generate and sign EIP-712 attestations (Polygon relayer key).
4. Submit `claimMint` on Polygon.
5. Track status and retry failures.

Key components:
- `HederaWatcher`: mirror node poller + on-chain verification.
- `PolygonMinter`: EIP-712 signing + mint submission.
- `UMCBridgeRelayer`: orchestration, retries, in-memory queue.

Current limitations:
- No persistence for processed nonces; restart will reprocess unless Polygon already claimed.
- `confirmationsRequired` in config is not currently used.
- Mirror node polling is interval-based; no websocket subscription.
- Relayer relies on a single private key (no threshold relaying).

## Build and Test

Install:

```bash
npm install
```

Compile:

```bash
npm run compile
```

Test:

```bash
npm test
```

## Deployment

There are two deployment paths in this repo, and they are currently inconsistent:

1. **Hardhat scripts (recommended for EVM test local dev)**
   - `package.json` references `scripts/deploy.ts`, but the file lives at repo root as `deploy.ts`.
   - `hardhat.config.ts` points sources to `./contracts`, but contracts live at repo root.

2. **Hedera SDK deployment (`deploy.ts`)**
   - Directly uses `@hashgraph/sdk` to deploy the implementation and then calls `initialize`.
   - It is not deploying a UUPS proxy. The comment calls this out and suggests using ERC1967Proxy in production.

If you plan to run Hardhat compile/test/deploy, align the file layout or config:

- Move solidity files into `contracts/`, and tests into `test/`, or
- Update `hardhat.config.ts` paths to match the current filesystem.

### Hedera SDK deployment

`deploy.ts` expects `.env`:

- `HEDERA_OPERATOR_ID` (e.g., `0.0.123456`)
- `HEDERA_OPERATOR_KEY` (DER or hex)
- `HEDERA_NETWORK` (`testnet`, `mainnet`, `previewnet`)
- `INITIAL_SUPPLY_CAP` (UMC, human-readable)
- `INITIAL_MINTER_ALLOWANCE` (UMC, human-readable)

Run:

```bash
npx ts-node deploy.ts
```

This will:
- Deploy implementation
- Call `initialize`
- Set minter allowance
- Output deployment info to `deployments/<network>.json`

## Relayer Configuration

Relayer uses environment variables:

- `HEDERA_OPERATOR_ID`
- `HEDERA_OPERATOR_KEY`
- `HEDERA_NETWORK`
- `HEDERA_BRIDGE_CONTRACT_ID`
- `POLYGON_RPC_URL`
- `POLYGON_BRIDGE_ADDRESS`
- `POLYGON_RELAYER_PRIVATE_KEY`
- `POLYGON_CHAIN_ID`
- `POLL_INTERVAL_MS`
- `CONFIRMATIONS`
- `MAX_RETRIES`
- `RETRY_DELAY_MS`
- `ATTESTATION_TTL`
- `DATABASE_URL` (currently unused; placeholder for persistence)

Start relayer:

```bash
npx ts-node index.ts
```

## Operational Notes

- Use multisig or a hardware-backed key for admin roles.
- Separate operator roles from admin roles in production.
- Monitor mirror node availability and latency; the relayer is mirror-dependent.
- Consider persisting nonces/requests to a DB to make relayer crash-safe.
- For large-value mints, configure `highValueRequiredSignatures` > 1.
- UUPS upgrades require explicit `_authorizeUpgrade` role; treat upgrade keys as hot keys with strict control.

## Known Gaps / TODOs

- Hardhat folder layout mismatch (`contracts/` and `scripts/` expected but not present).
- No production-grade proxy deployment for UUPS in `deploy.ts`.
- No database persistence for relayer state.
- No validation that `UMCBridgePolygon` claim window is enforced in relayer.
- No end-to-end tests for bridge flow.

## License

MIT
