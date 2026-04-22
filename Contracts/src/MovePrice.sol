// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CornDEX} from "./CornDEX.sol";
import {Lending} from "./Lending.sol";

contract MovePrice {
    CornDEX public immutable cornDex;
    Lending public immutable lending;
    address public owner;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(CornDEX _cornDex, Lending _lending) {
        cornDex = _cornDex;
        lending = _lending;
        owner = msg.sender;
    }

    function moveEthPriceInCorn(uint256 newPrice) external onlyOwner {
        cornDex.setEthPriceInCorn(newPrice);
        lending.syncAllRiskStates();
    }
}
