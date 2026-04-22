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

type MonitoredPosition = {
  address: string;
  collateralEth: number;
  debtCorn: number;
  ratioPercent: number;
  protection: ProtectionState;
};

type RatioSnapshot = {
  timestamp: number;
  ratioPercent: number;
};

type Props = {
  lendingAddress?: string;
  homeownerAddress?: string;
  rpcUrl?: string;
  pollIntervalMs?: number;
};

type TabId = "home" | "dashboard" | "market" | "debug";
type TxState = { kind: "idle" } | { kind: "pending"; label: string } | { kind: "success"; label: string } | { kind: "error"; label: string };
type WarningState = { title: string; message: string } | null;
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
const SEPOLIA_FAUCET_URL = "https://www.alchemy.com/faucets/ethereum-sepolia";
const MAX_RATIO_HISTORY_POINTS = 24;
const RATIO_HISTORY_STORAGE_KEY = "neverland_ratio_history";
const WATCHLIST_STORAGE_KEY = "neverland_liquidation_watchlist";

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

function getWalletBadge(address?: string | null) {
  if (!address) return "N";
  return address.slice(2, 4).toUpperCase();
}

function chainLabel(chainId?: string | null) {
  switch (chainId) {
    case SEPOLIA_CHAIN_ID:
      return "Sepolia";
    case "0x7a69":
      return "Hardhat";
    case "0x1":
      return "Ethereum";
    default:
      return "Wallet";
  }
}

function formatCountdown(remainingSeconds: number) {
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = Math.max(0, remainingSeconds % 60);
  return `${hours}h ${minutes}m ${seconds}s remaining`;
}

function maxSafeBorrowCorn(collateralValueCorn: number, debtCorn: number) {
  if (!Number.isFinite(collateralValueCorn) || collateralValueCorn <= 0) {
    return 0;
  }

  const allowedDebt = collateralValueCorn / (MIN_RATIO_PERCENT / 100);
  const additionalBorrow = allowedDebt - Math.max(debtCorn, 0);
  return additionalBorrow > 0 ? additionalBorrow : 0;
}

function readStoredWatchlist() {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function uniqueConfiguredAddresses(addresses: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      addresses
        .map(value => normalizeAddress(value))
        .filter(address => isConfiguredAddress(address)),
    ),
  );
}

function monitorStatus(protection: ProtectionState) {
  if (protection.healthFactor > 1) {
    return { label: "Equity Secure", tone: "secure" as const };
  }
  if (protection.canLiquidate) {
    return { label: "Protection Expired", tone: "expired" as const };
  }
  return { label: "Safety Net Active", tone: "active" as const };
}

function ratioToPercent(healthFactor: number) {
  if (!Number.isFinite(healthFactor) || healthFactor > 1e12) {
    return Infinity;
  }
  return healthFactor * MIN_RATIO_PERCENT;
}

type ChartBounds = {
  min: number;
  max: number;
  ticks: number[];
};

function roundUp(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

function chooseTickStep(approxStep: number) {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
  return steps.find(step => approxStep <= step) ?? 1000;
}

function buildChartBounds(ratioPercent: number): ChartBounds {
  if (!Number.isFinite(ratioPercent)) {
    return {
      min: 90,
      max: 180,
      ticks: [180, 150, 120, 90],
    };
  }

  const min = 90;
  const rawMax = Math.max(180, ratioPercent * 1.1);
  const stepSize = chooseTickStep((rawMax - min) / 5);
  const max = roundUp(rawMax, stepSize);
  const tickCount = Math.ceil((max - min) / stepSize);
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => max - index * stepSize).filter(tick => tick >= min);
  if (ticks[ticks.length - 1] !== min) {
    ticks.push(min);
  }
  return { min, max, ticks };
}

