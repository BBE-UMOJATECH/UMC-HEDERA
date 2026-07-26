// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title IUMCToken - Interface for the UMC token on Hedera
 */
interface IUMCToken {
    function burnFrom(address account, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title UMCBridgeHedera - Burn side of the Hedera → Polygon bridge
 * @notice Users burn UMC on Hedera and provide a Polygon destination address.
 *         An off-chain relayer detects BridgeBurn events and mints on Polygon.
 *
 * @dev Security model:
 *   - Nonce-based replay protection (each burn has a unique nonce)
 *   - Minimum/maximum bridge amounts to prevent dust attacks and limit exposure
 *   - Daily volume cap to limit damage from relayer compromise
 *   - Pausable for emergencies
 *   - Fee mechanism for operational sustainability
 */
contract UMCBridgeHedera is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    // =========================================================================
    // ROLES
    // =========================================================================

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // =========================================================================
    // STATE
    // =========================================================================

    /// @notice The UMC token contract on Hedera
    IUMCToken public umcToken;

    /// @notice Auto-incrementing nonce for each bridge request
    uint256 public bridgeNonce;

    /// @notice Minimum amount that can be bridged (in smallest unit)
    uint256 public minBridgeAmount;

    /// @notice Maximum amount per single bridge transaction
    uint256 public maxBridgeAmount;

    /// @notice Bridge fee in basis points (1 bp = 0.01%)
    uint256 public feeBasisPoints;

    /// @notice Address that receives collected fees
    address public feeRecipient;

    /// @notice Daily volume tracking
    uint256 public dailyVolume;
    uint256 public dailyVolumeLimit;
    uint256 public currentDay;

    /// @notice Mapping of nonce → whether the burn has been processed
    mapping(uint256 => bool) public processedNonces;

    /// @notice Mapping of nonce → burn details for verification
    mapping(uint256 => BridgeBurnRecord) public burnRecords;

    struct BridgeBurnRecord {
        address hederaSender;
        address polygonRecipient;
        uint256 amount;
        uint256 fee;
        uint256 netAmount;
        uint256 timestamp;
        bool exists;
    }

    // =========================================================================
    // EVENTS
    // =========================================================================

    /**
     * @notice Emitted when a user burns UMC to bridge to Polygon.
     *         The relayer watches for this event.
     */
    event BridgeBurn(
        uint256 indexed nonce,
        address indexed hederaSender,
        address indexed polygonRecipient,
        uint256 amount,
        uint256 fee,
        uint256 netAmount,
        uint256 timestamp
    );

    event BridgeConfigUpdated(
        uint256 minAmount,
        uint256 maxAmount,
        uint256 feeBps,
        uint256 dailyLimit
    );

    event FeeRecipientUpdated(address indexed newRecipient);

    // =========================================================================
    // ERRORS
    // =========================================================================

    error InvalidAddress();
    error InvalidAmount();
    error BelowMinimum(uint256 amount, uint256 minimum);
    error AboveMaximum(uint256 amount, uint256 maximum);
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error InsufficientAllowance(uint256 required, uint256 allowed);
    error InsufficientBalance(uint256 required, uint256 available);
    error InvalidFee();

    // =========================================================================
    // INITIALIZER
    // =========================================================================

    /**
     * @param _umcToken Address of the UMC token contract on Hedera
     * @param _admin Admin address (should be multi-sig in production)
     * @param _feeRecipient Address to receive bridge fees
     * @param _minBridgeAmount Minimum bridge amount (e.g., 1 UMC = 1_000_000)
     * @param _maxBridgeAmount Maximum bridge amount per tx
     * @param _feeBasisPoints Fee in basis points (e.g., 25 = 0.25%)
     * @param _dailyVolumeLimit Maximum daily bridge volume
     */
    function initialize(
        address _umcToken,
        address _admin,
        address _feeRecipient,
        uint256 _minBridgeAmount,
        uint256 _maxBridgeAmount,
        uint256 _feeBasisPoints,
        uint256 _dailyVolumeLimit
    ) public initializer {
        if (_umcToken == address(0)) revert InvalidAddress();
        if (_admin == address(0)) revert InvalidAddress();
        if (_feeRecipient == address(0)) revert InvalidAddress();
        if (_feeBasisPoints > 1000) revert InvalidFee(); // Max 10%

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(OPERATOR_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);

        umcToken = IUMCToken(_umcToken);
        feeRecipient = _feeRecipient;
        minBridgeAmount = _minBridgeAmount;
        maxBridgeAmount = _maxBridgeAmount;
        feeBasisPoints = _feeBasisPoints;
        dailyVolumeLimit = _dailyVolumeLimit;
        currentDay = block.timestamp / 1 days;
    }

    // =========================================================================
    // BRIDGE: BURN ON HEDERA
    // =========================================================================

    /**
     * @notice Burn UMC on Hedera to receive UMC on Polygon.
     * @dev User must first approve this contract to spend their UMC.
     *      The relayer detects the BridgeBurn event and mints on Polygon.
     * @param polygonRecipient The user's address on Polygon
     * @param amount The gross amount of UMC to bridge (fee deducted from this)
     */
    function bridgeToPolygon(
        address polygonRecipient,
        uint256 amount
    ) external whenNotPaused {
        if (polygonRecipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (amount < minBridgeAmount) revert BelowMinimum(amount, minBridgeAmount);
        if (amount > maxBridgeAmount) revert AboveMaximum(amount, maxBridgeAmount);

        // Reset daily volume if new day
        uint256 today = block.timestamp / 1 days;
        if (today > currentDay) {
            currentDay = today;
            dailyVolume = 0;
        }

        // Check daily limit
        if (dailyVolume + amount > dailyVolumeLimit) {
            revert DailyLimitExceeded(amount, dailyVolumeLimit - dailyVolume);
        }

        // Verify allowance and balance
        uint256 allowed = umcToken.allowance(msg.sender, address(this));
        if (allowed < amount) revert InsufficientAllowance(amount, allowed);
        uint256 balance = umcToken.balanceOf(msg.sender);
        if (balance < amount) revert InsufficientBalance(amount, balance);

        // Calculate fee
        uint256 fee = (amount * feeBasisPoints) / 10_000;
        uint256 netAmount = amount - fee;

        // Burn only the net amount, so burned-on-Hedera always equals
        // minted-on-Polygon and the peg reconciles without an off-chain ledger.
        // The fee moves to feeRecipient on-chain instead of being destroyed.
        umcToken.burnFrom(msg.sender, netAmount);
        if (fee > 0) {
            umcToken.transferFrom(msg.sender, feeRecipient, fee);
        }

        // Update daily volume
        dailyVolume += amount;

        // Record the burn
        uint256 nonce = bridgeNonce++;
        processedNonces[nonce] = true;
        burnRecords[nonce] = BridgeBurnRecord({
            hederaSender: msg.sender,
            polygonRecipient: polygonRecipient,
            amount: amount,
            fee: fee,
            netAmount: netAmount,
            timestamp: block.timestamp,
            exists: true
        });

        emit BridgeBurn(
            nonce,
            msg.sender,
            polygonRecipient,
            amount,
            fee,
            netAmount,
            block.timestamp
        );
    }

    // =========================================================================
    // VIEWS
    // =========================================================================

    /**
     * @notice Calculate the net amount and fee for a given bridge amount.
     */
    function calculateBridgeAmount(
        uint256 grossAmount
    ) external view returns (uint256 netAmount, uint256 fee) {
        fee = (grossAmount * feeBasisPoints) / 10_000;
        netAmount = grossAmount - fee;
    }

    /**
     * @notice Get remaining daily bridge volume.
     */
    function remainingDailyVolume() external view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        if (today > currentDay) return dailyVolumeLimit;
        return dailyVolumeLimit > dailyVolume
            ? dailyVolumeLimit - dailyVolume
            : 0;
    }

    /**
     * @notice Get burn record by nonce.
     */
    function getBurnRecord(
        uint256 nonce
    ) external view returns (BridgeBurnRecord memory) {
        return burnRecords[nonce];
    }

    // =========================================================================
    // ADMIN
    // =========================================================================

    function updateBridgeConfig(
        uint256 _minBridgeAmount,
        uint256 _maxBridgeAmount,
        uint256 _feeBasisPoints,
        uint256 _dailyVolumeLimit
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeBasisPoints > 1000) revert InvalidFee();
        minBridgeAmount = _minBridgeAmount;
        maxBridgeAmount = _maxBridgeAmount;
        feeBasisPoints = _feeBasisPoints;
        dailyVolumeLimit = _dailyVolumeLimit;
        emit BridgeConfigUpdated(
            _minBridgeAmount,
            _maxBridgeAmount,
            _feeBasisPoints,
            _dailyVolumeLimit
        );
    }

    function setFeeRecipient(
        address _feeRecipient
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(
        address
    ) internal override onlyRole(UPGRADER_ROLE) {}
}
