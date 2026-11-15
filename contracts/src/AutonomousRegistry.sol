// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AutonomousRegistry
/// @notice An append-only registry of owner-submitted artifact metadata.
/// @dev `verified` is an owner-supplied assertion, not an on-chain verification.
/// This contract has no proxy or upgrade mechanism.
contract AutonomousRegistry {
    struct ArtifactRecord {
        bytes32 commitHash;
        string ipfsCid;
        address deployedContract;
        uint64 timestamp;
        bool verified;
    }

    address public owner;
    address public pendingOwner;
    uint256 public totalArtifacts;
    mapping(uint256 id => ArtifactRecord) public artifacts;

    event ArtifactRegistered(
        uint256 indexed id, bytes32 indexed commitHash, address indexed deployedContract, string ipfsCid
    );
    event OwnershipTransferStarted(address indexed currentOwner, address indexed proposedOwner);
    event OwnershipTransferCancelled(address indexed currentOwner, address indexed cancelledOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ZeroAddress();
    error AlreadyOwner();
    error NoPendingOwner();
    error TimestampOverflow();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    /// @notice Appends an artifact. IDs start at one and are never reused.
    /// @dev Content, deployment address, and verification are not validated;
    /// a zero deployed address can represent an artifact not deployed on-chain.
    function registerArtifact(bytes32 commitHash, string calldata ipfsCid, address deployedContract, bool verified)
        external
        onlyOwner
        returns (uint256 id)
    {
        // Metadata overflow guard only, not a time-based authorization or deadline.
        // slither-disable-next-line timestamp
        if (block.timestamp > type(uint64).max) revert TimestampOverflow();
        id = ++totalArtifacts;
        artifacts[id] = ArtifactRecord({
            commitHash: commitHash,
            ipfsCid: ipfsCid,
            deployedContract: deployedContract,
            timestamp: uint64(block.timestamp),
            verified: verified
        });
        emit ArtifactRegistered(id, commitHash, deployedContract, ipfsCid);
    }

    /// @notice Proposes a new owner; the current owner retains control until acceptance.
    /// @dev A new proposal replaces an existing one. Renouncing is not supported.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == owner) revert AlreadyOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Cancels an outstanding ownership proposal.
    function cancelOwnershipTransfer() external onlyOwner {
        address cancelledOwner = pendingOwner;
        if (cancelledOwner == address(0)) revert NoPendingOwner();
        delete pendingOwner;
        emit OwnershipTransferCancelled(owner, cancelledOwner);
    }

    /// @notice Completes a transfer initiated by the current owner.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert Unauthorized();
        address previousOwner = owner;
        owner = msg.sender;
        delete pendingOwner;
        emit OwnershipTransferred(previousOwner, msg.sender);
    }
}
