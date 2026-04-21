# Neverland Project Structure

This repository is now split into two separate parts:

- `Contracts/`: the Foundry smart contract project.
- `frontend/`: the Next.js protection dashboard.

## Contracts

The protocol contracts, deployment script, and Foundry tests live in `Contracts/`.

```bash
cd Contracts
~/.foundry/bin/forge build
~/.foundry/bin/forge test
```

## Frontend

The protection dashboard lives in `frontend/`.

```bash
cd frontend
npm install
npm run dev
```

Set these environment variables for the dashboard:

```bash
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545
NEXT_PUBLIC_LENDING_ADDRESS=<deployed lending address>
NEXT_PUBLIC_HOMEOWNER_ADDRESS=<borrower address>
```
