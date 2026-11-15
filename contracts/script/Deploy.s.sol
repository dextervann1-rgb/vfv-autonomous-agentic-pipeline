// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AutonomousRegistry} from "../src/AutonomousRegistry.sol";

// Only the Foundry cheatcodes used by this script are declared. No forge-std dependency is needed.
interface DeployVm {
    function envUint(string calldata name) external view returns (uint256 value);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory value);
    function parseAddress(string calldata value) external pure returns (address parsed);
    function addr(uint256 privateKey) external pure returns (address keyAddr);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Run against Base or Base Sepolia. Transactions are only sent when
/// forge script is explicitly invoked with --broadcast.
contract DeployAutonomousRegistry {
    DeployVm private constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error UnsupportedChain(uint256 chainId);

    function run() external returns (AutonomousRegistry registry) {
        if (block.chainid != 8453 && block.chainid != 84532) revert UnsupportedChain(block.chainid);

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        string memory configuredOwner = vm.envOr("VFV_SAFE_OWNER", string(""));
        address owner = bytes(configuredOwner).length == 0 ? deployer : vm.parseAddress(configuredOwner);
        if (owner == address(0)) revert AutonomousRegistry.ZeroAddress();

        vm.startBroadcast(deployerPrivateKey);
        registry = new AutonomousRegistry(owner);
        vm.stopBroadcast();
    }
}
