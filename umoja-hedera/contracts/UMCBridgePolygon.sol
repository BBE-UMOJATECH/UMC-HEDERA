// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IUMCTokenPolygon {
    function mint(address to, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title UMCBridgePolygon - Mint side of the Hedera to Polygon bridge
 * @notice Receives signed EIP-712 attestations from relayers to mint UMC on Polygon.
 *
 * @dev Security:
 *   - EIP-712 typed signatures prevent replay across chains/contracts
 *   - Nonce replay protection (each Hedera burn nonce mints exactly once)
 *   - Value-tiered signatures (more sigs for large amounts)
 *   - Time-bounded claims (attestations expire)
 *   - Pausable for emergencies
 */
contract UMCBridgePolygon is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using ECDSA for bytes32;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    bytes32 public constant MINT_TYPEHASH = keccak256(
        "MintAttestation(uint256 hederaNonce,address polygonRecipient,uint256 amount,uint256 deadline)"
    );

    IUMCTokenPolygon public umcToken;
    mapping(uint256 => bool) public claimedNonces;

    uint256 public requiredSignatures;
    uint256 public highValueThreshold;
    uint256 public highValueRequiredSignatures;
    uint256 public claimWindow;
    uint256 public totalBridgedAmount;

    struct ClaimRecord {
        address recipient;
        uint256 amount;
        uint256 hederaNonce;
        uint256 claimedAt;
    }
    mapping(uint256 => ClaimRecord) public claims;

    event BridgeMint(uint256 indexed hederaNonce, address indexed polygonRecipient, uint256 amount, uint256 timestamp);
    event ClaimWindowUpdated(uint256 newWindow);
    event SignatureConfigUpdated(uint256 required, uint256 hvThreshold, uint256 hvRequired);

    error InvalidAddress();
    error InvalidAmount();
    error NonceAlreadyClaimed(uint256 nonce);
    error AttestationExpired(uint256 deadline, uint256 currentTime);
    error DeadlineExceedsClaimWindow(uint256 deadline, uint256 latestAllowedDeadline);
    error InsufficientSignatures(uint256 provided, uint256 required);
    error InvalidSignature();
    error DuplicateSigner();
    error InvalidClaimWindow();
    error InvalidSignatureConfig();

    function initialize(
        address _umcToken, address _admin, address _relayer, uint256 _claimWindow
    ) public initializer {
        if (_umcToken == address(0)) revert InvalidAddress();
        if (_admin == address(0)) revert InvalidAddress();
        if (_relayer == address(0)) revert InvalidAddress();
        if (_claimWindow == 0) revert InvalidClaimWindow();

        __AccessControl_init();
        __Pausable_init();
        __EIP712_init("UMCBridge", "1");

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(RELAYER_ROLE, _relayer);
        _grantRole(OPERATOR_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);

        umcToken = IUMCTokenPolygon(_umcToken);
        requiredSignatures = 1;
        highValueThreshold = 1_000_000 * 1e6;
        highValueRequiredSignatures = 2;
        claimWindow = _claimWindow;
    }

    /**
     * @notice Claim bridged UMC using relayer-signed EIP-712 attestation(s).
     * @param hederaNonce Burn nonce from Hedera bridge contract
     * @param polygonRecipient Recipient address (must match signed data)
     * @param amount Net amount to mint (must match signed data)
     * @param deadline Expiry timestamp (must match signed data)
     * @param signatures Array of EIP-712 relayer signatures
     */
    function claimMint(
        uint256 hederaNonce,
        address polygonRecipient,
        uint256 amount,
        uint256 deadline,
        bytes[] calldata signatures
    ) external whenNotPaused {
        if (polygonRecipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (claimedNonces[hederaNonce]) revert NonceAlreadyClaimed(hederaNonce);
        if (block.timestamp > deadline) revert AttestationExpired(deadline, block.timestamp);
        uint256 latestAllowedDeadline = block.timestamp + claimWindow;
        if (deadline > latestAllowedDeadline) {
            revert DeadlineExceedsClaimWindow(deadline, latestAllowedDeadline);
        }

        uint256 sigsRequired = amount >= highValueThreshold
            ? highValueRequiredSignatures : requiredSignatures;

        if (signatures.length < sigsRequired) {
            revert InsufficientSignatures(signatures.length, sigsRequired);
        }

        bytes32 structHash = keccak256(
            abi.encode(MINT_TYPEHASH, hederaNonce, polygonRecipient, amount, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        address[] memory signers = new address[](signatures.length);
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!hasRole(RELAYER_ROLE, signer)) revert InvalidSignature();
            for (uint256 j = 0; j < i; j++) {
                if (signers[j] == signer) revert DuplicateSigner();
            }
            signers[i] = signer;
        }

        claimedNonces[hederaNonce] = true;
        claims[hederaNonce] = ClaimRecord({
            recipient: polygonRecipient,
            amount: amount,
            hederaNonce: hederaNonce,
            claimedAt: block.timestamp
        });
        totalBridgedAmount += amount;

        umcToken.mint(polygonRecipient, amount);
        emit BridgeMint(hederaNonce, polygonRecipient, amount, block.timestamp);
    }

    function isNonceClaimed(uint256 nonce) external view returns (bool) { return claimedNonces[nonce]; }
    function getDomainSeparator() external view returns (bytes32) { return _domainSeparatorV4(); }

    function computeMintDigest(
        uint256 hederaNonce, address polygonRecipient, uint256 amount, uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(MINT_TYPEHASH, hederaNonce, polygonRecipient, amount, deadline))
        );
    }

    function setClaimWindow(uint256 _claimWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_claimWindow == 0) revert InvalidClaimWindow();
        claimWindow = _claimWindow;
        emit ClaimWindowUpdated(_claimWindow);
    }

    function setSignatureConfig(
        uint256 _required, uint256 _hvThreshold, uint256 _hvRequired
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_required == 0 || _hvRequired == 0 || _hvRequired < _required) {
            revert InvalidSignatureConfig();
        }
        requiredSignatures = _required;
        highValueThreshold = _hvThreshold;
        highValueRequiredSignatures = _hvRequired;
        emit SignatureConfigUpdated(_required, _hvThreshold, _hvRequired);
    }

    function pause() external onlyRole(OPERATOR_ROLE) { _pause(); }
    function unpause() external onlyRole(OPERATOR_ROLE) { _unpause(); }
    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
