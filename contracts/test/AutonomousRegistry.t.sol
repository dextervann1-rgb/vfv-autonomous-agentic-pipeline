// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AutonomousRegistry} from "../src/AutonomousRegistry.sol";

// A minimal local interface keeps the test suite independent of forge-std.
interface TestVm {
    function prank(address sender) external;
    function expectRevert(bytes4 revertData) external;
    function expectEmit(bool, bool, bool, bool) external;
    function expectEmit(bool, bool, bool, bool, address emitter) external;
    function assume(bool condition) external;
    function warp(uint256 timestamp) external;
}

contract ContractOwner {
    function accept(AutonomousRegistry registry) external {
        registry.acceptOwnership();
    }

    function register(AutonomousRegistry registry) external returns (uint256) {
        return registry.registerArtifact(bytes32(uint256(1)), "contract-owner", address(0), false);
    }
}

contract AutonomousRegistryTest {
    TestVm private constant vm = TestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OWNER = address(0xA11CE);
    address private constant NEXT_OWNER = address(0xB0B);
    address private constant OTHER = address(0xCAFE);
    AutonomousRegistry private registry;

    event ArtifactRegistered(
        uint256 indexed id, bytes32 indexed commitHash, address indexed deployedContract, string ipfsCid
    );
    event OwnershipTransferStarted(address indexed currentOwner, address indexed proposedOwner);
    event OwnershipTransferCancelled(address indexed currentOwner, address indexed cancelledOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        registry = new AutonomousRegistry(OWNER);
    }

    function testConstructorInitializesOwnerAndEmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(address(0), NEXT_OWNER);
        AutonomousRegistry newRegistry = new AutonomousRegistry(NEXT_OWNER);
        require(newRegistry.owner() == NEXT_OWNER, "wrong initial owner");
        require(newRegistry.pendingOwner() == address(0), "pending owner not empty");
        require(newRegistry.totalArtifacts() == 0, "nonzero count");
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(AutonomousRegistry.ZeroAddress.selector);
        new AutonomousRegistry(address(0));
    }

    function testFuzz_ConstructorAcceptsNonzeroOwner(address initialOwner) public {
        vm.assume(initialOwner != address(0));
        AutonomousRegistry newRegistry = new AutonomousRegistry(initialOwner);
        require(newRegistry.owner() == initialOwner, "wrong initial owner");
    }

    function testRegisterStoresAllFieldsAndEmitsEvent() public {
        bytes32 hash = keccak256("commit-1");
        string memory cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
        vm.warp(123456);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ArtifactRegistered(1, hash, OTHER, cid);
        vm.prank(OWNER);
        uint256 id = registry.registerArtifact(hash, cid, OTHER, true);

        require(id == 1 && registry.totalArtifacts() == 1, "wrong id/count");
        (bytes32 gotHash, string memory gotCid, address deployed, uint64 timestamp, bool verified) =
            registry.artifacts(id);
        require(gotHash == hash, "wrong hash");
        require(keccak256(bytes(gotCid)) == keccak256(bytes(cid)), "wrong CID");
        require(deployed == OTHER, "wrong deployment");
        require(timestamp == 123456, "wrong timestamp");
        require(verified, "wrong assertion");
    }

    function testUnregisteredIdsAreDefaultValues() public view {
        (bytes32 hash, string memory cid, address deployed, uint64 timestamp, bool verified) = registry.artifacts(0);
        require(hash == bytes32(0) && bytes(cid).length == 0, "unexpected default fields");
        require(deployed == address(0) && timestamp == 0 && !verified, "unexpected default fields");
        require(registry.totalArtifacts() == 0, "unexpected record count");
    }

    function testEmptyFieldsAreAllowedAndRecordsRemainDistinct() public {
        vm.warp(101);
        vm.prank(OWNER);
        uint256 first = registry.registerArtifact(bytes32(0), "", address(0), false);
        vm.warp(202);
        vm.prank(OWNER);
        uint256 second = registry.registerArtifact(bytes32(uint256(2)), "second", OTHER, true);
        require(first == 1 && second == 2 && registry.totalArtifacts() == 2, "wrong ids");
        (bytes32 hash1, string memory cid1, address deployed1, uint64 time1, bool verified1) = registry.artifacts(first);
        require(hash1 == 0 && bytes(cid1).length == 0 && deployed1 == address(0), "first record changed");
        require(time1 == 101 && !verified1, "first record changed");
        (bytes32 hash2, string memory cid2, address deployed2, uint64 time2, bool verified2) =
            registry.artifacts(second);
        require(hash2 == bytes32(uint256(2)) && keccak256(bytes(cid2)) == keccak256("second"), "bad second record");
        require(deployed2 == OTHER && time2 == 202 && verified2, "bad second record");
    }

    function testTimestampMaximumAndOverflow() public {
        vm.warp(type(uint64).max);
        vm.prank(OWNER);
        registry.registerArtifact(bytes32(0), "", address(0), false);
        (,,, uint64 timestamp,) = registry.artifacts(1);
        require(timestamp == type(uint64).max, "timestamp truncated");
        vm.warp(uint256(type(uint64).max) + 1);
        vm.expectRevert(AutonomousRegistry.TimestampOverflow.selector);
        vm.prank(OWNER);
        registry.registerArtifact(bytes32(0), "", address(0), false);
        require(registry.totalArtifacts() == 1, "failed registration changed count");
    }

    function testFuzz_RegistrationRoundTrips(
        bytes32 hash,
        string calldata cid,
        address deployed,
        bool verified,
        uint64 time
    ) public {
        vm.warp(time);
        vm.prank(OWNER);
        uint256 id = registry.registerArtifact(hash, cid, deployed, verified);
        (bytes32 actualHash, string memory actualCid, address actualDeployed, uint64 actualTime, bool actualVerified) =
            registry.artifacts(id);
        require(id == 1 && registry.totalArtifacts() == 1, "wrong id");
        require(actualHash == hash && keccak256(bytes(actualCid)) == keccak256(bytes(cid)), "wrong metadata");
        require(actualDeployed == deployed && actualTime == time && actualVerified == verified, "wrong fields");
    }

    function testFuzz_SequentialRecordsPersist(uint8 rawCount, bytes32 seed) public {
        uint256 count = uint256(rawCount) % 17;
        vm.warp(123);
        for (uint256 i = 0; i < count; i++) {
            bytes32 hash = keccak256(abi.encode(seed, i));
            vm.prank(OWNER);
            uint256 id = registry.registerArtifact(hash, "sequence", address(0), false);
            require(id == i + 1, "nonsequential id");
        }
        require(registry.totalArtifacts() == count, "wrong record count");
        for (uint256 i = 0; i < count; i++) {
            (bytes32 hash, string memory cid, address deployed, uint64 timestamp, bool verified) =
                registry.artifacts(i + 1);
            require(hash == keccak256(abi.encode(seed, i)), "previous hash changed");
            require(keccak256(bytes(cid)) == keccak256("sequence"), "previous CID changed");
            require(deployed == address(0) && timestamp == 123 && !verified, "previous record changed");
        }
    }

    function testTransferRequiresAcceptanceAndEmitsEvents() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit OwnershipTransferStarted(OWNER, NEXT_OWNER);
        vm.prank(OWNER);
        registry.transferOwnership(NEXT_OWNER);
        require(registry.owner() == OWNER && registry.pendingOwner() == NEXT_OWNER, "proposal changed owner");

        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(NEXT_OWNER);
        registry.registerArtifact(bytes32(0), "", address(0), false);
        vm.prank(OWNER);
        registry.registerArtifact(bytes32(0), "old owner still active", address(0), false);

        vm.expectEmit(true, true, false, true, address(registry));
        emit OwnershipTransferred(OWNER, NEXT_OWNER);
        vm.prank(NEXT_OWNER);
        registry.acceptOwnership();
        require(registry.owner() == NEXT_OWNER && registry.pendingOwner() == address(0), "acceptance failed");
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(OWNER);
        registry.registerArtifact(bytes32(0), "", address(0), false);
        vm.prank(NEXT_OWNER);
        registry.registerArtifact(bytes32(0), "new owner active", address(0), false);
        require(registry.totalArtifacts() == 2, "unexpected registrations");
    }

    function testTransferRejectsZeroAndCurrentOwnerWithoutChangingProposal() public {
        vm.prank(OWNER);
        registry.transferOwnership(NEXT_OWNER);
        vm.expectRevert(AutonomousRegistry.ZeroAddress.selector);
        vm.prank(OWNER);
        registry.transferOwnership(address(0));
        vm.expectRevert(AutonomousRegistry.AlreadyOwner.selector);
        vm.prank(OWNER);
        registry.transferOwnership(OWNER);
        require(registry.owner() == OWNER && registry.pendingOwner() == NEXT_OWNER, "proposal changed");
    }

    function testOnlyPendingOwnerCanAccept() public {
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        registry.acceptOwnership();
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(address(0));
        registry.acceptOwnership();
        vm.prank(OWNER);
        registry.transferOwnership(NEXT_OWNER);
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(OTHER);
        registry.acceptOwnership();
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(OWNER);
        registry.acceptOwnership();
        require(registry.owner() == OWNER && registry.pendingOwner() == NEXT_OWNER, "invalid acceptance changed state");
    }

    function testCancelTransferAndRejectStaleAcceptance() public {
        vm.prank(OWNER);
        registry.transferOwnership(NEXT_OWNER);
        vm.expectEmit(true, true, false, true, address(registry));
        emit OwnershipTransferCancelled(OWNER, NEXT_OWNER);
        vm.prank(OWNER);
        registry.cancelOwnershipTransfer();
        require(registry.owner() == OWNER && registry.pendingOwner() == address(0), "cancellation failed");
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(NEXT_OWNER);
        registry.acceptOwnership();
        vm.expectRevert(AutonomousRegistry.NoPendingOwner.selector);
        vm.prank(OWNER);
        registry.cancelOwnershipTransfer();
    }

    function testReplacingPendingOwnerInvalidatesOldProposal() public {
        vm.prank(OWNER);
        registry.transferOwnership(NEXT_OWNER);
        vm.prank(OWNER);
        registry.transferOwnership(OTHER);
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(NEXT_OWNER);
        registry.acceptOwnership();
        vm.prank(OTHER);
        registry.acceptOwnership();
        require(registry.owner() == OTHER && registry.pendingOwner() == address(0), "replacement failed");
    }

    function testContractCanAcceptAndExerciseOwnership() public {
        ContractOwner safeLike = new ContractOwner();
        vm.prank(OWNER);
        registry.transferOwnership(address(safeLike));
        safeLike.accept(registry);
        require(registry.owner() == address(safeLike), "contract cannot accept");
        require(safeLike.register(registry) == 1, "contract owner cannot register");
    }

    function testFuzz_UnauthorizedCallerCannotMutate(address attacker, bytes32 hash, string calldata cid) public {
        vm.assume(attacker != OWNER && attacker != NEXT_OWNER && attacker != address(0));
        vm.prank(OWNER);
        registry.transferOwnership(NEXT_OWNER);
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(attacker);
        registry.registerArtifact(hash, cid, attacker, true);
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(attacker);
        registry.transferOwnership(attacker);
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(attacker);
        registry.cancelOwnershipTransfer();
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(attacker);
        registry.acceptOwnership();
        require(registry.totalArtifacts() == 0, "unauthorized registration");
        require(registry.owner() == OWNER && registry.pendingOwner() == NEXT_OWNER, "unauthorized ownership change");
    }

    function testFuzz_TwoStepOwnership(address proposedOwner) public {
        vm.assume(proposedOwner != address(0) && proposedOwner != OWNER);
        vm.prank(OWNER);
        registry.transferOwnership(proposedOwner);
        require(registry.owner() == OWNER && registry.pendingOwner() == proposedOwner, "proposal failed");
        vm.prank(proposedOwner);
        registry.acceptOwnership();
        require(registry.owner() == proposedOwner && registry.pendingOwner() == address(0), "acceptance failed");
        vm.expectRevert(AutonomousRegistry.Unauthorized.selector);
        vm.prank(OWNER);
        registry.transferOwnership(OTHER);
    }
}
