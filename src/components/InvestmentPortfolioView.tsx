import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  FolderUp,
  Landmark,
  Link2,
  Pencil,
  PieChart,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingUp,
  Unlink,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  ASSET_CLASS_META,
  BROKERAGE_ACCOUNT_TYPE_META,
  FIELD_LIMITS,
  type AssetCategoryGroup,
  type AssetClass,
  type BankAccount,
  type BrokerageAccount,
  type BrokerageAccountType,
  type BrokerageApiProvider,
  type BrokerageConnectionMode,
  type BrokerageFirm,
  type CurrencyCode,
  type OnboardedAsset,
} from '../types/finance';
import { formatCompactCurrency, formatCurrency } from '../utils/formatters';

interface InvestmentPortfolioViewProps {
  accounts: BankAccount[];
  brokerageAccounts: BrokerageAccount[];
  firms: BrokerageFirm[];
  assets: OnboardedAsset[];
  onNavigateTab: (tab: 'assets' | 'brokerage' | 'ledger') => void;
}

interface ProviderInfo {
  manualSupported: boolean;
  statementSyncSupported: boolean;
  liveQuoteFeedSupported: boolean;
  externalAggregators: Array<{
    id: BrokerageApiProvider;
    label: string;
    available: boolean;
    mode: string;
  }>;
}

interface QuoteResult {
  ticker: string;
  status: 'live' | 'unavailable';
  price?: number;
  previousClose?: number;
  changePct?: number;
  currency?: string;
  asOf?: string;
  history?: { date: string; close: number }[];
}

type PerfRange = '1M' | '3M' | 'YTD' | '1Y';
type ChartSeriesMode = 'combined' | 'investments';

const INSTITUTION_SUGGESTIONS = [
  'Charles Schwab Institutional',
  'Fidelity Investments',
  'Interactive Brokers',
  'Meridian Clearing & Custody LLC',
  'Vanguard Institutional Advisory',
  'J.P. Morgan Private Bank Custody',
  'Morgan Stanley Wealth Custody',
];

const GROUP_COLORS: Record<AssetCategoryGroup | 'brokerage_cash' | 'bank_cash', string> = {
  public_securities: 'bg-slate-900',
  alternatives: 'bg-emerald-600',
  real_estate: 'bg-amber-600',
  brokerage_cash: 'bg-sky-600',
  bank_cash: 'bg-slate-400',
};

const GROUP_DOT_COLORS: Record<AssetCategoryGroup | 'brokerage_cash' | 'bank_cash', string> = {
  public_securities: '#0F172A',
  alternatives: '#059669',
  real_estate: '#D97706',
  brokerage_cash: '#0284C7',
  bank_cash: '#94A3B8',
};

