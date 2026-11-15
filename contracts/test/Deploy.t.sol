// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AutonomousRegistry} from "../src/AutonomousRegistry.sol";
import {DeployAutonomousRegistry} from "../script/Deploy.s.sol";

interface DeploymentTestVm {
    function setEnv(string calldata name, string calldata value) external;
    function chainId(uint256 newChainId) external;
    function addr(uint256 privateKey) external pure returns (address);
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
}

contract DeployAutonomousRegistryTest {
    DeploymentTestVm private constant vm = DeploymentTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant TEST_KEY = 1; // Public test key; never fund or use on a live network.
    address private constant SAFE_OWNER = address(0xB0B);

    // setEnv changes the process environment, which Foundry does not snapshot per
    // test. Keep all env mutations in one test to avoid concurrent-test races.
    function testDeploymentEnvironmentScenarios() public {
        DeployAutonomousRegistry deployer = new DeployAutonomousRegistry();
        vm.chainId(84532);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0x01");
        vm.setEnv("VFV_SAFE_OWNER", "");
        AutonomousRegistry registry = deployer.run();
        require(registry.owner() == vm.addr(TEST_KEY), "empty owner did not default to deployer");
        require(registry.pendingOwner() == address(0), "unexpected pending owner");

        vm.chainId(8453);
        vm.setEnv("VFV_SAFE_OWNER", "0x0000000000000000000000000000000000000B0b");
        registry = deployer.run();
        require(registry.owner() == SAFE_OWNER, "configured owner was not installed");
        require(registry.pendingOwner() == address(0), "unexpected pending owner");

        vm.setEnv("VFV_SAFE_OWNER", "0x0000000000000000000000000000000000000000");
        vm.expectRevert(AutonomousRegistry.ZeroAddress.selector);
        deployer.run();

        vm.setEnv("VFV_SAFE_OWNER", "not-an-address");
        vm.expectRevert();
        deployer.run();

        vm.setEnv("VFV_SAFE_OWNER", "");
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "");
        vm.expectRevert();
        deployer.run();

        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0x00");
        vm.expectRevert();
        deployer.run();
    }

    function testRejectsUnsupportedChain() public {
        DeployAutonomousRegistry deployer = new DeployAutonomousRegistry();
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployAutonomousRegistry.UnsupportedChain.selector, 1));
        deployer.run();
    }
}
