# Neverland Lending

Neverland Lending is a small DeFi lending protocol built with Foundry contracts and a Next.js frontend.

Users can:

- deposit ETH as collateral
- borrow `CORN` against that collateral
- repay `CORN` to reduce debt
- withdraw collateral while staying above the safety floor
- monitor the 24-hour protection window when a position becomes unhealthy
- liquidate expired unhealthy positions

## What Is Implemented

### Protocol rules

- Minimum collateral ratio: `120%`
- Liquidation bonus: `10%` equivalent via `LIQUIDATION_BONUS_BPS = 11000`
- Health factor threshold: `1.0`
- Grace / protection window: `24 hours`

The protocol calculates collateral value from the on-chain `CornDEX` ETH/CORN price and uses that to derive:

- collateral value in CORN
- health factor
- liquidation eligibility
- protection end time

### Contracts

Located in [Contracts/src](/home/bhavya_jain/Assignment/DefiApp/Contracts/src).

- [Corn.sol](/home/bhavya_jain/Assignment/DefiApp/Contracts/src/Corn.sol): ERC-20 token borrowed by users
- [CornDEX.sol](/home/bhavya_jain/Assignment/DefiApp/Contracts/src/CornDEX.sol): price source and simple CORN/ETH swap contract
- [Lending.sol](/home/bhavya_jain/Assignment/DefiApp/Contracts/src/Lending.sol): collateral, borrowing, repayment, health factor, grace period, liquidation
- [MovePrice.sol](/home/bhavya_jain/Assignment/DefiApp/Contracts/src/MovePrice.sol): owner tool used to move the ETH/CORN price for testing
- [FlashLoanLiquidator.sol](/home/bhavya_jain/Assignment/DefiApp/Contracts/src/FlashLoanLiquidator.sol): helper for flash-loan-assisted liquidation flows

### Frontend

Located in [frontend](/home/bhavya_jain/Assignment/DefiApp/frontend).

Current UI includes:

- wallet connect / change / disconnect flow
- connected-wallet dashboard
- live collateral / debt / ratio display
- borrow panel with max safe borrow guidance
- withdraw guardrails with unhealthy-loan warning
- repay flow that caps approval to actual outstanding debt
- liquidation form
- liquidation watch tab for tracked borrower addresses
- status indicator:
  - green: healthy
  - yellow: protection active
  - red: protection expired
- collateral / debt ratio history chart

Important note:

- the liquidation watch tab is based on a local tracked-address watchlist
- there is no on-chain borrower registry in the contracts right now

## How The Protection Window Works

When a borrower falls below the safe health factor:

1. the contract records when the position first became at risk
2. liquidation is blocked for `24 hours`
3. if the user restores the position, the risk timestamp resets
4. if the 24 hours expire while the position is still unhealthy, liquidation becomes allowed

This logic is implemented in [Lending.sol](/home/bhavya_jain/Assignment/DefiApp/Contracts/src/Lending.sol:1) and tested in the Foundry suite.

## Repo Structure

```text
DefiApp/
├── Contracts/
│   ├── script/
│   ├── src/
│   └── test/
│       ├── integration/
│       └── unit/
└── frontend/
    ├── app/
    ├── components/
    └── lib/
```

## Local Development

### 1. Install dependencies

Frontend:

```bash
cd /home/bhavya_jain/Assignment/DefiApp/frontend
npm install
```

Contracts:

- install Foundry if you do not already have it:
  - https://book.getfoundry.sh/getting-started/installation

### 2. Build and test contracts

```bash
cd /home/bhavya_jain/Assignment/DefiApp/Contracts
~/.foundry/bin/forge build
~/.foundry/bin/forge test
```

### 3. Configure frontend env

Create [frontend/.env.local](/home/bhavya_jain/Assignment/DefiApp/frontend/.env.local:1):

```env
NEXT_PUBLIC_RPC_URL=<your-rpc-url>
NEXT_PUBLIC_LENDING_ADDRESS=<deployed-lending-address>
NEXT_PUBLIC_HOMEOWNER_ADDRESS=<default-borrower-address>
```

Example template:

- [frontend/.env.local.example](/home/bhavya_jain/Assignment/DefiApp/frontend/.env.local.example:1)

### 4. Run the frontend

```bash
cd /home/bhavya_jain/Assignment/DefiApp/frontend
npm run dev -- --port 3002
```

Open:

- `http://localhost:3002`

## Deployment

Deploy script:

- [Contracts/script/Deploy.s.sol](/home/bhavya_jain/Assignment/DefiApp/Contracts/script/Deploy.s.sol:1)

Broadcast with Foundry:

```bash
cd /home/bhavya_jain/Assignment/DefiApp/Contracts

~/.foundry/bin/forge script script/Deploy.s.sol:DeployScript \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

The deploy script creates and wires:

- `Corn`
- `CornDEX`
- `Lending`
- `MovePrice`
- `FlashLoanLiquidator`

## Testing

Tests are split into:

- unit tests: [Contracts/test/unit](/home/bhavya_jain/Assignment/DefiApp/Contracts/test/unit)
- integration tests: [Contracts/test/integration](/home/bhavya_jain/Assignment/DefiApp/Contracts/test/integration)

Run all tests:

```bash
cd /home/bhavya_jain/Assignment/DefiApp/Contracts
~/.foundry/bin/forge test
```

Run only unit tests:

```bash
~/.foundry/bin/forge test --match-path "test/unit/*.t.sol"
```

Run only integration tests:

```bash
~/.foundry/bin/forge test --match-path "test/integration/*.t.sol"
```

Covered flows include:

- deployment wiring
- health factor calculation
- price crash via `MovePrice`
- protection window activation
- immediate liquidation blocked during grace period
- liquidation after 25 hours
- risk timestamp reset after recovery
- token and DEX edge/revert cases

## Typical User Flows

### Borrower

1. Connect wallet
2. Deposit ETH
3. Borrow CORN within the safe range shown in the UI
4. Monitor status and health factor
5. Repay CORN and withdraw ETH later

### Liquidator

1. Track borrower addresses in `Liquidation Watch`
2. Wait until protection expires
3. Use the address in the liquidation form
4. Approve CORN and liquidate the expired unhealthy position

## Current Limitations

- no on-chain borrower index / registry
- liquidation watch depends on tracked addresses in the frontend
- chart history is frontend-observed history, not historical on-chain candle data
- this is a demo project and should not be treated as production-ready financial software

## License

MIT