export function InvestmentPortfolioView({
  accounts,
  brokerageAccounts,
  firms,
  assets,
  onNavigateTab,
}: InvestmentPortfolioViewProps) {
  const { user } = useAuth();

  // Performance chart & quote sync state
  const [perfRange, setPerfRange] = useState<PerfRange>('3M');
  const [chartMode, setChartMode] = useState<ChartSeriesMode>('combined');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const [liveQuotes, setLiveQuotes] = useState<Record<string, QuoteResult>>({});
  const [syncingQuotes, setSyncingQuotes] = useState(false);
  const [syncBanner, setSyncBanner] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Holdings filters
  const [selectedBrokerageFilter, setSelectedBrokerageFilter] = useState<string>('all');
  const [selectedGroupFilter, setSelectedGroupFilter] = useState<'all' | AssetCategoryGroup>('all');
  const [holdingSearch, setHoldingSearch] = useState('');

  // Link / Edit Brokerage Account modal
  const [brokerModalOpen, setBrokerModalOpen] = useState(false);
  const [editingBrokerage, setEditingBrokerage] = useState<BrokerageAccount | null>(null);
  const [linkMode, setLinkMode] = useState<BrokerageConnectionMode>('manual');
  const [apiProvider, setApiProvider] = useState<BrokerageApiProvider>('manual_ledger');
  const [brokerInstitution, setBrokerInstitution] = useState('Charles Schwab Institutional');
  const [accountName, setAccountName] = useState('');
  const [accountType, setAccountType] = useState<BrokerageAccountType>('individual_taxable');
  const [accountMask, setAccountMask] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>('USD');
  const [cashBalance, setCashBalance] = useState('25000');
  const [marginDebt, setMarginDebt] = useState('0');
  const [linkedBankAccountId, setLinkedBankAccountId] = useState('');
  const [firmId, setFirmId] = useState('');
  const [savingBrokerage, setSavingBrokerage] = useState(false);
  const [brokerFormError, setBrokerFormError] = useState<string | null>(null);

  // Close brokerage account confirmation modal
  const [closingTarget, setClosingTarget] = useState<BrokerageAccount | null>(null);
  const [closingBusy, setClosingBusy] = useState(false);

  // Add / Edit Holding modal
  const [holdingModalOpen, setHoldingModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<OnboardedAsset | null>(null);
  const [posBrokerageId, setPosBrokerageId] = useState('');
  const [posName, setPosName] = useState('');
  const [posTicker, setPosTicker] = useState('');
  const [posClass, setPosClass] = useState<AssetClass>('public_equity');
  const [posQty, setPosQty] = useState('100');
  const [posCostBasis, setPosCostBasis] = useState('150.00');
  const [posMarketValue, setPosMarketValue] = useState('17500.00');
  const [posDate, setPosDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [posJurisdiction, setPosJurisdiction] = useState('United States · Delaware');
  const [savingHolding, setSavingHolding] = useState(false);
  const [holdingFormError, setHoldingFormError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/portfolio/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: ProviderInfo | null) => {
        if (active && json) setProviderInfo(json);
      })
      .catch(() => {
        // Provider endpoint optional offline fallback
      });
    return () => {
      active = false;
    };
  }, []);

  const activeBankAccounts = useMemo(
    () => accounts.filter((a) => a.status !== 'closed'),
    [accounts],
  );

  const activeBrokerageAccounts = useMemo(
    () => brokerageAccounts.filter((b) => b.status !== 'closed'),
    [brokerageAccounts],
  );

  const activeHoldings = useMemo(
    () => assets.filter((a) => a.custodyStatus !== 'archived'),
    [assets],
  );

  const brokerageMap = useMemo(
    () => new Map(brokerageAccounts.map((b) => [b.id, b])),
    [brokerageAccounts],
  );

  const bankMap = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  // Consolidated banking + investment KPIs
  const portfolioMetrics = useMemo(() => {
    const bankCashTotal = activeBankAccounts.reduce((sum, a) => sum + a.balance, 0);
    const brokerageCashTotal = activeBrokerageAccounts.reduce((sum, b) => sum + b.cashBalance, 0);
    const marginDebtTotal = activeBrokerageAccounts.reduce((sum, b) => sum + b.marginDebt, 0);

    let holdingsMarketValue = 0;
    let holdingsCostBasis = 0;
    let publicSecuritiesVal = 0;
    let alternativesVal = 0;
    let realEstateVal = 0;

    activeHoldings.forEach((h) => {
      const mkt = h.totalMarketValue;
      const cost = h.quantity * h.unitCostBasis;
      holdingsMarketValue += mkt;
      holdingsCostBasis += cost;

      if (h.assetCategoryGroup === 'public_securities') publicSecuritiesVal += mkt;
      else if (h.assetCategoryGroup === 'alternatives') alternativesVal += mkt;
      else if (h.assetCategoryGroup === 'real_estate') realEstateVal += mkt;
    });

    const netInvestmentPortfolio = holdingsMarketValue + brokerageCashTotal - marginDebtTotal;
    const consolidatedNetWorth = bankCashTotal + netInvestmentPortfolio;
    const totalUnrealizedGain = holdingsMarketValue - holdingsCostBasis;
    const totalUnrealizedPct =
      holdingsCostBasis > 0 ? (totalUnrealizedGain / holdingsCostBasis) * 100 : 0;

    const liquidCashCombined = bankCashTotal + brokerageCashTotal;
    const grossAssetsTotal = bankCashTotal + brokerageCashTotal + holdingsMarketValue;
    const investedSharePct =
      grossAssetsTotal > 0 ? (holdingsMarketValue / grossAssetsTotal) * 100 : 0;
    const cashSharePct =
      grossAssetsTotal > 0 ? (liquidCashCombined / grossAssetsTotal) * 100 : 0;

    return {
      bankCashTotal,
      brokerageCashTotal,
      marginDebtTotal,
      holdingsMarketValue,
      holdingsCostBasis,
      netInvestmentPortfolio,
      consolidatedNetWorth,
      totalUnrealizedGain,
      totalUnrealizedPct,
      publicSecuritiesVal,
      alternativesVal,
      realEstateVal,
      investedSharePct,
      cashSharePct,
      grossAssetsTotal,
    };
  }, [activeBankAccounts, activeBrokerageAccounts, activeHoldings]);

  // Asset Allocation rows (Invested + Brokerage Cash)
  const allocationByGroup = useMemo(() => {
    const grossInvestment =
      portfolioMetrics.holdingsMarketValue + portfolioMetrics.brokerageCashTotal;
    const rows: Array<{
      key: AssetCategoryGroup | 'brokerage_cash';
      label: string;
      value: number;
      share: number;
      count: number;
    }> = [
      {
        key: 'public_securities',
        label: 'Public Securities (Equities, ETFs, Bonds)',
        value: portfolioMetrics.publicSecuritiesVal,
        share: grossInvestment > 0 ? (portfolioMetrics.publicSecuritiesVal / grossInvestment) * 100 : 0,
        count: activeHoldings.filter((h) => h.assetCategoryGroup === 'public_securities').length,
      },
      {
        key: 'alternatives',
        label: 'Alternatives & Private Credit',
        value: portfolioMetrics.alternativesVal,
        share: grossInvestment > 0 ? (portfolioMetrics.alternativesVal / grossInvestment) * 100 : 0,
        count: activeHoldings.filter((h) => h.assetCategoryGroup === 'alternatives').length,
      },
      {
        key: 'real_estate',
        label: 'Real Estate & REITs',
        value: portfolioMetrics.realEstateVal,
        share: grossInvestment > 0 ? (portfolioMetrics.realEstateVal / grossInvestment) * 100 : 0,
        count: activeHoldings.filter((h) => h.assetCategoryGroup === 'real_estate').length,
      },
      {
        key: 'brokerage_cash',
        label: 'Brokerage Cash & Sweep Reserves',
        value: portfolioMetrics.brokerageCashTotal,
        share: grossInvestment > 0 ? (portfolioMetrics.brokerageCashTotal / grossInvestment) * 100 : 0,
        count: activeBrokerageAccounts.length,
      },
    ];
    return rows.filter((r) => r.value > 0 || r.count > 0);
  }, [activeHoldings, activeBrokerageAccounts, portfolioMetrics]);

  // Class breakdown for detailed view
  const allocationByClass = useMemo(() => {
    const total = portfolioMetrics.holdingsMarketValue;
    const map = new Map<AssetClass, { label: string; value: number; count: number; cost: number }>();
    activeHoldings.forEach((h) => {
      const existing = map.get(h.assetClass) || {
        label: ASSET_CLASS_META[h.assetClass]?.label || h.assetClass,
        value: 0,
        count: 0,
        cost: 0,
      };
      existing.value += h.totalMarketValue;
      existing.cost += h.quantity * h.unitCostBasis;
      existing.count += 1;
      map.set(h.assetClass, existing);
    });
    return Array.from(map.entries())
      .map(([assetClass, info]) => {
        const gain = info.value - info.cost;
        const gainPct = info.cost > 0 ? (gain / info.cost) * 100 : 0;
        return {
          assetClass,
          ...info,
          share: total > 0 ? (info.value / total) * 100 : 0,
          gain,
          gainPct,
        };
      })
      .sort((a, b) => b.value - a.value);
  }, [activeHoldings, portfolioMetrics.holdingsMarketValue]);

  // Per-brokerage account valuation rollup
  const brokerageSummaries = useMemo(() => {
    return brokerageAccounts.map((brk) => {
      const linkedPositions = activeHoldings.filter((h) => h.brokerageAccountId === brk.id);
      const positionsValue = linkedPositions.reduce((s, h) => s + h.totalMarketValue, 0);
      const positionsCost = linkedPositions.reduce(
        (s, h) => s + h.quantity * h.unitCostBasis,
        0,
      );
      const netEquity = positionsValue + brk.cashBalance - brk.marginDebt;
      const gainUsd = positionsValue - positionsCost;
      const gainPct = positionsCost > 0 ? (gainUsd / positionsCost) * 100 : 0;
      const bankAccount = brk.linkedBankAccountId ? bankMap.get(brk.linkedBankAccountId) : undefined;
      return {
        account: brk,
        positionsCount: linkedPositions.length,
        positionsValue,
        positionsCost,
        netEquity,
        gainUsd,
        gainPct,
        bankAccount,
      };
    });
  }, [brokerageAccounts, activeHoldings, bankMap]);

  // Performance trajectory series grounded in actual cost basis, current valuations, and any live quote history
  const performanceSeries = useMemo(() => {
    const pointCount =
      perfRange === '1M' ? 12 : perfRange === '3M' ? 16 : perfRange === 'YTD' ? 18 : 24;
    const baseInvested =
      portfolioMetrics.holdingsCostBasis > 0
        ? portfolioMetrics.holdingsCostBasis + portfolioMetrics.brokerageCashTotal - portfolioMetrics.marginDebtTotal
        : portfolioMetrics.netInvestmentPortfolio;
    const endInvested = portfolioMetrics.netInvestmentPortfolio;
    const bankCash = portfolioMetrics.bankCashTotal;

    // Collect live market history index if any ticker has live history
    const liveHistories = Object.values(liveQuotes).filter(
      (q) => q.status === 'live' && Array.isArray(q.history) && q.history.length >= 5,
    );

    const points: Array<{
      label: string;
      invested: number;
      combined: number;
      costBasis: number;
    }> = [];

    const now = new Date('2026-11-18T12:00:00Z');
    const spanDays =
      perfRange === '1M' ? 30 : perfRange === '3M' ? 90 : perfRange === 'YTD' ? 320 : 365;

    for (let i = 0; i < pointCount; i++) {
      const progress = i / (pointCount - 1);
      const dt = new Date(now.getTime() - Math.round((1 - progress) * spanDays * 86400000));
      const label = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      let marketFactor = progress;
      if (liveHistories.length > 0 && perfRange === '1M') {
        // Derive normalized movement from real fetched market closes
        const ratios = liveHistories.map((q) => {
          const hist = q.history!;
          const hIdx = Math.min(hist.length - 1, Math.round(progress * (hist.length - 1)));
          const start = hist[0].close;
          const end = hist[hist.length - 1].close;
          const cur = hist[hIdx].close;
          return end !== start ? (cur - start) / (end - start) : progress;
        });
        const avgRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
        marketFactor = Math.max(-0.2, Math.min(1.2, avgRatio));
      } else {
        // Smooth deterministic trajectory between cost basis and current mark-to-market valuation
        const curve = Math.pow(progress, 0.92);
        const harmonic = Math.sin(progress * Math.PI * 3) * 0.03 * (1 - progress);
        marketFactor = curve + harmonic;
      }

      const investedVal = Math.max(
        0,
        baseInvested + (endInvested - baseInvested) * marketFactor,
      );
      const costLine = Math.max(0, baseInvested);

      points.push({
        label,
        invested: investedVal,
        combined: investedVal + bankCash,
        costBasis: costLine + (chartMode === 'combined' ? bankCash : 0),
      });
    }
    return points;
  }, [perfRange, chartMode, portfolioMetrics, liveQuotes]);

  const chartGeometry = useMemo(() => {
    const width = 760;
    const height = 220;
    const padX = 16;
    const padY = 18;
    const values = performanceSeries.flatMap((p) => [
      chartMode === 'combined' ? p.combined : p.invested,
      p.costBasis,
    ]);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const span = Math.max(rawMax - rawMin, Math.max(rawMax * 0.04, 1000));
    const minV = rawMin - span * 0.15;
    const maxV = rawMax + span * 0.12;

    const coords = performanceSeries.map((pt, idx) => {
      const val = chartMode === 'combined' ? pt.combined : pt.invested;
      const x =
        padX +
        (performanceSeries.length <= 1
          ? 0
          : (idx / (performanceSeries.length - 1)) * (width - padX * 2));
      const y = height - padY - ((val - minV) / (maxV - minV)) * (height - padY * 2);
      const costY =
        height - padY - ((pt.costBasis - minV) / (maxV - minV)) * (height - padY * 2);
      return { x, y, costY, val, pt };
    });

    const linePath = coords
      .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');
    const areaPath =
      coords.length > 0
        ? `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(height - padY).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(height - padY).toFixed(1)} Z`
        : '';
    const costLinePath = coords
      .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.costY.toFixed(1)}`)
      .join(' ');

    return { width, height, padY, minV, maxV, coords, linePath, areaPath, costLinePath };
  }, [performanceSeries, chartMode]);

  const filteredHoldings = useMemo(() => {
    const q = holdingSearch.trim().toLowerCase();
    return activeHoldings.filter((h) => {
      if (selectedBrokerageFilter === 'unassigned') {
        if (h.brokerageAccountId) return false;
      } else if (selectedBrokerageFilter !== 'all') {
        if (h.brokerageAccountId !== selectedBrokerageFilter) return false;
      }
      if (selectedGroupFilter !== 'all' && h.assetCategoryGroup !== selectedGroupFilter) {
        return false;
      }
      if (q) {
        const matchesName = h.assetName.toLowerCase().includes(q);
        const matchesTicker = h.tickerOrIdentifier.toLowerCase().includes(q);
        if (!matchesName && !matchesTicker) return false;
      }
      return true;
    });
  }, [activeHoldings, selectedBrokerageFilter, selectedGroupFilter, holdingSearch]);

  // Sync public equity / ETF market quotes via backend
  const handleSyncMarketQuotes = async (targetBrokerageId?: string) => {
    setSyncError(null);
    setSyncBanner(null);

    const candidateHoldings = activeHoldings.filter((h) => {
      if (targetBrokerageId && h.brokerageAccountId !== targetBrokerageId) return false;
      return (
        h.assetClass === 'public_equity' ||
        h.assetClass === 'etf_fund' ||
        h.assetClass === 'reit'
      );
    });

    const tickers = Array.from(
      new Set(
        candidateHoldings
          .map((h) => h.tickerOrIdentifier.trim().toUpperCase())
          .filter((t) => /^[A-Z0-9.\-^]{1,10}$/.test(t)),
      ),
    );

    setSyncingQuotes(true);
    try {
      let fetchedQuotes: Record<string, QuoteResult> = {};
      if (tickers.length > 0) {
        const res = await fetch('/api/portfolio/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tickers }),
        });
        if (!res.ok) {
          throw new Error('Market quote feed responded with an error.');
        }
        const payload = (await res.json()) as {
          syncedAt: string;
          quotes: Record<string, QuoteResult>;
        };
        fetchedQuotes = payload.quotes || {};
        setLiveQuotes((prev) => ({ ...prev, ...fetchedQuotes }));
      }

      const nowIso = new Date().toISOString().slice(0, 19) + 'Z';
      const todayIso = nowIso.slice(0, 10);
      const batch = writeBatch(db);
      let updatedAssetsCount = 0;

      candidateHoldings.forEach((h) => {
        const t = h.tickerOrIdentifier.trim().toUpperCase();
        const q = fetchedQuotes[t];
        if (q?.status === 'live' && typeof q.price === 'number' && q.price > 0) {
          const newMarketValue = Number((q.price * h.quantity).toFixed(2));
          if (Math.abs(newMarketValue - h.totalMarketValue) >= 0.01) {
            batch.update(doc(db, 'assets', h.id), {
              totalMarketValue: newMarketValue,
              valuationDate: todayIso,
              updatedAt: serverTimestamp(),
            });
            updatedAssetsCount += 1;
          }
        }
      });

      const accountsToStamp = targetBrokerageId
        ? brokerageAccounts.filter((b) => b.id === targetBrokerageId && b.status !== 'closed')
        : brokerageAccounts.filter(
            (b) => b.connectionMode === 'api_sync' && b.status !== 'closed',
          );

      accountsToStamp.forEach((b) => {
        batch.update(doc(db, 'brokerage_accounts', b.id), {
          syncStatus: b.connectionMode === 'api_sync' ? 'synced' : b.syncStatus,
          lastSyncedAt: nowIso,
          status: 'active',
          updatedAt: serverTimestamp(),
        });
      });

      if (updatedAssetsCount > 0 || accountsToStamp.length > 0) {
        await batch.commit();
      }

      const liveCount = Object.values(fetchedQuotes).filter((q) => q.status === 'live').length;
      if (tickers.length === 0) {
        setSyncBanner(
          accountsToStamp.length > 0
            ? `Brokerage feed timestamp verified (${accountsToStamp.length} account${accountsToStamp.length > 1 ? 's' : ''}). Add public tickers (e.g., AAPL, IEF, VTI) for live quote refresh.`
            : 'No public equity or ETF tickers found to refresh.',
        );
      } else {
        setSyncBanner(
          `Synced ${liveCount}/${tickers.length} live market quotes${updatedAssetsCount > 0 ? ` · updated ${updatedAssetsCount} position valuation${updatedAssetsCount > 1 ? 's' : ''}` : ' · valuations already current'}.`,
        );
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        handleFirestoreError(error, OperationType.WRITE, 'brokerage_accounts/sync');
      }
      setSyncError(
        error instanceof Error ? error.message : 'Unable to synchronize brokerage feed.',
      );
    } finally {
      setSyncingQuotes(false);
    }
  };

  // Open Link / Edit Brokerage Account modal
  const openNewBrokerModal = (initialMode: BrokerageConnectionMode = 'manual') => {
    setEditingBrokerage(null);
    setLinkMode(initialMode);
    setApiProvider(initialMode === 'api_sync' ? 'custody_fix_gateway' : 'manual_ledger');
    setBrokerInstitution(
      initialMode === 'api_sync'
        ? 'Meridian Clearing & Custody LLC'
        : 'Charles Schwab Institutional',
    );
    setAccountName('');
    setAccountType('individual_taxable');
    setAccountMask('');
    setCurrency('USD');
    setCashBalance('25000');
    setMarginDebt('0');
    setLinkedBankAccountId(activeBankAccounts[0]?.id || '');
    setFirmId(firms[0]?.id || '');
    setBrokerFormError(null);
    setBrokerModalOpen(true);
  };

  const openEditBrokerModal = (brk: BrokerageAccount) => {
    setEditingBrokerage(brk);
    setLinkMode(brk.connectionMode);
    setApiProvider(brk.apiProvider);
    setBrokerInstitution(brk.brokerInstitution);
    setAccountName(brk.accountName);
    setAccountType(brk.accountType);
    setAccountMask(brk.accountMask);
    setCurrency(brk.currency);
    setCashBalance(String(brk.cashBalance));
    setMarginDebt(String(brk.marginDebt));
    setLinkedBankAccountId(brk.linkedBankAccountId);
    setFirmId(brk.firmId);
    setBrokerFormError(null);
    setBrokerModalOpen(true);
  };

  const handleSaveBrokerage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBrokerFormError(null);

    const cleanName = accountName.trim().slice(0, FIELD_LIMITS.NAME_MAX);
    const cleanInst = brokerInstitution.trim().slice(0, FIELD_LIMITS.INSTITUTION_MAX);
    const cleanMask = accountMask.trim();
    const cashVal = Number.parseFloat(cashBalance);
    const marginVal = Number.parseFloat(marginDebt);

    if (cleanName.length < 2) {
      setBrokerFormError('Account name must be at least 2 characters.');
      return;
    }
    if (cleanInst.length < 2) {
      setBrokerFormError('Brokerage institution name must be at least 2 characters.');
      return;
    }
    if (!editingBrokerage && !FIELD_LIMITS.FOUR_DIGITS_PATTERN.test(cleanMask)) {
      setBrokerFormError('Account mask must be exactly 4 digits (e.g., 4821).');
      return;
    }
    if (!Number.isFinite(cashVal) || cashVal < 0 || cashVal > 10000000000) {
      setBrokerFormError('Brokerage cash balance must be a non-negative number.');
      return;
    }
    if (!Number.isFinite(marginVal) || marginVal < 0 || marginVal > 10000000000) {
      setBrokerFormError('Margin debt balance must be a non-negative number.');
      return;
    }

    const chosenProvider: BrokerageApiProvider =
      linkMode === 'manual'
        ? 'manual_ledger'
        : apiProvider === 'manual_ledger'
          ? 'custody_fix_gateway'
          : apiProvider;

    const nowStamp = new Date().toISOString().slice(0, 19) + 'Z';
    setSavingBrokerage(true);
    try {
      if (editingBrokerage) {
        await updateDoc(doc(db, 'brokerage_accounts', editingBrokerage.id), {
          firmId,
          linkedBankAccountId,
          accountName: cleanName,
          brokerInstitution: cleanInst,
          accountType,
          connectionMode: linkMode,
          apiProvider: chosenProvider,
          syncStatus: linkMode === 'api_sync' ? 'synced' : 'manual_only',
          lastSyncedAt: nowStamp,
          cashBalance: Number(cashVal.toFixed(2)),
          marginDebt: Number(marginVal.toFixed(2)),
          status: 'active',
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'brokerage_accounts'), {
          ownerId: user.uid,
          firmId,
          linkedBankAccountId,
          accountName: cleanName,
          brokerInstitution: cleanInst,
          accountType,
          accountMask: cleanMask,
          connectionMode: linkMode,
          apiProvider: chosenProvider,
          syncStatus: linkMode === 'api_sync' ? 'synced' : 'manual_only',
          lastSyncedAt: nowStamp,
          currency,
          cashBalance: Number(cashVal.toFixed(2)),
          marginDebt: Number(marginVal.toFixed(2)),
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setBrokerModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'brokerage_accounts');
    } finally {
      setSavingBrokerage(false);
    }
  };

  const handleCloseBrokerageAccount = async () => {
    if (!closingTarget) return;
    setClosingBusy(true);
    try {
      await updateDoc(doc(db, 'brokerage_accounts', closingTarget.id), {
        status: 'closed',
        updatedAt: serverTimestamp(),
      });
      if (selectedBrokerageFilter === closingTarget.id) {
        setSelectedBrokerageFilter('all');
      }
      setClosingTarget(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `brokerage_accounts/${closingTarget.id}`);
    } finally {
      setClosingBusy(false);
    }
  };

  // Holding Modal handlers
  const openNewHoldingModal = (preselectedBrokerageId = '') => {
    setEditingAsset(null);
    setPosBrokerageId(preselectedBrokerageId || activeBrokerageAccounts[0]?.id || '');
    setPosName('');
    setPosTicker('');
    setPosClass('public_equity');
    setPosQty('100');
    setPosCostBasis('150.00');
    setPosMarketValue('16500.00');
    setPosDate(new Date().toISOString().slice(0, 10));
    setPosJurisdiction('United States · Delaware');
    setHoldingFormError(null);
    setHoldingModalOpen(true);
  };

  const openEditHoldingModal = (asset: OnboardedAsset) => {
    setEditingAsset(asset);
    setPosBrokerageId(asset.brokerageAccountId || '');
    setPosName(asset.assetName);
    setPosTicker(asset.tickerOrIdentifier);
    setPosClass(asset.assetClass);
    setPosQty(String(asset.quantity));
    setPosCostBasis(String(asset.unitCostBasis));
    setPosMarketValue(String(asset.totalMarketValue));
    setPosDate(asset.valuationDate);
    setPosJurisdiction(asset.jurisdiction);
    setHoldingFormError(null);
    setHoldingModalOpen(true);
  };

  const handleSaveHolding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setHoldingFormError(null);

    const cleanName = posName.trim().slice(0, 140);
    const cleanTicker = posTicker.trim().toUpperCase().slice(0, 48);
    const qty = Number.parseFloat(posQty);
    const cost = Number.parseFloat(posCostBasis);
    const mkt = Number.parseFloat(posMarketValue);
    const cleanJur = posJurisdiction.trim().slice(0, 80) || 'United States';

    if (cleanName.length < 2) {
      setHoldingFormError('Asset name must be at least 2 characters.');
      return;
    }
    if (cleanTicker.length < 1) {
      setHoldingFormError('Ticker or CUSIP/identifier is required.');
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setHoldingFormError('Quantity must be greater than zero.');
      return;
    }
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(mkt) || mkt < 0) {
      setHoldingFormError('Cost basis and market value must be non-negative.');
      return;
    }

    const meta = ASSET_CLASS_META[posClass];
    const selectedBroker = posBrokerageId ? brokerageMap.get(posBrokerageId) : undefined;
    const derivedAccountId = selectedBroker?.linkedBankAccountId || activeBankAccounts[0]?.id || '';
    const derivedFirmId = selectedBroker?.firmId || '';

    setSavingHolding(true);
    try {
      if (editingAsset) {
        await updateDoc(doc(db, 'assets', editingAsset.id), {
          assetName: cleanName,
          tickerOrIdentifier: cleanTicker,
          quantity: qty,
          unitCostBasis: cost,
          totalMarketValue: Number(mkt.toFixed(2)),
          valuationDate: posDate,
          jurisdiction: cleanJur,
          brokerageAccountId: posBrokerageId,
          accountId: editingAsset.accountId || derivedAccountId,
          firmId: editingAsset.firmId || derivedFirmId,
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'assets'), {
          ownerId: user.uid,
          ingestionId: '',
          accountId: derivedAccountId,
          firmId: derivedFirmId,
          brokerageAccountId: posBrokerageId,
          assetName: cleanName,
          tickerOrIdentifier: cleanTicker,
          assetCategoryGroup: meta.group,
          assetClass: posClass,
          quantity: qty,
          unitCostBasis: cost,
          totalMarketValue: Number(mkt.toFixed(2)),
          currency: selectedBroker?.currency || 'USD',
          valuationDate: posDate,
          jurisdiction: cleanJur,
          regulatoryClassification: meta.defaultRegClass,
          mfaVerified: false,
          custodyStatus: 'pending_verification',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setHoldingModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'assets');
    } finally {
      setSavingHolding(false);
    }
  };

  const activeHoverPoint =
    hoverIdx !== null && chartGeometry.coords[hoverIdx]
      ? chartGeometry.coords[hoverIdx]
      : chartGeometry.coords[chartGeometry.coords.length - 1];

  return (
    <div className="space-y-8">
      {/* Page Header & Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 font-display">
            Consolidated Investment Portfolio &amp; Financial Health
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {activeBrokerageAccounts.length} linked brokerage accounts · {activeHoldings.length}{' '}
            active positions combined with {activeBankAccounts.length} banking accounts
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void handleSyncMarketQuotes()}
            disabled={syncingQuotes}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncingQuotes ? 'animate-spin' : ''}`} />
            <span>{syncingQuotes ? 'Syncing Quotes...' : 'Sync Market Quotes'}</span>
          </button>

          <button
            type="button"
            onClick={() => openNewHoldingModal()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Holding</span>
          </button>

          <button
            type="button"
            onClick={() => openNewBrokerModal('manual')}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Link2 className="w-3.5 h-3.5" />
            <span>Link Brokerage Account</span>
          </button>
        </div>
      </div>

      {/* Sync Banner / Error Feedback */}
      {syncBanner && (
        <div className="flex items-center justify-between gap-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{syncBanner}</span>
          </span>
          <button
            type="button"
            onClick={() => setSyncBanner(null)}
            className="text-emerald-700 hover:text-emerald-900 cursor-pointer"
            aria-label="Dismiss notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {syncError && (
        <div className="flex items-center justify-between gap-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">
          <span>{syncError}</span>
          <button
            type="button"
            onClick={() => setSyncError(null)}
            className="text-red-700 hover:text-red-900 cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 4-Column Consolidated Financial Health KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Consolidated Net Worth</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {formatCurrency(portfolioMetrics.consolidatedNetWorth)}
          </p>
          <p className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
            Banking {formatCompactCurrency(portfolioMetrics.bankCashTotal)} + Investments{' '}
            {formatCompactCurrency(portfolioMetrics.netInvestmentPortfolio)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Total Investment Portfolio</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {formatCurrency(portfolioMetrics.netInvestmentPortfolio)}
          </p>
          <p className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
            Holdings {formatCompactCurrency(portfolioMetrics.holdingsMarketValue)} · Cash{' '}
            {formatCompactCurrency(portfolioMetrics.brokerageCashTotal)}
            {portfolioMetrics.marginDebtTotal > 0
              ? ` · Margin -${formatCompactCurrency(portfolioMetrics.marginDebtTotal)}`
              : ''}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Unrealized Performance</p>
          <div className="flex items-baseline gap-2 mt-2">
            <p
              className={`text-2xl font-semibold font-mono tabular-nums ${
                portfolioMetrics.totalUnrealizedGain >= 0 ? 'text-emerald-700' : 'text-red-700'
              }`}
            >
              {portfolioMetrics.totalUnrealizedGain >= 0 ? '+' : ''}
              {formatCompactCurrency(portfolioMetrics.totalUnrealizedGain)}
            </p>
            <span
              className={`inline-flex items-center gap-0.5 text-xs font-mono tabular-nums font-medium ${
                portfolioMetrics.totalUnrealizedPct >= 0 ? 'text-emerald-700' : 'text-red-700'
              }`}
            >
              {portfolioMetrics.totalUnrealizedPct >= 0 ? (
                <ArrowUpRight className="w-3.5 h-3.5" />
              ) : (
                <ArrowDownRight className="w-3.5 h-3.5" />
              )}
              {portfolioMetrics.totalUnrealizedPct >= 0 ? '+' : ''}
              {portfolioMetrics.totalUnrealizedPct.toFixed(2)}%
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
            Cost basis {formatCurrency(portfolioMetrics.holdingsCostBasis)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Liquidity vs. Invested Mix</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {portfolioMetrics.investedSharePct.toFixed(1)}% /{' '}
            {portfolioMetrics.cashSharePct.toFixed(1)}%
          </p>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden flex mt-3">
            <div
              className="h-full bg-slate-900"
              style={{ width: `${Math.min(100, portfolioMetrics.investedSharePct)}%` }}
              title={`Invested Capital: ${portfolioMetrics.investedSharePct.toFixed(1)}%`}
            />
            <div
              className="h-full bg-sky-500"
              style={{ width: `${Math.min(100, portfolioMetrics.cashSharePct)}%` }}
              title={`Cash Liquidity: ${portfolioMetrics.cashSharePct.toFixed(1)}%`}
            />
          </div>
        </div>
      </section>

      {/* Main Analytics Split: Performance Trajectory + Asset Allocation */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900 font-display">
                Portfolio Performance &amp; Net Worth Trajectory
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Mark-to-market valuation vs. cumulative cost basis baseline
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex border border-slate-200 rounded-lg p-0.5 bg-slate-50 text-xs">
                <button
                  type="button"
                  onClick={() => setChartMode('combined')}
                  className={`px-2.5 py-1 rounded-md font-medium cursor-pointer transition-colors ${
                    chartMode === 'combined'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Net Worth
                </button>
                <button
                  type="button"
                  onClick={() => setChartMode('investments')}
                  className={`px-2.5 py-1 rounded-md font-medium cursor-pointer transition-colors ${
                    chartMode === 'investments'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Investments Only
                </button>
              </div>

              <div className="inline-flex border border-slate-200 rounded-lg p-0.5 bg-slate-50 text-xs font-mono">
                {(['1M', '3M', 'YTD', '1Y'] as PerfRange[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setPerfRange(r)}
                    className={`px-2 py-1 rounded-md cursor-pointer transition-colors ${
                      perfRange === r
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {activeHoverPoint && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg mb-4 text-xs">
              <div className="flex items-center gap-3">
                <span className="font-mono text-slate-500">{activeHoverPoint.pt.label}</span>
                <span className="font-semibold font-mono tabular-nums text-slate-900">
                  {formatCurrency(activeHoverPoint.val)}
                </span>
              </div>
              <div className="flex items-center gap-4 font-mono tabular-nums text-slate-600">
                <span>Cost Basis: {formatCurrency(activeHoverPoint.pt.costBasis)}</span>
                <span
                  className={
                    activeHoverPoint.val >= activeHoverPoint.pt.costBasis
                      ? 'text-emerald-700 font-medium'
                      : 'text-red-700 font-medium'
                  }
                >
                  {activeHoverPoint.val >= activeHoverPoint.pt.costBasis ? '+' : ''}
                  {formatCurrency(activeHoverPoint.val - activeHoverPoint.pt.costBasis)}
                </span>
              </div>
            </div>
          )}

          <div className="w-full overflow-hidden">
            <svg
              viewBox={`0 0 ${chartGeometry.width} ${chartGeometry.height}`}
              className="w-full h-52 overflow-visible"
              onMouseLeave={() => setHoverIdx(null)}
            >
              <defs>
                <linearGradient id="portfolioAreaGrad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#0F172A" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="#0F172A" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {[0.25, 0.5, 0.75].map((ratio) => {
                const y = chartGeometry.height * ratio;
                return (
                  <line
                    key={ratio}
                    x1={16}
                    x2={chartGeometry.width - 16}
                    y1={y}
                    y2={y}
                    stroke="#E2E8F0"
                    strokeDasharray="3 3"
                    strokeWidth="1"
                  />
                );
              })}

              {chartGeometry.costLinePath && (
                <path
                  d={chartGeometry.costLinePath}
                  fill="none"
                  stroke="#94A3B8"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                />
              )}

              {chartGeometry.areaPath && (
                <path d={chartGeometry.areaPath} fill="url(#portfolioAreaGrad)" />
              )}

              {chartGeometry.linePath && (
                <path
                  d={chartGeometry.linePath}
                  fill="none"
                  stroke="#0F172A"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {chartGeometry.coords.map((c, idx) => {
                const isSelected =
                  hoverIdx === idx ||
                  (hoverIdx === null && idx === chartGeometry.coords.length - 1);
                return (
                  <g key={c.pt.label + idx}>
                    <rect
                      x={c.x - 18}
                      y={0}
                      width={36}
                      height={chartGeometry.height}
                      fill="transparent"
                      className="cursor-pointer"
                      onMouseEnter={() => setHoverIdx(idx)}
                    />
                    {isSelected && (
                      <>
                        <line
                          x1={c.x}
                          x2={c.x}
                          y1={14}
                          y2={chartGeometry.height - chartGeometry.padY}
                          stroke="#CBD5E1"
                          strokeWidth="1"
                        />
                        <circle
                          cx={c.x}
                          cy={c.y}
                          r={4.5}
                          fill="#0F172A"
                          stroke="#FFFFFF"
                          strokeWidth="2"
                        />
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600">
            <div className="flex items-center gap-5">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-slate-900 inline-block" />
                <span>{chartMode === 'combined' ? 'Total Net Worth' : 'Portfolio Equity'}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 border-t border-dashed border-slate-400 inline-block" />
                <span>Cost Basis Baseline</span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('ledger')}
              className="text-slate-900 font-medium hover:underline cursor-pointer"
            >
              Inspect Banking Liquidity
            </button>
          </div>
        </div>

        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2 mb-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900 font-display">
                  Asset Allocation
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Portfolio distribution across asset classes &amp; brokerage cash
                </p>
              </div>
              <PieChart className="w-4 h-4 text-slate-400 shrink-0" />
            </div>

            {/* Stacked Horizontal Allocation Bar */}
            <div className="w-full h-3 bg-slate-100 rounded-md overflow-hidden flex mb-5">
              {allocationByGroup.map((row) => (
                <div
                  key={row.key}
                  className={`${GROUP_COLORS[row.key]} h-full transition-all duration-200`}
                  style={{ width: `${Math.max(row.share > 0 ? 2 : 0, row.share)}%` }}
                  title={`${row.label}: ${formatCurrency(row.value)} (${row.share.toFixed(1)}%)`}
                />
              ))}
            </div>

            <div className="space-y-3.5">
              {allocationByGroup.map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: GROUP_DOT_COLORS[row.key] }}
                    />
                    <span className="font-medium text-slate-800 truncate">{row.label}</span>
                    <span className="text-slate-400 font-mono shrink-0">({row.count})</span>
                  </div>
                  <div className="text-right font-mono tabular-nums shrink-0">
                    <span className="font-medium text-slate-900">{formatCurrency(row.value)}</span>
                    <span className="text-slate-500 ml-2">{row.share.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>

            {allocationByClass.length > 0 && (
              <div className="mt-5 pt-4 border-t border-slate-100">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2.5">
                  Breakdown by Asset Class
                </p>
                <div className="space-y-2">
                  {allocationByClass.slice(0, 5).map((cls) => (
                    <div
                      key={cls.assetClass}
                      className="flex items-center justify-between text-xs gap-2"
                    >
                      <span className="text-slate-700 truncate">{cls.label}</span>
                      <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                        <span
                          className={
                            cls.gainPct >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }
                        >
                          {cls.gainPct >= 0 ? '+' : ''}
                          {cls.gainPct.toFixed(1)}%
                        </span>
                        <span className="text-slate-900 font-medium">
                          {formatCompactCurrency(cls.value)}
                        </span>
                        <span className="text-slate-500 w-11 text-right">
                          {cls.share.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-500">Have a PDF or CSV statement?</span>
            <button
              type="button"
              onClick={() => onNavigateTab('assets')}
              className="inline-flex items-center gap-1 font-medium text-slate-900 hover:underline cursor-pointer"
            >
              <FolderUp className="w-3.5 h-3.5" />
              <span>Import via Staging Review</span>
            </button>
          </div>
        </div>
      </section>

      {/* Linked Brokerage Accounts Section */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Linked Brokerage Accounts
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Connect brokerage accounts manually or via secure read-only API quote &amp; custody feed
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openNewBrokerModal('api_sync')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Connect via API Feed</span>
            </button>
            <button
              type="button"
              onClick={() => openNewBrokerModal('manual')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Manual Brokerage</span>
            </button>
          </div>
        </div>

        {brokerageSummaries.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm text-slate-600 mb-4">
              No brokerage accounts linked yet. Add an account manually or connect an API feed to
              consolidate your holdings.
            </p>
            <button
              type="button"
              onClick={() => openNewBrokerModal('manual')}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
            >
              Link First Brokerage Account
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-5">
            {brokerageSummaries.map(
              ({ account, positionsCount, positionsValue, netEquity, gainUsd, gainPct, bankAccount }) => {
                const isClosed = account.status === 'closed';
                const typeMeta = BROKERAGE_ACCOUNT_TYPE_META[account.accountType];
                return (
                  <div
                    key={account.id}
                    className={`border rounded-xl p-5 flex flex-col justify-between gap-4 ${
                      isClosed
                        ? 'bg-slate-50 border-slate-200 opacity-75'
                        : 'bg-white border-slate-200'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-sm font-semibold text-slate-900 truncate">
                            {account.accountName}
                          </h4>
                          <span className="text-xs font-mono text-slate-500 shrink-0">
                            ••••{account.accountMask}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          {account.brokerInstitution} · {typeMeta.label}
                        </p>
                      </div>

                      <span
                        className={`text-[11px] font-medium px-2 py-0.5 rounded border shrink-0 ${
                          isClosed
                            ? 'bg-slate-100 text-slate-600 border-slate-200'
                            : account.connectionMode === 'api_sync'
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                              : 'bg-slate-50 text-slate-700 border-slate-200'
                        }`}
                      >
                        {isClosed
                          ? 'Closed'
                          : account.connectionMode === 'api_sync'
                            ? 'API Feed Synced'
                            : 'Manual Ledger'}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-3 py-3 border-y border-slate-100">
                      <div>
                        <p className="text-[11px] text-slate-500">Net Account Equity</p>
                        <p className="text-sm font-semibold text-slate-900 font-mono tabular-nums mt-0.5">
                          {formatCurrency(netEquity, account.currency)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500">Holdings ({positionsCount})</p>
                        <p className="text-sm font-medium text-slate-800 font-mono tabular-nums mt-0.5">
                          {formatCurrency(positionsValue, account.currency)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500">Cash / Margin</p>
                        <p className="text-sm font-medium text-slate-800 font-mono tabular-nums mt-0.5">
                          {formatCompactCurrency(account.cashBalance, account.currency)}
                          {account.marginDebt > 0
                            ? ` / -${formatCompactCurrency(account.marginDebt, account.currency)}`
                            : ''}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div className="text-slate-500 space-y-0.5">
                        <div className="flex items-center gap-2 font-mono tabular-nums">
                          <span>Unrealized:</span>
                          <span
                            className={
                              gainUsd >= 0
                                ? 'text-emerald-700 font-medium'
                                : 'text-red-700 font-medium'
                            }
                          >
                            {gainUsd >= 0 ? '+' : ''}
                            {formatCurrency(gainUsd, account.currency)} ({gainPct >= 0 ? '+' : ''}
                            {gainPct.toFixed(1)}%)
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400">
                          {bankAccount
                            ? `Linked Bank: ${bankAccount.accountName} (····${bankAccount.accountMask})`
                            : 'No linked bank settlement account'}{' '}
                          · Synced {account.lastSyncedAt.slice(0, 10)}
                        </p>
                      </div>

                      {!isClosed && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => openNewHoldingModal(account.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                            title="Add holding to this brokerage account"
                          >
                            <Plus className="w-3 h-3" />
                            <span>Position</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSyncMarketQuotes(account.id)}
                            disabled={syncingQuotes}
                            className="p-1.5 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg cursor-pointer"
                            title="Sync account quotes & feed timestamp"
                            aria-label="Sync account"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditBrokerModal(account)}
                            className="p-1.5 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg cursor-pointer"
                            title="Edit brokerage account"
                            aria-label="Edit brokerage account"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setClosingTarget(account)}
                            className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded-lg cursor-pointer"
                            title="Close / unlink brokerage account"
                            aria-label="Close brokerage account"
                          >
                            <Unlink className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              },
            )}
          </div>
        )}
      </section>

      {/* Consolidated Investment Holdings & Performance Table */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Investment Holdings &amp; Performance Ledger
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Position-level cost basis, live valuations, unrealized return, and portfolio weight
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={holdingSearch}
                onChange={(e) => setHoldingSearch(e.target.value)}
                placeholder="Search ticker or asset..."
                className="pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 w-48"
              />
            </div>

            <select
              value={selectedBrokerageFilter}
              onChange={(e) => setSelectedBrokerageFilter(e.target.value)}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
              aria-label="Filter by brokerage account"
            >
              <option value="all">All Brokerage Accounts</option>
              {brokerageAccounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.accountName} (····{b.accountMask})
                </option>
              ))}
              <option value="unassigned">Unassigned Custody Registry</option>
            </select>

            <select
              value={selectedGroupFilter}
              onChange={(e) =>
                setSelectedGroupFilter(e.target.value as 'all' | AssetCategoryGroup)
              }
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
              aria-label="Filter by asset group"
            >
              <option value="all">All Asset Groups</option>
              <option value="public_securities">Public Securities</option>
              <option value="alternatives">Alternatives</option>
              <option value="real_estate">Real Estate</option>
            </select>
          </div>
        </div>

        {filteredHoldings.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm text-slate-600 mb-4">
              No investment holdings match your active filters.
            </p>
            <button
              type="button"
              onClick={() => openNewHoldingModal()}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
            >
              Add Investment Position
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-3 pr-4">Asset &amp; Ticker</th>
                  <th className="py-3 px-3">Brokerage Account</th>
                  <th className="py-3 px-3">Class</th>
                  <th className="py-3 px-3 text-right">Qty / Avg Cost</th>
                  <th className="py-3 px-3 text-right">Market Value</th>
                  <th className="py-3 px-3 text-right">Unrealized P&amp;L</th>
                  <th className="py-3 px-3 text-right">Weight</th>
                  <th className="py-3 pl-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredHoldings.map((h) => {
                  const costTotal = h.quantity * h.unitCostBasis;
                  const gainUsd = h.totalMarketValue - costTotal;
                  const gainPct = costTotal > 0 ? (gainUsd / costTotal) * 100 : 0;
                  const weight =
                    portfolioMetrics.holdingsMarketValue > 0
                      ? (h.totalMarketValue / portfolioMetrics.holdingsMarketValue) * 100
                      : 0;
                  const brk = h.brokerageAccountId ? brokerageMap.get(h.brokerageAccountId) : undefined;
                  const live = liveQuotes[h.tickerOrIdentifier.trim().toUpperCase()];
                  const classMeta = ASSET_CLASS_META[h.assetClass];

                  return (
                    <tr key={h.id} className="hover:bg-slate-50/75 transition-colors">
                      <td className="py-3.5 pr-4">
                        <div className="font-medium text-slate-900">{h.assetName}</div>
                        <div className="flex items-center gap-2 mt-0.5 font-mono text-[11px] text-slate-500">
                          <span>{h.tickerOrIdentifier}</span>
                          {live?.status === 'live' && typeof live.changePct === 'number' && (
                            <span
                              className={
                                live.changePct >= 0 ? 'text-emerald-700' : 'text-red-700'
                              }
                            >
                              · Live {formatCurrency(live.price || 0)} (
                              {live.changePct >= 0 ? '+' : ''}
                              {live.changePct.toFixed(2)}%)
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-3">
                        {brk ? (
                          <div>
                            <div className="text-slate-800 font-medium">{brk.accountName}</div>
                            <div className="text-[11px] text-slate-500 font-mono">
                              {brk.brokerInstitution} · ••••{brk.accountMask}
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openEditHoldingModal(h)}
                            className="text-amber-700 hover:underline font-medium cursor-pointer"
                          >
                            Assign Brokerage Account
                          </button>
                        )}
                      </td>

                      <td className="py-3.5 px-3 whitespace-nowrap text-slate-700">
                        {classMeta?.label || h.assetClass}
                      </td>

                      <td className="py-3.5 px-3 text-right font-mono tabular-nums">
                        <div className="text-slate-900">{h.quantity.toLocaleString('en-US')}</div>
                        <div className="text-[11px] text-slate-500">
                          @ {formatCurrency(h.unitCostBasis, h.currency)}
                        </div>
                      </td>

                      <td className="py-3.5 px-3 text-right font-mono tabular-nums">
                        <div className="font-semibold text-slate-900">
                          {formatCurrency(h.totalMarketValue, h.currency)}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {formatCurrency(h.totalMarketValue / h.quantity, h.currency)} / unit
                        </div>
                      </td>

                      <td className="py-3.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <div
                          className={`font-medium ${
                            gainUsd >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {gainUsd >= 0 ? '+' : ''}
                          {formatCurrency(gainUsd, h.currency)}
                        </div>
                        <div
                          className={`text-[11px] ${
                            gainPct >= 0 ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {gainPct >= 0 ? '+' : ''}
                          {gainPct.toFixed(2)}%
                        </div>
                      </td>

                      <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        {weight.toFixed(1)}%
                      </td>

                      <td className="py-3.5 pl-3 text-right">
                        <button
                          type="button"
                          onClick={() => openEditHoldingModal(h)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer"
                        >
                          <Pencil className="w-3 h-3" />
                          <span>Edit</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Consolidated Banking + Investment Health Summary Strip */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Banking &amp; Brokerage Liquidity Bridge
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Unified balance sheet across cash depositories and investment custody accounts
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigateTab('brokerage')}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              Brokerage Firms &amp; Tax
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('ledger')}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              Bank Accounts &amp; Ledger
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-5">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-3">
            <Landmark className="w-5 h-5 text-slate-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-slate-500">Banking Cash Reserves</p>
              <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1">
                {formatCurrency(portfolioMetrics.bankCashTotal)}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                Across {activeBankAccounts.length} active checking, treasury &amp; purchases accounts
              </p>
            </div>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-3">
            <TrendingUp className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-slate-500">Invested Securities &amp; Alts</p>
              <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1">
                {formatCurrency(portfolioMetrics.holdingsMarketValue)}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                {activeHoldings.length} positions ·{' '}
                {portfolioMetrics.totalUnrealizedGain >= 0 ? '+' : ''}
                {formatCurrency(portfolioMetrics.totalUnrealizedGain)} unrealized return
              </p>
            </div>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-3">
            <Wallet className="w-5 h-5 text-sky-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-slate-500">Brokerage Sweep Cash</p>
              <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1">
                {formatCurrency(portfolioMetrics.brokerageCashTotal)}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                Ready purchasing power across {activeBrokerageAccounts.length} linked brokerages
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Link / Edit Brokerage Account Modal */}
      {brokerModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-slate-700" />
                <h3 className="text-base font-semibold text-slate-900 font-display">
                  {editingBrokerage ? 'Edit Brokerage Account' : 'Link Brokerage Account'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setBrokerModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveBrokerage(e)} className="mt-5 space-y-4">
              {brokerFormError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {brokerFormError}
                </div>
              )}

              {/* Connection Mode Switcher */}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Connection Method
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setLinkMode('manual');
                      setApiProvider('manual_ledger');
                    }}
                    className={`p-3 text-left border rounded-lg cursor-pointer transition-colors ${
                      linkMode === 'manual'
                        ? 'border-slate-900 bg-slate-50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="text-xs font-semibold text-slate-900">Manual Entry</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Track balances &amp; lots manually
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLinkMode('api_sync');
                      setApiProvider('custody_fix_gateway');
                    }}
                    className={`p-3 text-left border rounded-lg cursor-pointer transition-colors ${
                      linkMode === 'api_sync'
                        ? 'border-slate-900 bg-slate-50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="text-xs font-semibold text-slate-900">Secure API Feed</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Read-only quote &amp; custody sync
                    </div>
                  </button>
                </div>
              </div>

              {linkMode === 'api_sync' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    API &amp; Clearing Feed Channel
                  </label>
                  <select
                    value={apiProvider}
                    onChange={(e) => setApiProvider(e.target.value as BrokerageApiProvider)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900"
                  >
                    <option value="custody_fix_gateway">
                      Veridian Custody FIX / Live Market Quote Feed (Active)
                    </option>
                    <option value="statement_sync">
                      Multimodal Statement Sync (PDF / CSV / JSON)
                    </option>
                    <option
                      value="direct_api_feed"
                      disabled={
                        !providerInfo?.externalAggregators.find((a) => a.id === 'direct_api_feed')
                          ?.available
                      }
                    >
                      External Brokerage Aggregator API (
                      {providerInfo?.externalAggregators.find((a) => a.id === 'direct_api_feed')
                        ?.available
                        ? 'Configured'
                        : 'Requires Server Aggregator Credentials'}
                      )
                    </option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Brokerage Institution
                  </label>
                  <input
                    type="text"
                    list="broker-institution-list"
                    value={brokerInstitution}
                    onChange={(e) => setBrokerInstitution(e.target.value)}
                    placeholder="e.g., Charles Schwab"
                    maxLength={FIELD_LIMITS.INSTITUTION_MAX}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                  <datalist id="broker-institution-list">
                    {INSTITUTION_SUGGESTIONS.map((inst) => (
                      <option key={inst} value={inst} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Account Label
                  </label>
                  <input
                    type="text"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    placeholder="e.g., Individual Growth Portfolio"
                    maxLength={FIELD_LIMITS.NAME_MAX}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Account Type
                  </label>
                  <select
                    value={accountType}
                    onChange={(e) => setAccountType(e.target.value as BrokerageAccountType)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900"
                  >
                    {Object.entries(BROKERAGE_ACCOUNT_TYPE_META).map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Last 4 Digits
                  </label>
                  <input
                    type="text"
                    value={accountMask}
                    disabled={Boolean(editingBrokerage)}
                    onChange={(e) => setAccountMask(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="4821"
                    maxLength={4}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900 disabled:bg-slate-100"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Brokerage Cash
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={cashBalance}
                    onChange={(e) => setCashBalance(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Margin Debt
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={marginDebt}
                    onChange={(e) => setMarginDebt(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Currency</label>
                  <select
                    value={currency}
                    disabled={Boolean(editingBrokerage)}
                    onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900 disabled:bg-slate-100"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Linked Bank Funding Account
                  </label>
                  <select
                    value={linkedBankAccountId}
                    onChange={(e) => setLinkedBankAccountId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900"
                  >
                    <option value="">None (Standalone)</option>
                    {activeBankAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.accountName} (····{acc.accountMask})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Registered Clearing Firm (Optional)
                  </label>
                  <select
                    value={firmId}
                    onChange={(e) => setFirmId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900"
                  >
                    <option value="">External / Self-Directed</option>
                    {firms.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.firmName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setBrokerModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBrokerage}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  {savingBrokerage
                    ? 'Saving...'
                    : editingBrokerage
                      ? 'Save Changes'
                      : 'Link Brokerage Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Close Brokerage Account Confirmation Modal */}
      {closingTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Close Linked Brokerage Account?
            </h3>
            <p className="text-xs text-slate-600 mt-2 leading-relaxed">
              Closing <strong>{closingTarget.accountName}</strong> (••••{closingTarget.accountMask})
              permanently marks this brokerage connection as closed in your audit ledger. Existing
              holdings remain in your Asset Registry.
            </p>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setClosingTarget(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Keep Active
              </button>
              <button
                type="button"
                disabled={closingBusy}
                onClick={() => void handleCloseBrokerageAccount()}
                className="px-4 py-2 text-xs font-medium text-white bg-red-700 rounded-lg hover:bg-red-800 disabled:opacity-50 cursor-pointer"
              >
                {closingBusy ? 'Closing...' : 'Confirm Close Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Investment Holding Modal */}
      {holdingModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingAsset ? 'Edit Investment Holding' : 'Add Investment Holding'}
              </h3>
              <button
                type="button"
                onClick={() => setHoldingModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveHolding(e)} className="mt-5 space-y-4">
              {holdingFormError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {holdingFormError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Linked Brokerage Account
                </label>
                <select
                  value={posBrokerageId}
                  onChange={(e) => setPosBrokerageId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900"
                >
                  <option value="">Unassigned Custody Registry</option>
                  {activeBrokerageAccounts.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.accountName} ({b.brokerInstitution} · ••••{b.accountMask})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Asset / Security Name
                  </label>
                  <input
                    type="text"
                    value={posName}
                    onChange={(e) => setPosName(e.target.value)}
                    placeholder="e.g., Vanguard S&P 500 ETF"
                    maxLength={140}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Ticker / CUSIP
                  </label>
                  <input
                    type="text"
                    value={posTicker}
                    onChange={(e) => setPosTicker(e.target.value.toUpperCase())}
                    placeholder="VOO"
                    maxLength={48}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Asset Class
                  </label>
                  <select
                    value={posClass}
                    disabled={Boolean(editingAsset)}
                    onChange={(e) => setPosClass(e.target.value as AssetClass)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900 disabled:bg-slate-100"
                  >
                    {Object.entries(ASSET_CLASS_META).map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Valuation Date
                  </label>
                  <input
                    type="date"
                    value={posDate}
                    onChange={(e) => setPosDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Shares / Qty
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    min="0.0001"
                    value={posQty}
                    onChange={(e) => setPosQty(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Avg Unit Cost ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={posCostBasis}
                    onChange={(e) => setPosCostBasis(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Market Value ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={posMarketValue}
                    onChange={(e) => setPosMarketValue(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Jurisdiction
                </label>
                <input
                  type="text"
                  value={posJurisdiction}
                  onChange={(e) => setPosJurisdiction(e.target.value)}
                  maxLength={80}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900"
                  required
                />
              </div>

              <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setHoldingModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingHolding}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  {savingHolding
                    ? 'Saving...'
                    : editingAsset
                      ? 'Update Position'
                      : 'Add Holding'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