function buildTrendPoints(history: RatioSnapshot[], bounds: ChartBounds) {
  const floor = bounds.min;
  const ceiling = bounds.max;

  if (history.length === 0) {
    return [];
  }

  if (history.length === 1) {
    return [
      {
        x: 1,
        y: Math.max(floor, Math.min(ceiling, history[0].ratioPercent)),
      },
    ];
  }

  const firstTimestamp = history[0].timestamp;
  const lastTimestamp = history[history.length - 1].timestamp;
  const range = lastTimestamp - firstTimestamp;

  if (range < Math.max(30, history.length * 5)) {
    return history.map((snapshot, index) => ({
      x: index / Math.max(history.length - 1, 1),
      y: Math.max(floor, Math.min(ceiling, snapshot.ratioPercent)),
    }));
  }

  return history.map(snapshot => ({
    x: (snapshot.timestamp - firstTimestamp) / range,
    y: Math.max(floor, Math.min(ceiling, snapshot.ratioPercent)),
  }));
}

function chartX(position: number) {
  const normalized = Math.max(0, Math.min(1, position));
  return 18 + normalized * 74;
}

function chartY(value: number, bounds: ChartBounds) {
  const usableHeight = 48;
  const range = bounds.max - bounds.min || 1;
  return 52 - ((value - bounds.min) / range) * usableHeight;
}

