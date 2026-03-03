# UMC Stablecoin — USD-Pegged Token on Hedera

A secure, upgradeable ERC-20 stablecoin deployed on the Hedera network via the Hedera Smart Contract Service.

## Architecture

UMC is designed as a reserve-backed stablecoin pegged 1:1 to the US Dollar. The contract uses OpenZeppelin's battle-tested upgradeable contracts with the UUPS proxy pattern, enabling bug fixes and feature additions without redeploying.

### Security Features

- **Role-Based Access Control** — Five distinct roles (Admin, Minter, Pauser, Blacklister, Upgrader) following the principle of least privilege. No single key compromise can drain or manipulate the system.
- **Per-Minter Allowances** — Each minter has a capped allowance, limiting exposure from a compromised minter key.
- **Supply Cap** — Hard ceiling on total supply prevents unbounded minting.
- **Blacklisting** — Freeze specific addresses for regulatory compliance (OFAC, AML/KYC).
- **Pausable** — Emergency kill switch to halt all transfers during incidents.
- **UUPS Upgradeable** — Proxy pattern allows patching vulnerabilities without migrating balances.

### Token Specifications

| Property | Value |
|----------|-------|
| Name | UMC Stablecoin |
| Symbol | UMC |
| Decimals | 6 (USD standard, matching USDC/USDT) |
| Network | Hedera (EVM-compatible via Smart Contract Service) |
| Standard | ERC-20 |
| Proxy | UUPS (ERC-1967) |

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your Hedera credentials

# Compile contracts
npm run compile

# Run tests
npm test

# Deploy to testnet
npm run deploy:testnet

# Deploy to mainnet (use with caution)
npm run deploy:mainnet
```

## Roles & Permissions

| Role | Can Do |
|------|--------|
| `DEFAULT_ADMIN_ROLE` | Grant/revoke roles, set supply cap, set minter allowances |
| `MINTER_ROLE` | Mint new UMC (within allowance) |
| `PAUSER_ROLE` | Pause/unpause all transfers |
| `BLACKLISTER_ROLE` | Blacklist/unblacklist addresses |
| `UPGRADER_ROLE` | Authorize contract upgrades |

**Recommended production setup**: Use a multi-sig (e.g., Hedera multi-key account or a Gnosis Safe on Hedera EVM) for the admin role. Separate role holders across different keys.

## Operational Workflows

### Minting (Reserve-Backed)

1. User deposits USD to your reserve bank account
2. Compliance team verifies the deposit
3. Admin sets minter allowance: `setMinterAllowance(minterAddress, amount)`
4. Minter calls `mint(recipientAddress, amount)`
5. UMC is credited to the user's Hedera account

### Redemption

1. User calls `burn(amount)` to destroy UMC
2. Off-chain system detects the Burn event
3. USD is wired back to the user's bank account

### Compliance Freeze

```
blacklist(suspiciousAddress)    // Freeze
unBlacklist(clearedAddress)     // Unfreeze
```

### Emergency Pause

```
pause()    // Halt ALL transfers
unpause()  // Resume transfers
```

## Testing

The test suite covers initialization, minting/burning, blacklisting, pausing, supply cap management, minter allowances, upgradeability, and standard ERC-20 transfers.

```bash
npm test
```

## Production Checklist

- [ ] Deploy behind UUPS proxy (use `upgrades.deployProxy` from Hardhat)
- [ ] Transfer admin role to multi-sig wallet
- [ ] Separate role keys (different keys for minter, pauser, blacklister)
- [ ] Set up off-chain event listeners for Mint/Burn/Blacklisted events
- [ ] Integrate proof-of-reserves (e.g., Chainlink PoR oracle)
- [ ] Engage an audit firm (Trail of Bits, OpenZeppelin, Halborn)
- [ ] Set up monitoring/alerting for unusual activity
- [ ] Document reserve management procedures
- [ ] Obtain necessary regulatory licenses

## License

MIT
