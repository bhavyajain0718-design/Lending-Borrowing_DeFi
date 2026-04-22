// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CornDEX} from "./CornDEX.sol";
import {Lending} from "./Lending.sol";

/// @title MovePrice
/// @author Bhavya Jain
/// @notice Owner-only helper used in tests and demos to move the CornDEX ETH/CORN price.
contract MovePrice {
    CornDEX public immutable cornDex;
    Lending public immutable lending;
    address public owner;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Initializes the helper with the DEX and lending contracts it coordinates.
    /// @param _cornDex Address of the CornDEX contract whose price is updated.
    /// @param _lending Address of the lending contract whose risk states are refreshed.
    constructor(CornDEX _cornDex, Lending _lending) {
        cornDex = _cornDex;
        lending = _lending;
        owner = msg.sender;
    }

    /// @notice Updates the ETH/CORN price and refreshes borrower protection states.
    /// @param newPrice New price quoted as CORN per 1 ETH using 18 decimals.
    function moveEthPriceInCorn(uint256 newPrice) external onlyOwner {
        cornDex.setEthPriceInCorn(newPrice);
        lending.syncAllRiskStates();
    }
}