function chartPath(points: Array<{ x: number; y: number }>, bounds: ChartBounds) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${chartX(point.x)} ${chartY(point.y, bounds)}`)
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

function readStoredRatioHistory() {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(RATIO_HISTORY_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, RatioSnapshot[]>) : {};
  } catch {
    return {};
  }
}

function formatTimeLabel(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function WalletEmptyState({
  title,
  message,
  onConnect,
}: {
  title: string;
  message: string;
  onConnect: () => void;
}) {
  return (
    <section className="panel wallet-empty-state">
      <p className="status-chip status-chip-active">Wallet Required</p>
      <h2>{title}</h2>
      <p>{message}</p>
      <button className="action-button wallet-empty-action" onClick={onConnect}>
        Connect The Wallet
      </button>
    </section>
  );
}

export function ProtectionDashboard({
  lendingAddress,
  homeownerAddress,
  rpcUrl,
  pollIntervalMs = 5000,
}: Props) {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [monitoredPositions, setMonitoredPositions] = useState<MonitoredPosition[]>([]);
  const [ratioHistoryByWallet, setRatioHistoryByWallet] = useState<Record<string, RatioSnapshot[]>>({});
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchAddressInput, setWatchAddressInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<TabId>("dashboard");
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [connectedChainId, setConnectedChainId] = useState<string | null>(null);
  const [walletTrayOpen, setWalletTrayOpen] = useState(false);
  const [txState, setTxState] = useState<TxState>({ kind: "idle" });
  const [warning, setWarning] = useState<WarningState>(null);
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

  useEffect(() => {
    setRatioHistoryByWallet(readStoredRatioHistory());
    setWatchlist(readStoredWatchlist());
  }, []);

  const viewedAddress = useMemo(() => normalizeAddress(connectedAddress), [connectedAddress]);

  useEffect(() => {
    setForms(current => ({
      ...current,
      liquidateUser: current.liquidateUser || homeownerAddress || "",
    }));
  }, [homeownerAddress]);

  useEffect(() => {
    setTxState({ kind: "idle" });
    setWarning(null);
    setError(null);
  }, [connectedAddress]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RATIO_HISTORY_STORAGE_KEY, JSON.stringify(ratioHistoryByWallet));
  }, [ratioHistoryByWallet]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist));
  }, [watchlist]);

  useEffect(() => {
    setWatchlist(current =>
      uniqueConfiguredAddresses([
        ...current,
        homeownerAddress,
      ]),
    );
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
      setWalletTrayOpen(false);
    };

    const handleChainChanged = (chainId: unknown) => {
      if (typeof chainId === "string") {
        setConnectedChainId(chainId);
      }
      void refreshDashboard();
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  useEffect(() => {
    async function hydrateWallet() {
      if (!window.ethereum) return;

      try {
        const [accounts, chainId] = await Promise.all([
          window.ethereum.request({ method: "eth_accounts" }) as Promise<string[]>,
          window.ethereum.request({ method: "eth_chainId" }) as Promise<string>,
        ]);

        const nextAccount = accounts[0] ? normalizeAddress(accounts[0]) : null;
        setConnectedAddress(nextAccount);
        setConnectedChainId(chainId);
      } catch {
        // Ignore passive wallet hydration failures and let explicit connect handle them.
      }
    }

    void hydrateWallet();
  }, []);

  async function ensureWalletReady() {
    if (!window.ethereum) {
      throw new Error("No browser wallet found. Open this page in MetaMask-enabled browser.");
    }

    let chainId = (await window.ethereum.request({ method: "eth_chainId" })) as string;
    if (chainId !== SEPOLIA_CHAIN_ID) {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_CHAIN_ID }],
      });
      chainId = SEPOLIA_CHAIN_ID;
    }

    const browserProvider = new BrowserProvider(window.ethereum);
    const signer = await browserProvider.getSigner();
    const signerAddress = normalizeAddress(await signer.getAddress());
    setConnectedAddress(signerAddress);
    setConnectedChainId(chainId);
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
      const chainId = (await window.ethereum.request({ method: "eth_chainId" })) as string;
      setConnectedAddress(nextAccount);
      setConnectedChainId(chainId);
      setWalletTrayOpen(Boolean(nextAccount));
      setError(null);
    } catch (connectError) {
      setError(extractErrorMessage(connectError));
    }
  }

  async function changeWallet() {
    try {
      if (!window.ethereum) {
        throw new Error("MetaMask or another EVM wallet is required to change wallets.");
      }

      await window.ethereum.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });

      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const nextAccount = accounts[0] ? normalizeAddress(accounts[0]) : null;
      const chainId = (await window.ethereum.request({ method: "eth_chainId" })) as string;
      setConnectedAddress(nextAccount);
      setConnectedChainId(chainId);
      setWalletTrayOpen(false);
      setError(null);
    } catch (changeError) {
      setError(extractErrorMessage(changeError));
    }
  }

  function disconnectWallet() {
    setConnectedAddress(null);
    setConnectedChainId(null);
    setDashboard(null);
    setWalletTrayOpen(false);
    setError(null);
  }

  function addWatchAddress() {
    const nextAddress = normalizeAddress(watchAddressInput);
    if (!isConfiguredAddress(nextAddress)) {
      setError("Enter a valid address to watch.");
      return;
    }

    setWatchlist(current => uniqueConfiguredAddresses([...current, nextAddress]));
    setWatchAddressInput("");
    setError(null);
  }

  function removeWatchAddress(address: string) {
    setWatchlist(current => current.filter(entry => entry !== address));
  }

  function prepareLiquidation(address: string) {
    setForms(current => ({ ...current, liquidateUser: address }));
    setSelectedTab("dashboard");
  }

  async function refreshDashboard() {
    try {
      if (!rpcUrl) {
        throw new Error("Missing NEXT_PUBLIC_RPC_URL. Add it before starting the frontend.");
      }
      if (!isConfiguredAddress(lendingAddress)) {
        throw new Error("NEXT_PUBLIC_LENDING_ADDRESS is missing or invalid.");
      }

      const accountToView = viewedAddress;
      if (!isConfiguredAddress(accountToView)) {
        setDashboard(null);
        setError(null);
        return;
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

      const liveRatioPercent = ratioToPercent(Number(formatUnits(healthFactor, 18)));
      if (Number.isFinite(liveRatioPercent)) {
        setRatioHistoryByWallet(current => {
          const existingHistory = current[accountToView] ?? [];
          const nextEntry = {
            timestamp: now,
            ratioPercent: liveRatioPercent,
          };
          const nextHistory =
            existingHistory.length === 0
              ? [
                  { timestamp: now - 60, ratioPercent: liveRatioPercent },
                  { timestamp: now - 45, ratioPercent: liveRatioPercent },
                  { timestamp: now - 30, ratioPercent: liveRatioPercent },
                  { timestamp: now - 15, ratioPercent: liveRatioPercent },
                  nextEntry,
                ]
              : [...existingHistory, nextEntry];

          return {
            ...current,
            [accountToView]: nextHistory.slice(-MAX_RATIO_HISTORY_POINTS),
          };
        });
      }
      setError(null);
    } catch (loadError) {
      setError(extractErrorMessage(loadError));
    }
  }

  async function refreshWatchlist() {
    try {
      if (!rpcUrl || !isConfiguredAddress(lendingAddress)) {
        setMonitoredPositions([]);
        return;
      }

      const provider = providerRef.current;
      if (!provider) return;

      const addresses = uniqueConfiguredAddresses(watchlist);
      if (addresses.length === 0) {
        setMonitoredPositions([]);
        return;
      }

      const lending = new Contract(lendingAddress, lendingAbi, provider);
      const nextPositions = await Promise.all(
        addresses.map(async address => {
          const [collateralBalance, debtBalance, healthFactor, protectionState] = await Promise.all([
            lending.collateralBalance(address),
            lending.debtBalance(address),
            lending.getHealthFactor(address),
            lending.getProtectionState(address),
          ]);

          return {
            address,
            collateralEth: Number(formatEther(collateralBalance)),
            debtCorn: Number(formatUnits(debtBalance, 18)),
            ratioPercent: ratioToPercent(Number(formatUnits(healthFactor, 18))),
            protection: {
              healthFactor: Number(formatUnits(protectionState[0], 18)),
              atRiskSince: Number(protectionState[1]),
              protectionEndsAt: Number(protectionState[2]),
              canLiquidate: Boolean(protectionState[3]),
            },
          } satisfies MonitoredPosition;
        }),
      );

      setMonitoredPositions(nextPositions);
    } catch (loadError) {
      setError(extractErrorMessage(loadError));
    }
  }

  useEffect(() => {
    void refreshDashboard();
    void refreshWatchlist();
    const poll = window.setInterval(() => {
      void refreshDashboard();
      void refreshWatchlist();
    }, pollIntervalMs);
    return () => window.clearInterval(poll);
  }, [viewedAddress, lendingAddress, pollIntervalMs, rpcUrl, watchlist]);

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
    const withdrawAmount = Number(forms.withdrawEth.trim());
    const currentCollateralEth = dashboard?.collateralEth ?? 0;
    const currentDebtCorn = dashboard?.debtCorn ?? 0;
    const cornPerEth = dashboard?.cornPriceEth ? 1 / dashboard.cornPriceEth : 0;

    if (Number.isFinite(withdrawAmount) && withdrawAmount > 0 && currentDebtCorn > 0) {
      const projectedCollateralEth = currentCollateralEth - withdrawAmount;
      const projectedCollateralCorn = projectedCollateralEth * cornPerEth;
      const projectedRatio = projectedCollateralCorn / currentDebtCorn;

      if (projectedCollateralEth < 0) {
        setWarning({
          title: "Withdrawal exceeds collateral",
          message: `You only have ${formatAmount(currentCollateralEth)} ETH deposited, so withdrawing ${formatAmount(withdrawAmount)} ETH is not possible.`,
        });
        return;
      }

      if (projectedRatio < 1.2) {
        setWarning({
          title: "This withdrawal makes the loan unhealthy",
          message: `Withdrawing ${formatAmount(withdrawAmount)} ETH would drop your collateral ratio to ${formatAmount(projectedRatio * 100, 1)}%, below the 120% safety floor. Add collateral or repay some CORN before withdrawing this much.`,
        });
        return;
      }
    }

    await runTransaction("Collateral withdrawal", async () => {
      const { signer } = await ensureWalletReady();
      const lending = new Contract(lendingAddress!, lendingAbi, signer);
      const tx = await lending.withdrawCollateral(parseInputAmount(forms.withdrawEth, "eth"));
      await tx.wait();
      setForms(current => ({ ...current, withdrawEth: "" }));
    });
  }

  async function handleBorrow() {
    const requestedBorrowCorn = Number(forms.borrowCorn.trim());
    const safeBorrowCorn = maxSafeBorrowCorn(dashboard?.collateralValueCorn ?? 0, dashboard?.debtCorn ?? 0);

    if (!Number.isFinite(requestedBorrowCorn) || requestedBorrowCorn <= 0) {
      setTxState({ kind: "error", label: "Enter a valid CORN amount to borrow." });
      return;
    }

    if (requestedBorrowCorn > safeBorrowCorn) {
      setWarning({
        title: "Borrow amount exceeds the safe range",
        message: `You can safely borrow up to ${formatAmount(safeBorrowCorn)} CORN at the 120% collateral floor. Borrow less, add more collateral, or repay existing debt before increasing this amount.`,
      });
      return;
    }

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
      const requestedAmount = parseInputAmount(forms.repayCorn, "corn");
      const signerAddress = await signer.getAddress();
      const outstandingDebt = await lending.debtBalance(signerAddress);

      if (outstandingDebt === 0n) {
        throw new Error("No debt to repay for this wallet.");
      }

      const repayAmount = requestedAmount > outstandingDebt ? outstandingDebt : requestedAmount;
      const approvalTx = await cornToken.approve(lendingAddress!, repayAmount);
      await approvalTx.wait();
      const repayTx = await lending.repay(repayAmount);
      await repayTx.wait();
      setForms(current => ({ ...current, repayCorn: "" }));
    });
  }

  async function handleLiquidate() {
    if (dashboard && !dashboard.protection.canLiquidate) {
      const endsAt =
        dashboard.protection.protectionEndsAt > now
          ? new Date(dashboard.protection.protectionEndsAt * 1000).toLocaleString()
          : null;

      setWarning({
        title: "Protection window is still active",
        message: endsAt
          ? `This position cannot be liquidated yet. The 24-hour protection window stays active until ${endsAt}.`
          : "This position cannot be liquidated yet because the 24-hour protection window is still active.",
      });
      return;
    }

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

  const activeAddress = viewedAddress;
  const hasPosition = (dashboard?.collateralEth ?? 0) > 0 || (dashboard?.debtCorn ?? 0) > 0;
  const ratioPercent = ratioToPercent(dashboard?.healthFactor ?? Infinity);
  const safeBorrowCorn = maxSafeBorrowCorn(dashboard?.collateralValueCorn ?? 0, dashboard?.debtCorn ?? 0);
  const ratioHistory = activeAddress ? ratioHistoryByWallet[activeAddress] ?? [] : [];
  const showChartSeries = hasPosition && (ratioHistory.length > 0 || Number.isFinite(ratioPercent));
  const chartBounds = buildChartBounds(ratioPercent);
  const trendPoints = buildTrendPoints(
    showChartSeries && ratioHistory.length > 0
      ? ratioHistory
      : showChartSeries && Number.isFinite(ratioPercent)
        ? [{ timestamp: now, ratioPercent }]
        : [],
    chartBounds,
  );
  const chartLine = chartPath(trendPoints, chartBounds);
  const thresholdY = chartY(MIN_RATIO_PERCENT, chartBounds);
  const currentY = Number.isFinite(ratioPercent) ? chartY(ratioPercent, chartBounds) : chartY(chartBounds.max - 12, chartBounds);
  const yTicks = chartBounds.ticks;
  const timeLabels =
    ratioHistory.length >= 2
      ? [
          formatTimeLabel(ratioHistory[0].timestamp),
          formatTimeLabel(ratioHistory[Math.floor((ratioHistory.length - 1) / 2)].timestamp),
          formatTimeLabel(ratioHistory[ratioHistory.length - 1].timestamp),
        ]
      : ["Start", "Time", "Now"];
  const networkName = chainLabel(connectedChainId);
  const connectedLabel = connectedAddress ? shortenAddress(connectedAddress) : "Connect Wallet";
  const walletBadge = getWalletBadge(connectedAddress);
  const needsWallet = !connectedAddress;

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
          <button className={`nav-link ${selectedTab === "market" ? "nav-link-active" : ""}`} onClick={() => setSelectedTab("market")}>
            Liquidation Watch
          </button>
          <button className={`nav-link ${selectedTab === "debug" ? "nav-link-active" : ""}`} onClick={() => setSelectedTab("debug")}>
            Debug Contracts
          </button>
        </nav>

        <div className="wallet-group">
          <div className="wallet-balance-block">
            <div className="wallet-balance">{formatAmount(dashboard?.walletEth ?? 0)} ETH</div>
            <div className="wallet-network">{networkName}</div>
          </div>
          <button
            className={`wallet-chip ${connectedAddress ? "wallet-chip-connected" : ""}`}
            onClick={() => setWalletTrayOpen(open => !open)}
          >
            <span className="wallet-avatar">{walletBadge}</span>
            <span className="wallet-chip-text">{connectedLabel}</span>
            <span className="wallet-chevron">▾</span>
          </button>
          <button className="wallet-icon-button" onClick={() => window.open(SEPOLIA_FAUCET_URL, "_blank", "noopener,noreferrer")}>
            <span aria-hidden="true">◫</span>
          </button>
        </div>
      </header>

      {walletTrayOpen && (
        <section className="wallet-tray">
          {connectedAddress ? (
            <button
              className="wallet-faucet-button"
              onClick={() => window.open(SEPOLIA_FAUCET_URL, "_blank", "noopener,noreferrer")}
            >
              Grab funds from faucet
            </button>
          ) : null}
          <div className="wallet-action-row">
            <button className="wallet-action-button" onClick={connectedAddress ? changeWallet : connectWallet}>
              {connectedAddress ? "Change Wallet" : "Connect Wallet"}
            </button>
            {connectedAddress ? (
              <button className="wallet-action-button wallet-action-button-secondary" onClick={disconnectWallet}>
                Disconnect
              </button>
            ) : null}
          </div>
          <div className="wallet-tray-grid">
            <div className="wallet-tray-card">
              <div className="wallet-tray-title">{connectedAddress ? "CORN Price" : "Wallet Status"}</div>
              <div className="wallet-tray-value">
                {connectedAddress ? `${formatAmount(dashboard?.cornPriceEth ?? 0, 6)} ETH` : "Connect The Wallet"}
              </div>
              <div className="wallet-tray-subvalue">
                {connectedAddress
                  ? `${dashboard?.cornPriceEth ? formatAmount(1 / dashboard.cornPriceEth, 2) : "0.00"} CORN/ETH`
                  : "Connect to load balances, position health, and protection state."}
              </div>
            </div>
            <div className="wallet-tray-card">
              <div className="wallet-tray-title">{connectedAddress ? "CORN Wallet" : "Quick Navigation"}</div>
              <div className="wallet-tray-value">
                {connectedAddress ? `${formatAmount(dashboard?.walletCorn ?? 0)} CORN` : "Dashboard"}
              </div>
              <div className="wallet-tray-actions">
                <button className="wallet-mini-action" onClick={() => setSelectedTab("dashboard")}>
                  Dashboard
                </button>
                <button className="wallet-mini-action" onClick={() => setSelectedTab("debug")}>
                  Debug
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {txState.kind !== "idle" && (
        <div className={`tx-banner tx-banner-${txState.kind}`}>{txState.label}</div>
      )}
      {error && <div className="dashboard-error">Dashboard error: {error}</div>}
      {warning && (
        <div className="warning-overlay" role="dialog" aria-modal="true">
          <div className="warning-modal">
            <h3>{warning.title}</h3>
            <p>{warning.message}</p>
            <button className="action-button" onClick={() => setWarning(null)}>
              Got it
            </button>
          </div>
        </div>
      )}

      {selectedTab === "home" && (
        <section className="home-hero">
          <div className="panel">
            <p className={`status-chip status-chip-${status.tone}`}>
              <span className="status-dot" aria-hidden="true" />
              Protection Status
            </p>
            <h1>{needsWallet ? "Connect The Wallet" : status.title}</h1>
            <p className="hero-copy">
              {needsWallet
                ? "Connect your wallet to load live balances, borrowing controls, protection status, and liquidation timing."
                : status.description}
            </p>
            {needsWallet ? (
              <button className="action-button wallet-empty-action" onClick={connectWallet}>
                Connect The Wallet
              </button>
            ) : (
              <div className="home-grid">
                <MetricCard label="Connected Wallet" value={activeAddress ? shortenAddress(activeAddress) : "Not connected"} />
                <MetricCard label="CORN Wallet" value={`${formatAmount(dashboard?.walletCorn ?? 0)} CORN`} />
                <MetricCard label="Collateral Value" value={`${formatAmount(dashboard?.collateralValueCorn ?? 0)} CORN`} />
                <MetricCard label="Protection Ends" value={dashboard?.protection.protectionEndsAt ? new Date(dashboard.protection.protectionEndsAt * 1000).toLocaleString() : "Not active"} />
              </div>
            )}
          </div>
        </section>
      )}

      {selectedTab === "dashboard" && (
        <>
          {needsWallet ? (
            <WalletEmptyState
              title="Connect The Wallet"
              message="The dashboard needs an active wallet to show your collateral, debt, health factor, protection window, and transaction actions."
              onConnect={connectWallet}
            />
          ) : (
        <>
          <section className="hero">
            <div>
              <p className={`status-chip status-chip-${status.tone}`}>
                <span className="status-dot" aria-hidden="true" />
                Protection Status
              </p>
              <h1>Lending Dashboard</h1>
              <p className="hero-copy">{status.description}</p>
            </div>
            <div className="hero-sidecard">
              <div className="mini-stat">
                <span className="mini-label">CORN Price</span>
                <strong>{formatAmount(dashboard?.cornPriceEth ?? 0, 6)} ETH</strong>
              </div>
              <div className={`mini-stat mini-stat-${status.tone}`}>
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
                    hint:
                      (dashboard?.collateralValueCorn ?? 0) > 0
                        ? `Max safe borrow right now: ${formatAmount(safeBorrowCorn)} CORN at the 120% health floor`
                        : "Deposit collateral first to unlock borrowing capacity",
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
                  <h2>Total Collateral/Debt Ratio</h2>
                  <span className="panel-badge subtle">Protocol safety floor 120%</span>
                </div>
                <div className="chart-card">
                  <div className="chart-plot">
                    <div className="chart-y-axis">
                      {yTicks.map(tick => (
                        <span key={tick}>{tick}%</span>
                      ))}
                    </div>
                    <div className="chart-canvas">
                      <svg viewBox="0 0 100 60" className="ratio-chart" preserveAspectRatio="none">
                        <line x1="18" y1="4" x2="18" y2="52" className="axis-line" />
                        <line x1="18" y1="52" x2="92" y2="52" className="axis-line" />
                        <line x1="18" y1={thresholdY} x2="92" y2={thresholdY} className="threshold-line" />
                        {yTicks.map(tick => {
                          const y = chartY(tick, chartBounds);
                          return (
                            <line
                              key={tick}
                              x1="17"
                              y1={y}
                              x2="18.8"
                              y2={y}
                              className="axis-tick"
                            />
                          );
                        })}
                        {trendPoints.map((point, index) => {
                          const x = chartX(point.x);
                          const y = chartY(point.y, chartBounds);
                          if (index === trendPoints.length - 1) {
                            return (
                              <g key={`trend-point-active-${index}-${point.x}-${point.y}`}>
                                <circle cx={x} cy={y} r="1.8" className="trend-point trend-point-active" />
                                <circle cx={x} cy={y} r="3.2" className="trend-point-halo" />
                              </g>
                            );
                          }
                          return (
                            <circle
                              key={`trend-point-${index}-${point.x}-${point.y}`}
                              cx={x}
                              cy={y}
                              r="1.2"
                              className="trend-point"
                            />
                          );
                        })}
                        {showChartSeries && trendPoints.length >= 2 ? (
                          <path d={chartLine} className="trend-line" />
                        ) : showChartSeries ? (
                          <line x1="18" y1={currentY} x2="92" y2={currentY} className="trend-line" />
                        ) : null}
                      </svg>
                    </div>
                  </div>
                  <div className="chart-footer">
                    <span className="chart-caption">
                      Current HF Ratio: {hasPosition ? (Number.isFinite(ratioPercent) ? `${formatAmount(ratioPercent, 1)}%` : "Infinite") : "No position"}
                    </span>
                    <span className="chart-time-label">{timeLabels[1]}</span>
                    <span className="chart-caption">
                      {dashboard?.protection.protectionEndsAt
                        ? `Protection ends ${new Date(dashboard.protection.protectionEndsAt * 1000).toLocaleTimeString()}`
                        : "Protection not active"}
                    </span>
                  </div>
                  <div className="chart-time-axis">
                    <span>{timeLabels[0]}</span>
                    <span>{timeLabels[1]}</span>
                    <span>{timeLabels[2]}</span>
                  </div>
                  {!hasPosition ? (
                    <div className="chart-hint">
                      No position yet. Deposit collateral and borrow CORN to start plotting health-factor history.
                    </div>
                  ) : ratioHistory.length < 2 && (
                    <div className="chart-hint">
                      More history appears after the dashboard observes additional price or position changes.
                    </div>
                  )}
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
        </>
      )}

      {selectedTab === "market" && (
        <section className="market-grid">
          <section className="panel">
            <div className="panel-header">
              <h2>Liquidation Watch</h2>
              <span className="panel-badge">{monitoredPositions.length} tracked</span>
            </div>
            <p className="market-copy">
              Track borrower addresses and monitor when their 24-hour protection window expires. Expired positions can be sent directly into the liquidation form.
            </p>
            <div className="watch-input-row">
              <input
                className="input"
                value={watchAddressInput}
                onChange={event => setWatchAddressInput(event.target.value)}
                placeholder="Add borrower address to watch"
              />
              <button className="action-button" onClick={addWatchAddress}>
                Add Address
              </button>
            </div>
            {watchlist.length > 0 ? (
              <div className="watch-tag-list">
                {watchlist.map(address => (
                  <button key={address} className="watch-tag" onClick={() => removeWatchAddress(address)}>
                    {shortenAddress(address)} <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="chart-hint">
                Add borrower addresses here. This app does not have an on-chain borrower registry, so the watchlist is built from addresses you care about.
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Tracked Positions</h2>
              <span className="panel-badge subtle">Liquidate only when protection expired</span>
            </div>
            <div className="monitor-table">
              <div className="monitor-head">
                <span>Address</span>
                <span>Status</span>
                <span>Collateral</span>
                <span>Debt</span>
                <span>Ratio</span>
                <span>Protection Ends</span>
                <span>Action</span>
              </div>
              {monitoredPositions.length > 0 ? (
                monitoredPositions.map(position => {
                  const statusMeta = monitorStatus(position.protection);
                  const canLiquidate = position.protection.canLiquidate;
                  return (
                    <div className="monitor-row" key={position.address}>
                      <span>{shortenAddress(position.address)}</span>
                      <span className={`status-pill status-pill-${statusMeta.tone}`}>{statusMeta.label}</span>
                      <span>{formatAmount(position.collateralEth)} ETH</span>
                      <span>{formatAmount(position.debtCorn)} CORN</span>
                      <span>{Number.isFinite(position.ratioPercent) ? `${formatAmount(position.ratioPercent, 1)}%` : "Infinite"}</span>
                      <span>
                        {position.protection.protectionEndsAt
                          ? new Date(position.protection.protectionEndsAt * 1000).toLocaleString()
                          : "Not active"}
                      </span>
                      {canLiquidate ? (
                        <button
                          className="row-action-button"
                          onClick={() => prepareLiquidation(position.address)}
                        >
                          Use for liquidation
                        </button>
                      ) : (
                        <div className="monitor-note">
                          Protected while the recovery window is active
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="chart-hint">No tracked borrowers yet. Add an address to start monitoring its position.</div>
              )}
            </div>
          </section>
        </section>
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
    hint?: string;
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
            {field.hint ? <div className="field-hint">{field.hint}</div> : null}
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
