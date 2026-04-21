# Neverland: The Equity Protection Challenge

This folder contains the Foundry-based smart contract project for the Neverland mission: protect the homeowner's collateral from instant liquidation during a temporary ETH price dip.

## What Changed

- `Lending.sol` now exposes `getHealthFactor(address user)` using a 120% minimum collateral ratio.
- Liquidations are blocked for a 24-hour grace period after a position becomes unsafe.
- If the borrower restores their position above a health factor of `1.0`, the risk timer resets.
- `FlashLoanLiquidator.sol` proves that a flash-loan liquidator cannot bypass the protection window.
- The frontend now lives outside this Foundry project at the repo root in `/frontend`.

## Contracts

- `src/Corn.sol`: Minimal ERC20 used as the debt asset.
- `src/CornDEX.sol`: Swap contract plus ETH/CORN spot price used as the oracle.
- `src/Lending.sol`: Collateral, debt, health factor, grace-period liquidation logic, and CORN flash loans.
- `src/MovePrice.sol`: Test helper used to simulate market shocks.
- `src/FlashLoanLiquidator.sol`: Liquidates a borrower with a CORN flash loan once protection has expired.

## Foundry Usage

Build:

```bash
forge build
```

Test:

```bash
forge test
```

Deploy locally:

```bash
anvil
forge script script/Deploy.s.sol:DeployScript --rpc-url http://127.0.0.1:8545 --broadcast
```

## Neverland Proof

`test/NeverlandLending.t.sol` covers the core challenge flow:

1. Crash the ETH price with `MovePrice`.
2. Attempt immediate flash-loan liquidation and expect a revert.
3. Fast-forward time by 25 hours.
4. Run liquidation successfully.
5. Verify the timer resets if the borrower adds more ETH before the deadline.
