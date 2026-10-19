// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title CircularityToken (CIRC)
 * @notice Incentive token minted to recyclers for verified recovery of
 * materials (gold, copper, tantalum, palladium, silicon) from end-of-life chips.
 * 1 CIRC = 1 kg of recovered material.
 */
contract CircularityToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor() ERC20("Circularity Credit", "CIRC") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
