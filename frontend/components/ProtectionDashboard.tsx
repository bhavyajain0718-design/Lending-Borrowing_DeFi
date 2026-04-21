"use client";

import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  formatEther,
  formatUnits,
  parseEther,
} from "ethers";
import { useEffect, useMemo, useRef, useState } from "react";
import { lendingAbi } from "../lib/lendingAbi";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
  }
}

type ProtectionState = {
  healthFactor: number;
  atRiskSince: number;
  protectionEndsAt: number;
  canLiquidate: boolean;
};

type DashboardState = {
  collateralEth: number;
  collateralValueCorn: number;
  debtCorn: number;
  healthFactor: number;
  maxLiquidationRepayCorn: number;
  cornDexAddress: string;
  cornAddress: string;
  cornPriceEth: number;
  walletEth: number;
  walletCorn: number;
  protection: ProtectionState;
};

type Props = {
  lendingAddress?: string;
  homeownerAddress?: string;
  rpcUrl?: string;
  pollIntervalMs?: number;
};

type TabId = "home" | "dashboard" | "debug";
type TxState = { kind: "idle" } | { kind: "pending"; label: string } | { kind: "success"; label: string } | { kind: "error"; label: string };
type FormState = {
  depositEth: string;
  withdrawEth: string;
  borrowCorn: string;
  repayCorn: string;
  liquidateUser: string;
  liquidateCorn: string;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SEPOLIA_CHAIN_ID = "0xaa36a7";
const MIN_RATIO_PERCENT = 120;

const statusCopy = {
  secure: {
    title: "Equity Secure",
    tone: "secure",
    description: "The home remains safely over-collateralized. No liquidation can happen right now.",
  },
  active: {
    title: "Safety Net Active",
    tone: "active",
    description: "The market moved against the home, but the 24-hour recovery window is still protecting it.",
  },
  expired: {
    title: "Protection Expired",
    tone: "expired",
    description: "The grace period is over. A liquidator can now close the position unless collateral is restored.",
  },
} as const;

function isConfiguredAddress(value?: string) {
  return Boolean(value && /^0x[a-fA-F0-9]{40}$/.test(value) && value !== ZERO_ADDRESS);
}

function normalizeAddress(address?: string) {
  return address ? address.toLowerCase() : "";
}

function formatAmount(value: number, decimals = 4) {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatCountdown(remainingSeconds: number) {
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  return `${hours}h ${minutes}m remaining`;
}

function ratioToPercent(healthFactor: number) {
  if (!Number.isFinite(healthFactor) || healthFactor > 1e12) {
    return Infinity;
  }
  return healthFactor * MIN_RATIO_PERCENT;
}

function buildTrendPoints(ratioPercent: number) {
  const safeRatio = Number.isFinite(ratioPercent) ? ratioPercent : 145;
  return [safeRatio - 12, safeRatio - 6, safeRatio - 8, safeRatio - 4, safeRatio].map((value, index) => ({
    x: (index / 4) * 100,
    y: Math.max(95, Math.min(150, value)),
  }));
}

function chartPath(points: Array<{ x: number; y: number }>) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${150 - point.y}`)
    .join(" ");
}

function parseInputAmount(raw: string, unit: "eth" | "corn") {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Enter an amount first.");
  }
  return parseEther(trimmed);
}

function extractErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const maybeShortMessage = Reflect.get(error, "shortMessage");
    if (typeof maybeShortMessage === "string") return maybeShortMessage;
    const maybeReason = Reflect.get(error, "reason");
    if (typeof maybeReason === "string") return maybeReason;
    const maybeMessage = Reflect.get(error, "message");
    if (typeof maybeMessage === "string") return maybeMessage;
  }
  return "Transaction failed";
}

export function ProtectionDashboard({
  lendingAddress,
  homeownerAddress,
  rpcUrl,
  pollIntervalMs = 5000,
}: Props) {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<TabId>("dashboard");
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [txState, setTxState] = useState<TxState>({ kind: "idle" });
  const [forms, setForms] = useState<FormState>({
    depositEth: "",
    withdrawEth: "",
    borrowCorn: "",
    repayCorn: "",
    liquidateUser: homeownerAddress ?? "",
    liquidateCorn: "",
  });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const providerRef = useRef<JsonRpcProvider | null>(null);

  const viewedAddress = useMemo(
    () => normalizeAddress(connectedAddress ?? homeownerAddress),
    [connectedAddress, homeownerAddress],
  );

  useEffect(() => {
    setForms(current => ({
      ...current,
      liquidateUser: current.liquidateUser || homeownerAddress || "",
    }));
  }, [homeownerAddress]);

  useEffect(() => {
    if (!rpcUrl) {
      providerRef.current = null;
      return;
    }
    providerRef.current = new JsonRpcProvider(rpcUrl);
  }, [rpcUrl]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!window.ethereum?.on) return;

    const handleAccountsChanged = (accounts: unknown) => {
      const nextAccount = Array.isArray(accounts) && typeof accounts[0] === "string" ? normalizeAddress(accounts[0]) : null;
      setConnectedAddress(nextAccount);
    };

    const handleChainChanged = () => {
      void refreshDashboard();
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  async function ensureWalletReady() {
    if (!window.ethereum) {
      throw new Error("No browser wallet found. Open this page in MetaMask-enabled browser.");
    }

    const chainId = (await window.ethereum.request({ method: "eth_chainId" })) as string;
    if (chainId !== SEPOLIA_CHAIN_ID) {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_CHAIN_ID }],
      });
    }

    const browserProvider = new BrowserProvider(window.ethereum);
    const signer = await browserProvider.getSigner();
    const signerAddress = normalizeAddress(await signer.getAddress());
    setConnectedAddress(signerAddress);
    return { browserProvider, signer, signerAddress };
  }

  async function connectWallet() {
    try {
      if (!window.ethereum) {
        throw new Error("MetaMask or another EVM wallet is required to connect.");
      }
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const nextAccount = accounts[0] ? normalizeAddress(accounts[0]) : null;
      setConnectedAddress(nextAccount);
      setError(null);
    } catch (connectError) {
      setError(extractErrorMessage(connectError));
    }
  }

  async function refreshDashboard() {
    try {
      if (!rpcUrl) {
        throw new Error("Missing NEXT_PUBLIC_RPC_URL. Add it before starting the frontend.");
      }
      if (!isConfiguredAddress(lendingAddress)) {
        throw new Error("NEXT_PUBLIC_LENDING_ADDRESS is missing or invalid.");
      }

      const accountToView = viewedAddress || normalizeAddress(homeownerAddress);
      if (!isConfiguredAddress(accountToView)) {
        throw new Error("Connect a wallet or configure NEXT_PUBLIC_HOMEOWNER_ADDRESS.");
      }

      const provider = providerRef.current;
      if (!provider) return;

      const lending = new Contract(lendingAddress, lendingAbi, provider);
      const [
        collateralBalance,
        debtBalance,
        collateralValueInCorn,
        healthFactor,
        maxLiquidationRepay,
        cornDexAddress,
        cornAddress,
        protectionState,
        walletEthRaw,
      ] = await Promise.all([
        lending.collateralBalance(accountToView),
        lending.debtBalance(accountToView),
        lending.getCollateralValueInCorn(accountToView),
        lending.getHealthFactor(accountToView),
        lending.getMaxLiquidationRepay(accountToView),
        lending.cornDex(),
        lending.corn(),
        lending.getProtectionState(accountToView),
        provider.getBalance(accountToView),
      ]);

      const cornDex = new Contract(cornDexAddress, lendingAbi, provider);
      const cornToken = new Contract(cornAddress, lendingAbi, provider);
      const [cornPriceInCorn, walletCornRaw] = await Promise.all([
        cornDex.ethPriceInCorn(),
        cornToken.balanceOf(accountToView),
      ]);

      setDashboard({
        collateralEth: Number(formatEther(collateralBalance)),
        collateralValueCorn: Number(formatUnits(collateralValueInCorn, 18)),
        debtCorn: Number(formatUnits(debtBalance, 18)),
        healthFactor: Number(formatUnits(healthFactor, 18)),
        maxLiquidationRepayCorn: Number(formatUnits(maxLiquidationRepay, 18)),
        cornDexAddress,
        cornAddress,
        cornPriceEth: 1 / Number(formatUnits(cornPriceInCorn, 18)),
        walletEth: Number(formatEther(walletEthRaw)),
        walletCorn: Number(formatUnits(walletCornRaw, 18)),
        protection: {
          healthFactor: Number(formatUnits(protectionState[0], 18)),
          atRiskSince: Number(protectionState[1]),
          protectionEndsAt: Number(protectionState[2]),
          canLiquidate: Boolean(protectionState[3]),
        },
      });
      setError(null);
    } catch (loadError) {
      setError(extractErrorMessage(loadError));
    }
  }

  useEffect(() => {
    void refreshDashboard();
    const poll = window.setInterval(() => {
      void refreshDashboard();
    }, pollIntervalMs);
    return () => window.clearInterval(poll);
  }, [viewedAddress, homeownerAddress, lendingAddress, pollIntervalMs, rpcUrl]);

  async function runTransaction(label: string, action: () => Promise<void>) {
    try {
      setTxState({ kind: "pending", label: `${label} submitted. Waiting for confirmation...` });
      await action();
      setTxState({ kind: "success", label: `${label} confirmed on Sepolia.` });
      await refreshDashboard();
    } catch (txError) {
      setTxState({ kind: "error", label: extractErrorMessage(txError) });
    }
  }

  async function handleDeposit() {
    await runTransaction("Collateral deposit", async () => {
      const { signer } = await ensureWalletReady();
      const lending = new Contract(lendingAddress!, lendingAbi, signer);
      const tx = await lending.depositCollateral({ value: parseInputAmount(forms.depositEth, "eth") });
      await tx.wait();
      setForms(current => ({ ...current, depositEth: "" }));
    });
  }

  async function handleWithdraw() {
    await runTransaction("Collateral withdrawal", async () => {
      const { signer } = await ensureWalletReady();
      const lending = new Contract(lendingAddress!, lendingAbi, signer);
      const tx = await lending.withdrawCollateral(parseInputAmount(forms.withdrawEth, "eth"));
      await tx.wait();
      setForms(current => ({ ...current, withdrawEth: "" }));
    });
  }

  async function handleBorrow() {
    await runTransaction("Borrow", async () => {
      const { signer } = await ensureWalletReady();
      const lending = new Contract(lendingAddress!, lendingAbi, signer);
      const tx = await lending.borrow(parseInputAmount(forms.borrowCorn, "corn"));
      await tx.wait();
      setForms(current => ({ ...current, borrowCorn: "" }));
    });
  }

  async function handleRepay() {
    await runTransaction("Repay", async () => {
      const { signer } = await ensureWalletReady();
      const lending = new Contract(lendingAddress!, lendingAbi, signer);
      const cornAddress = await lending.corn();
      const cornToken = new Contract(cornAddress, lendingAbi, signer);
      const amount = parseInputAmount(forms.repayCorn, "corn");
      const approvalTx = await cornToken.approve(lendingAddress!, amount);
      await approvalTx.wait();
      const repayTx = await lending.repay(amount);
      await repayTx.wait();
      setForms(current => ({ ...current, repayCorn: "" }));
    });
  }

  async function handleLiquidate() {
    await runTransaction("Liquidation", async () => {
      const targetUser = normalizeAddress(forms.liquidateUser);
      if (!isConfiguredAddress(targetUser)) {
        throw new Error("Enter a valid borrower address to liquidate.");
      }
      const { signer } = await ensureWalletReady();
      const lending = new Contract(lendingAddress!, lendingAbi, signer);
      const cornAddress = await lending.corn();
      const cornToken = new Contract(cornAddress, lendingAbi, signer);
      const amount = parseInputAmount(forms.liquidateCorn, "corn");
      const approvalTx = await cornToken.approve(lendingAddress!, amount);
      await approvalTx.wait();
      const liquidateTx = await lending.liquidate(targetUser, amount);
      await liquidateTx.wait();
      setForms(current => ({ ...current, liquidateCorn: "" }));
    });
  }

  const status =
    !dashboard || dashboard.protection.healthFactor > 1
      ? statusCopy.secure
      : dashboard.protection.canLiquidate
        ? statusCopy.expired
        : statusCopy.active;

  const remainingSeconds =
    dashboard && dashboard.protection.protectionEndsAt > now
      ? dashboard.protection.protectionEndsAt - now
      : 0;

  const ratioPercent = ratioToPercent(dashboard?.healthFactor ?? Infinity);
  const trendPoints = buildTrendPoints(ratioPercent);
  const chartLine = chartPath(trendPoints);
  const activeAddress = viewedAddress || normalizeAddress(homeownerAddress);
  const hasPosition = (dashboard?.collateralEth ?? 0) > 0 || (dashboard?.debtCorn ?? 0) > 0;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <div className="brand-title">Neverland Lending</div>
            <div className="brand-subtitle">Over-collateralized protection dashboard</div>
          </div>
        </div>

        <nav className="nav">
          <button className={`nav-link ${selectedTab === "home" ? "nav-link-active" : ""}`} onClick={() => setSelectedTab("home")}>
            Home
          </button>
          <button className={`nav-link ${selectedTab === "dashboard" ? "nav-link-active" : ""}`} onClick={() => setSelectedTab("dashboard")}>
            Dashboard
          </button>
          <button className={`nav-link ${selectedTab === "debug" ? "nav-link-active" : ""}`} onClick={() => setSelectedTab("debug")}>
            Debug Contracts
          </button>
        </nav>

        <div className="wallet-group">
          <div className="wallet-pill">
            <div className="wallet-balance">{formatAmount(dashboard?.walletEth ?? 0)} ETH</div>
            <div className="wallet-address">
              {activeAddress ? shortenAddress(activeAddress) : "No wallet"}
            </div>
          </div>
          <button className="connect-button" onClick={connectWallet}>
            {connectedAddress ? "Switch / Refresh Wallet" : "Connect Wallet"}
          </button>
        </div>
      </header>

      {txState.kind !== "idle" && (
        <div className={`tx-banner tx-banner-${txState.kind}`}>{txState.label}</div>
      )}
      {error && <div className="dashboard-error">Dashboard error: {error}</div>}

      {selectedTab === "home" && (
        <section className="home-hero">
          <div className="panel">
            <p className={`status-chip status-chip-${status.tone}`}>Protection Status</p>
            <h1>{status.title}</h1>
            <p className="hero-copy">{status.description}</p>
            <div className="home-grid">
              <MetricCard label="Connected Wallet" value={activeAddress ? shortenAddress(activeAddress) : "Not connected"} />
              <MetricCard label="CORN Wallet" value={`${formatAmount(dashboard?.walletCorn ?? 0)} CORN`} />
              <MetricCard label="Collateral Value" value={`${formatAmount(dashboard?.collateralValueCorn ?? 0)} CORN`} />
              <MetricCard label="Protection Ends" value={dashboard?.protection.protectionEndsAt ? new Date(dashboard.protection.protectionEndsAt * 1000).toLocaleString() : "Not active"} />
            </div>
          </div>
        </section>
      )}

      {selectedTab === "dashboard" && (
        <>
          <section className="hero">
            <div>
              <p className={`status-chip status-chip-${status.tone}`}>Protection Status</p>
              <h1>Lending Dashboard</h1>
              <p className="hero-copy">{status.description}</p>
            </div>
            <div className="hero-sidecard">
              <div className="mini-stat">
                <span className="mini-label">CORN Price</span>
                <strong>{formatAmount(dashboard?.cornPriceEth ?? 0, 6)} ETH</strong>
              </div>
              <div className="mini-stat">
                <span className="mini-label">Liquidation Buffer</span>
                <strong>
                  {dashboard?.protection.protectionEndsAt
                    ? formatCountdown(remainingSeconds)
                    : "Not active"}
                </strong>
              </div>
            </div>
          </section>

          <div className="dashboard-grid">
            <div className="left-column">
              <ActionPanel
                title="Collateral Operations"
                fields={[
                  {
                    label: "Deposit Collateral (ETH)",
                    value: forms.depositEth,
                    onChange: value => setForms(current => ({ ...current, depositEth: value })),
                    placeholder: "0.10",
                  },
                  {
                    label: "Withdraw Collateral (ETH)",
                    value: forms.withdrawEth,
                    onChange: value => setForms(current => ({ ...current, withdrawEth: value })),
                    placeholder: "0.05",
                  },
                ]}
                actions={[
                  { label: "Deposit", onClick: handleDeposit },
                  { label: "Withdraw", onClick: handleWithdraw, tone: "secondary" },
                ]}
              />

              <ActionPanel
                title="Borrow Operations"
                fields={[
                  {
                    label: "Borrow CORN",
                    value: forms.borrowCorn,
                    onChange: value => setForms(current => ({ ...current, borrowCorn: value })),
                    placeholder: "100",
                  },
                  {
                    label: "Repay Debt",
                    value: forms.repayCorn,
                    onChange: value => setForms(current => ({ ...current, repayCorn: value })),
                    placeholder: "50",
                  },
                ]}
                actions={[
                  { label: "Borrow", onClick: handleBorrow },
                  { label: "Approve + Repay", onClick: handleRepay, tone: "secondary" },
                ]}
              />

              <ActionPanel
                title="Liquidation Operations"
                fields={[
                  {
                    label: "Borrower Address",
                    value: forms.liquidateUser,
                    onChange: value => setForms(current => ({ ...current, liquidateUser: value })),
                    placeholder: "0x...",
                  },
                  {
                    label: "Repay CORN",
                    value: forms.liquidateCorn,
                    onChange: value => setForms(current => ({ ...current, liquidateCorn: value })),
                    placeholder: "25",
                  },
                ]}
                actions={[{ label: "Approve + Liquidate", onClick: handleLiquidate }]}
              />
            </div>

            <div className="right-column">
              <section className="panel">
                <div className="panel-header">
                  <h2>Position Overview</h2>
                  <span className="panel-badge">{hasPosition ? "Active Position" : "No Position"}</span>
                </div>
                <div className="table-card">
                  <div className="table-head">
                    <span>Address</span>
                    <span>Collateral</span>
                    <span>Debt</span>
                    <span>Ratio</span>
                  </div>
                  <div className="table-row">
                    <span>{activeAddress ? shortenAddress(activeAddress) : "No wallet"}</span>
                    <span>{formatAmount(dashboard?.collateralEth ?? 0)} ETH</span>
                    <span>{formatAmount(dashboard?.debtCorn ?? 0)} CORN</span>
                    <span>{Number.isFinite(ratioPercent) ? `${formatAmount(ratioPercent, 1)}%` : "Infinite"}</span>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h2>Collateral / Debt Ratio Over Time</h2>
                  <span className="panel-badge subtle">Protocol safety floor 120%</span>
                </div>
                <div className="chart-card">
                  <div className="chart-summary">
                    <div>
                      <span className="mini-label">Current Ratio</span>
                      <strong>{Number.isFinite(ratioPercent) ? `${formatAmount(ratioPercent, 1)}%` : "Infinite"}</strong>
                    </div>
                    <div>
                      <span className="mini-label">Protection Ends</span>
                      <strong>
                        {dashboard?.protection.protectionEndsAt
                          ? new Date(dashboard.protection.protectionEndsAt * 1000).toLocaleString()
                          : "Not active"}
                      </strong>
                    </div>
                  </div>
                  <svg viewBox="0 0 100 60" className="ratio-chart" preserveAspectRatio="none">
                    <line x1="0" y1="30" x2="100" y2="30" className="threshold-line" />
                    <path d={chartLine} className="trend-line" />
                    {trendPoints.map(point => (
                      <circle key={`${point.x}-${point.y}`} cx={point.x} cy={150 - point.y} r="1.4" className="trend-point" />
                    ))}
                  </svg>
                  <div className="chart-axis">
                    <span>90%</span>
                    <span>120%</span>
                    <span>150%</span>
                  </div>
                </div>
              </section>

              <section className="detail-grid">
                <MetricCard label="Wallet ETH" value={`${formatAmount(dashboard?.walletEth ?? 0)} ETH`} />
                <MetricCard label="Wallet CORN" value={`${formatAmount(dashboard?.walletCorn ?? 0)} CORN`} />
                <MetricCard label="Protection Ends" value={dashboard?.protection.protectionEndsAt ? new Date(dashboard.protection.protectionEndsAt * 1000).toLocaleString() : "Not active"} />
                <MetricCard label="Risk Since" value={dashboard?.protection.atRiskSince ? new Date(dashboard.protection.atRiskSince * 1000).toLocaleString() : "Position secure"} />
                <MetricCard label="Liquidatable" value={dashboard?.protection.canLiquidate ? "Yes" : "No"} />
                <MetricCard label="CORN DEX" value={dashboard?.cornDexAddress ? shortenAddress(dashboard.cornDexAddress) : "-"} />
              </section>
            </div>
          </div>
        </>
      )}

      {selectedTab === "debug" && (
        <section className="debug-grid">
          <MetricCard label="RPC URL" value={rpcUrl ?? "Missing"} />
          <MetricCard label="Lending" value={lendingAddress ?? "Missing"} />
          <MetricCard label="Connected Account" value={connectedAddress ?? "Not connected"} />
          <MetricCard label="Viewed Account" value={activeAddress || "None"} />
          <MetricCard label="CORN Token" value={dashboard?.cornAddress ?? "Loading"} />
          <MetricCard label="CORN DEX" value={dashboard?.cornDexAddress ?? "Loading"} />
        </section>
      )}
    </div>
  );
}

function ActionPanel({
  title,
  fields,
  actions,
}: {
  title: string;
  fields: Array<{
    label: string;
    value: string;
    placeholder: string;
    onChange: (value: string) => void;
  }>;
  actions: Array<{ label: string; onClick: () => void; tone?: "secondary" }>;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
      </div>
      <div className="form-stack">
        {fields.map(field => (
          <div className="form-row" key={field.label}>
            <label>{field.label}</label>
            <input
              className="input"
              value={field.value}
              onChange={event => field.onChange(event.target.value)}
              placeholder={field.placeholder}
            />
          </div>
        ))}
        <div className="action-row">
          {actions.map(action => (
            <button
              key={action.label}
              className={`action-button ${action.tone === "secondary" ? "action-button-secondary" : ""}`}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
