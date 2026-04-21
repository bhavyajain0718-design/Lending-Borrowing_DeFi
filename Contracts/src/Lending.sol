// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Corn} from "./Corn.sol";
import {CornDEX} from "./CornDEX.sol";
import {ICornFlashLoanReceiver} from "./interfaces/ICornFlashLoanReceiver.sol";

contract Lending {
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_COLLATERAL_RATIO_BPS = 12_000;
    uint256 public constant LIQUIDATION_BONUS_BPS = 11_000;
    uint256 public constant MIN_HEALTH_FACTOR = 1e18;
    uint256 public constant GRACE_PERIOD = 24 hours;

    Corn public immutable corn;
    CornDEX public immutable cornDex;

    mapping(address => uint256) public collateralBalance;
    mapping(address => uint256) public debtBalance;
    mapping(address => uint256) public riskSince;
    mapping(address => uint256) public lastAccountUpdate;

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed liquidator, address indexed user, uint256 repaidCorn, uint256 seizedEth);
    event RiskStatusUpdated(address indexed user, uint256 healthFactor, uint256 atRiskSince);
    event FlashLoan(address indexed receiver, uint256 amount, uint256 fee);

    error ZeroAmount();
    error Undercollateralized();
    error PositionHealthy();
    error GracePeriodActive(uint256 remaining);
    error ExcessiveRepayAmount(uint256 maxRepay);
    error EthTransferFailed();

    constructor(Corn _corn, CornDEX _cornDex) {
        corn = _corn;
        cornDex = _cornDex;
    }

    receive() external payable {}

    function depositCollateral() external payable {
        _depositFor(msg.sender, msg.value);
    }

    function withdrawCollateral(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        collateralBalance[msg.sender] -= amount;
        if (!_isHealthy(msg.sender)) revert Undercollateralized();
        _syncRiskState(msg.sender);

        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert EthTransferFailed();
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        debtBalance[msg.sender] += amount;
        if (!_isHealthy(msg.sender)) revert Undercollateralized();
        corn.mint(msg.sender, amount);
        _syncRiskState(msg.sender);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 debt = debtBalance[msg.sender];
        uint256 repaid = amount > debt ? debt : amount;
        corn.transferFrom(msg.sender, address(this), repaid);
        corn.burn(address(this), repaid);
        debtBalance[msg.sender] = debt - repaid;
        _syncRiskState(msg.sender);
        emit Repaid(msg.sender, repaid);
    }

    function liquidate(address user, uint256 repayAmount) external {
        if (repayAmount == 0) revert ZeroAmount();
        uint256 healthFactor = getHealthFactor(user);
        if (healthFactor >= MIN_HEALTH_FACTOR) revert PositionHealthy();

        uint256 effectiveRiskSince = _currentRiskSince(user, healthFactor);
        if (riskSince[user] == 0) {
            riskSince[user] = effectiveRiskSince;
        }

        uint256 graceEndsAt = effectiveRiskSince + GRACE_PERIOD;
        if (block.timestamp < graceEndsAt) revert GracePeriodActive(graceEndsAt - block.timestamp);

        uint256 maxRepay = getMaxLiquidationRepay(user);
        if (repayAmount > maxRepay) revert ExcessiveRepayAmount(maxRepay);

        corn.transferFrom(msg.sender, address(this), repayAmount);
        corn.burn(address(this), repayAmount);
        debtBalance[user] -= repayAmount;

        uint256 seizeEth = _cornValueToEth((repayAmount * LIQUIDATION_BONUS_BPS) / BPS);
        collateralBalance[user] -= seizeEth;

        (bool success,) = payable(msg.sender).call{value: seizeEth}("");
        if (!success) revert EthTransferFailed();

        _syncRiskState(user);
        emit Liquidated(msg.sender, user, repayAmount, seizeEth);
    }

    function flashLoan(ICornFlashLoanReceiver receiver, uint256 amount, bytes calldata data) external {
        uint256 fee = 0;
        corn.mint(address(receiver), amount);
        receiver.onCornFlashLoan(msg.sender, amount, fee, data);
        corn.transferFrom(address(receiver), address(this), amount + fee);
        corn.burn(address(this), amount + fee);
        emit FlashLoan(address(receiver), amount, fee);
    }

    function getCollateralValueInCorn(address user) public view returns (uint256) {
        return (collateralBalance[user] * cornDex.ethPriceInCorn()) / 1e18;
    }

    function getHealthFactor(address user) public view returns (uint256) {
        uint256 debt = debtBalance[user];
        if (debt == 0) {
            return type(uint256).max;
        }

        uint256 collateralValue = getCollateralValueInCorn(user);
        return (collateralValue * 1e18 * BPS) / (debt * MIN_COLLATERAL_RATIO_BPS);
    }

    function getMaxLiquidationRepay(address user) public view returns (uint256) {
        uint256 debt = debtBalance[user];
        uint256 collateralValue = getCollateralValueInCorn(user);
        uint256 collateralLimitedRepay = (collateralValue * BPS) / LIQUIDATION_BONUS_BPS;
        return debt < collateralLimitedRepay ? debt : collateralLimitedRepay;
    }

    function getProtectionState(address user)
        external
        view
        returns (uint256 healthFactor, uint256 atRiskSince, uint256 protectionEndsAt, bool canLiquidate)
    {
        healthFactor = getHealthFactor(user);
        atRiskSince = _currentRiskSince(user, healthFactor);

        if (atRiskSince == 0) {
            protectionEndsAt = 0;
            canLiquidate = false;
        } else {
            protectionEndsAt = atRiskSince + GRACE_PERIOD;
            canLiquidate = block.timestamp >= protectionEndsAt;
        }
    }

    function syncRiskState(address user) external {
        _syncRiskState(user);
    }

    function _depositFor(address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        collateralBalance[user] += amount;
        _syncRiskState(user);
        emit CollateralDeposited(user, amount);
    }

    function _syncRiskState(address user) internal {
        uint256 healthFactor = getHealthFactor(user);
        uint256 currentRiskStart = _currentRiskSince(user, healthFactor);
        riskSince[user] = currentRiskStart;
        lastAccountUpdate[user] = block.timestamp;
        emit RiskStatusUpdated(user, healthFactor, currentRiskStart);
    }

    function _currentRiskSince(address user, uint256 healthFactor) internal view returns (uint256) {
        if (debtBalance[user] == 0 || healthFactor >= MIN_HEALTH_FACTOR) {
            return 0;
        }

        uint256 existingRisk = riskSince[user];
        if (existingRisk != 0) {
            return existingRisk;
        }

        uint256 oracleUpdateAt = cornDex.lastPriceUpdateAt();
        if (oracleUpdateAt >= lastAccountUpdate[user]) {
            return oracleUpdateAt;
        }

        return block.timestamp;
    }

    function _isHealthy(address user) internal view returns (bool) {
        return getHealthFactor(user) >= MIN_HEALTH_FACTOR;
    }

    function _cornValueToEth(uint256 cornValue) internal view returns (uint256) {
        return (cornValue * 1e18) / cornDex.ethPriceInCorn();
    }
}
