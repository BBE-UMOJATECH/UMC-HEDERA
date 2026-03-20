// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title UMCToken - USD-Pegged Stablecoin on Hedera
 * @author Hamid/ Umoja
 * @notice A secure, upgradeable ERC-20 stablecoin pegged 1:1 to the US Dollar.
 *         Deployed on Hedera via the Hedera Smart Contract Service (EVM-compatible).
 *
 * @dev Security features:
 *   - Role-based access control (Admin, Minter, Pauser, Blacklister, Upgrader)
 *   - Pausable transfers for emergency scenarios
 *   - Address blacklisting for regulatory compliance
 *   - Supply cap enforcement
 *   - UUPS upgradeable proxy pattern
 *   - Reentrancy-safe by design (no external calls in state-changing functions)
 *
 * @dev Stablecoin mechanics:
 *   - 6 decimals (standard for USD stablecoins, matching USDC/USDT)
 *   - Mint/burn controlled by authorized minters (backed by reserves)
 *   - Configurable supply cap
 */
contract UMCToken is
    Initializable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PausableUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    // =========================================================================
    // ROLES
    // =========================================================================

    /// @notice Role that can mint new tokens (reserve-backed minting)
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role that can pause/unpause all transfers
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Role that can blacklist/unblacklist addresses
    bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");

    /// @notice Role that can authorize contract upgrades
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // =========================================================================
    // STATE
    // =========================================================================

    /// @notice Maximum total supply that can ever be minted (in smallest unit)
    uint256 public supplyCap;

    /// @notice Mapping of blacklisted addresses (frozen for compliance)
    mapping(address => bool) private _blacklisted;

    /// @notice Tracks per-minter allowances for granular supply control
    mapping(address => uint256) public minterAllowance;

    // =========================================================================
    // EVENTS
    // =========================================================================

    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);
    event SupplyCapUpdated(uint256 oldCap, uint256 newCap);
    event MinterAllowanceSet(address indexed minter, uint256 allowance);
    event Mint(address indexed minter, address indexed to, uint256 amount);
    event Burn(address indexed burner, uint256 amount);

    // =========================================================================
    // ERRORS
    // =========================================================================

    error AccountBlacklisted(address account);
    error SupplyCapExceeded(uint256 requested, uint256 available);
    error MinterAllowanceExceeded(uint256 requested, uint256 allowance);
    error InvalidAddress();
    error InvalidAmount();
    error InvalidCap();

    // =========================================================================
    // INITIALIZER (replaces constructor for upgradeable pattern)
    // =========================================================================

    /**
     * @notice Initializes the UMC stablecoin contract.
     * @param defaultAdmin Address that receives DEFAULT_ADMIN_ROLE
     * @param initialSupplyCap Maximum supply cap (in smallest unit, 6 decimals)
     */
    function initialize(
        address defaultAdmin,
        uint256 initialSupplyCap
    ) public initializer {
        if (defaultAdmin == address(0)) revert InvalidAddress();
        if (initialSupplyCap == 0) revert InvalidCap();

        __ERC20_init("UMC Stablecoin", "UMC");
        __ERC20Burnable_init();
        __ERC20Pausable_init();
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(MINTER_ROLE, defaultAdmin);
        _grantRole(PAUSER_ROLE, defaultAdmin);
        _grantRole(BLACKLISTER_ROLE, defaultAdmin);
        _grantRole(UPGRADER_ROLE, defaultAdmin);

        supplyCap = initialSupplyCap;
    }

    // =========================================================================
    // ERC-20 OVERRIDES
    // =========================================================================

    /**
     * @notice UMC uses 6 decimals (USD stablecoin standard).
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // =========================================================================
    // MINTING
    // =========================================================================

    /**
     * @notice Mint new UMC tokens. Only callable by MINTER_ROLE.
     * @dev Enforces both the global supply cap and per-minter allowance.
     *      Each mint should correspond to verified USD reserves.
     * @param to Recipient address
     * @param amount Amount to mint (in smallest unit)
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (_blacklisted[to]) revert AccountBlacklisted(to);

        // Enforce global supply cap
        uint256 newSupply = totalSupply() + amount;
        if (newSupply > supplyCap) {
            revert SupplyCapExceeded(amount, supplyCap - totalSupply());
        }

        // Enforce per-minter allowance
        uint256 allowed = minterAllowance[msg.sender];
        if (amount > allowed) {
            revert MinterAllowanceExceeded(amount, allowed);
        }
        unchecked {
            minterAllowance[msg.sender] = allowed - amount;
        }

        _mint(to, amount);
        emit Mint(msg.sender, to, amount);
    }

    /**
     * @notice Burn UMC tokens from caller's balance (redeeming for USD).
     * @param amount Amount to burn
     */
    function burn(uint256 amount) public override {
        if (amount == 0) revert InvalidAmount();
        super.burn(amount);
        emit Burn(msg.sender, amount);
    }

    /**
     * @notice Set a minter's allowance (how much they can mint).
     * @param minter Address of the minter
     * @param allowance Maximum mintable amount
     */
    function setMinterAllowance(
        address minter,
        uint256 allowance
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minter == address(0)) revert InvalidAddress();
        if (!hasRole(MINTER_ROLE, minter)) {
            revert InvalidAddress(); // Must be a minter
        }
        minterAllowance[minter] = allowance;
        emit MinterAllowanceSet(minter, allowance);
    }

    // =========================================================================
    // BLACKLISTING (Regulatory Compliance)
    // =========================================================================

    /**
     * @notice Blacklist an address, preventing it from sending or receiving UMC.
     * @param account Address to blacklist
     */
    function blacklist(
        address account
    ) external onlyRole(BLACKLISTER_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _blacklisted[account] = true;
        emit Blacklisted(account);
    }

    /**
     * @notice Remove an address from the blacklist.
     * @param account Address to unblacklist
     */
    function unBlacklist(
        address account
    ) external onlyRole(BLACKLISTER_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _blacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    /**
     * @notice Check if an address is blacklisted.
     * @param account Address to check
     * @return True if the address is blacklisted
     */
    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    // =========================================================================
    // PAUSE / UNPAUSE (Emergency Controls)
    // =========================================================================

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // =========================================================================
    // SUPPLY CAP MANAGEMENT
    // =========================================================================

    /**
     * @notice Update the maximum supply cap.
     * @dev New cap must be >= current total supply.
     * @param newCap New maximum supply cap
     */
    function setSupplyCap(
        uint256 newCap
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCap < totalSupply()) revert InvalidCap();
        uint256 oldCap = supplyCap;
        supplyCap = newCap;
        emit SupplyCapUpdated(oldCap, newCap);
    }

    // =========================================================================
    // INTERNAL OVERRIDES
    // =========================================================================

    /**
     * @dev Hook that enforces blacklist checks on every transfer.
     */
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // Skip blacklist check for mint (from == 0) and burn (to == 0)
        if (from != address(0) && _blacklisted[from]) {
            revert AccountBlacklisted(from);
        }
        if (to != address(0) && _blacklisted[to]) {
            revert AccountBlacklisted(to);
        }
        super._update(from, to, value);
    }

    /**
     * @dev Restrict upgrades to UPGRADER_ROLE.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}
}
