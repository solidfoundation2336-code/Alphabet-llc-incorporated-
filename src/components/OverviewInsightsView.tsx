import { useMemo, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { AlertTriangle, Bell, BellOff, CheckCircle2, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  TRANSACTION_CATEGORIES,
  type AcquisitionArchitecture,
  type BankAccount,
  type BrokerageAccount,
  type Budget,
  type OnboardedAsset,
  type Transaction,
  type UserWorkspace,
} from '../types/finance';
import { formatCompactCurrency, formatCurrency } from '../utils/formatters';

interface OverviewInsightsViewProps {
  loading: boolean;
  workspace: UserWorkspace | null;
  accounts: BankAccount[];
  brokerageAccounts: BrokerageAccount[];
  transactions: Transaction[];
  budgets: Budget[];
  assets: OnboardedAsset[];
  acquisitionArchitectures: AcquisitionArchitecture[];
  onNavigateTab: (
    tab: 'portfolio' | 'ledger' | 'batch' | 'payments' | 'assets' | 'dtc' | 'brokerage' | 'architecture' | 'accounts',
  ) => void;
  onOpenAcquisitionWorkflow: () => void;
}

export function OverviewInsightsView({
  loading,
  workspace,
  accounts,
  brokerageAccounts,
  transactions,
  budgets,
  assets,
  acquisitionArchitectures,
  onNavigateTab,
  onOpenAcquisitionWorkflow,
}: OverviewInsightsViewProps) {
  const { user } = useAuth();
  const [hoveredMonth, setHoveredMonth] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const latest = transactions[0]?.occurredAt?.slice(0, 7);
    return latest || '2026-11';
  });
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [budgetCategory, setBudgetCategory] = useState<string>(TRANSACTION_CATEGORIES[0]);
  const [monthlyLimit, setMonthlyLimit] = useState('5000');
  const [warningPct, setWarningPct] = useState('80');
  const [criticalPct, setCriticalPct] = useState('100');
  const [savingBudget, setSavingBudget] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const availableMonths = useMemo(() => {
    const set = new Set<string>(['2026-11', '2026-10', '2026-09']);
    transactions.forEach((tx) => {
      if (tx.occurredAt && tx.occurredAt.length >= 7) {
        set.add(tx.occurredAt.slice(0, 7));
      }
    });
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [transactions]);

  const netCashPosition = useMemo(
    () => accounts.reduce((acc, a) => acc + (a.status !== 'closed' ? a.balance : 0), 0),
    [accounts],
  );

  const monthTransactions = useMemo(
    () => transactions.filter((tx) => tx.occurredAt.startsWith(selectedMonth)),
    [transactions, selectedMonth],
  );

  const mtdSpend = useMemo(
    () =>
      monthTransactions
        .filter((tx) => tx.direction === 'debit')
        .reduce((sum, tx) => sum + tx.amount, 0),
    [monthTransactions],
  );

  const mtdInflow = useMemo(
    () =>
      monthTransactions
        .filter((tx) => tx.direction === 'credit')
        .reduce((sum, tx) => sum + tx.amount, 0),
    [monthTransactions],
  );

  const recurringMonthlyBurn = useMemo(
    () =>
      monthTransactions
        .filter((tx) => tx.direction === 'debit' && tx.isRecurring)
        .reduce((sum, tx) => sum + tx.amount, 0),
    [monthTransactions],
  );

  const categorySpendMap = useMemo(() => {
    const map = new Map<string, number>();
    monthTransactions
      .filter((tx) => tx.direction === 'debit')
      .forEach((tx) => {
        map.set(tx.category, (map.get(tx.category) || 0) + tx.amount);
      });
    return map;
  }, [monthTransactions]);

  const budgetEvaluations = useMemo(() => {
    return budgets.map((b) => {
      const spent = categorySpendMap.get(b.category) || 0;
      const pct = b.monthlyLimit > 0 ? (spent / b.monthlyLimit) * 100 : 0;
      let severity: 'normal' | 'warning' | 'critical' = 'normal';
      if (b.alertsEnabled) {
        if (pct >= b.criticalThresholdPct) severity = 'critical';
        else if (pct >= b.warningThresholdPct) severity = 'warning';
      }
      return { budget: b, spent, pct, severity };
    });
  }, [budgets, categorySpendMap]);

  const activeAlerts = useMemo(
    () => budgetEvaluations.filter((item) => item.severity !== 'normal'),
    [budgetEvaluations],
  );

  const monthlySeries = useMemo(() => {
    const months = [...availableMonths].slice(0, 6).reverse();
    return months.map((m) => {
      const txs = transactions.filter((tx) => tx.occurredAt.startsWith(m));
      const inflow = txs
        .filter((t) => t.direction === 'credit')
        .reduce((sum, t) => sum + t.amount, 0);
      const outflow = txs
        .filter((t) => t.direction === 'debit')
        .reduce((sum, t) => sum + t.amount, 0);
      return { month: m, inflow, outflow, net: inflow - outflow };
    });
  }, [availableMonths, transactions]);

  const maxChartValue = useMemo(() => {
    const peak = monthlySeries.reduce(
      (max, item) => Math.max(max, item.inflow, item.outflow),
      10000,
    );
    return peak * 1.15;
  }, [monthlySeries]);

  const categoryBreakdown = useMemo(() => {
    const entries = Array.from(categorySpendMap.entries()).sort((a, b) => b[1] - a[1]);
    return entries.map(([category, amount]) => ({
      category,
      amount,
      share: mtdSpend > 0 ? (amount / mtdSpend) * 100 : 0,
    }));
  }, [categorySpendMap, mtdSpend]);

  const assetSummary = useMemo(() => {
    const active = assets.filter((a) => a.custodyStatus !== 'archived');
    let totalValue = 0;
    let totalCostBasis = 0;
    let publicSecurities = 0;
    let alternatives = 0;
    let realEstate = 0;
    let custodiedCount = 0;
    let pendingMfaCount = 0;

    active.forEach((a) => {
      totalValue += a.totalMarketValue;
      totalCostBasis += a.quantity * a.unitCostBasis;
      if (a.assetCategoryGroup === 'public_securities') publicSecurities += a.totalMarketValue;
      else if (a.assetCategoryGroup === 'alternatives') alternatives += a.totalMarketValue;
      else if (a.assetCategoryGroup === 'real_estate') realEstate += a.totalMarketValue;
      if (a.custodyStatus === 'custodied') custodiedCount += 1;
      if (a.custodyStatus === 'pending_verification') pendingMfaCount += 1;
    });

    const activeBrokerages = brokerageAccounts.filter((b) => b.status !== 'closed');
    const brokerageCash = activeBrokerages.reduce((s, b) => s + b.cashBalance, 0);
    const marginDebt = activeBrokerages.reduce((s, b) => s + b.marginDebt, 0);
    const netPortfolioValue = totalValue + brokerageCash - marginDebt;
    const unrealizedGain = totalValue - totalCostBasis;
    const unrealizedPct = totalCostBasis > 0 ? (unrealizedGain / totalCostBasis) * 100 : 0;
    const consolidatedNetWorth = netCashPosition + netPortfolioValue;

    return {
      activeCount: active.length,
      activeBrokerageCount: activeBrokerages.length,
      totalValue,
      totalCostBasis,
      brokerageCash,
      marginDebt,
      netPortfolioValue,
      unrealizedGain,
      unrealizedPct,
      consolidatedNetWorth,
      publicSecurities,
      alternatives,
      realEstate,
      custodiedCount,
      pendingMfaCount,
    };
  }, [assets, brokerageAccounts, netCashPosition]);

  const purchasesAccount = useMemo(
    () => accounts.find((a) => a.id === workspace?.purchasesAccountId) || null,
    [accounts, workspace?.purchasesAccountId],
  );

  const acquisitionSummary = useMemo(() => {
    const active = acquisitionArchitectures.filter(
      (a) => a.stage !== 'closed' && a.stage !== 'cancelled',
    );
    const closed = acquisitionArchitectures.filter((a) => a.stage === 'closed');
    const escrowFunded = acquisitionArchitectures.filter((a) => a.stage === 'escrow_funded');
    return {
      activeCount: active.length,
      escrowFundedCount: escrowFunded.length,
      closedCount: closed.length,
      committedCapital: active.reduce((s, a) => s + a.committedCapitalUsd, 0),
      targetValuation: active.reduce((s, a) => s + a.targetValuationUsd, 0),
    };
  }, [acquisitionArchitectures]);

  const openNewBudgetModal = () => {
    setEditingBudget(null);
    setBudgetCategory(TRANSACTION_CATEGORIES[0]);
    setMonthlyLimit('5000');
    setWarningPct('80');
    setCriticalPct('100');
    setFormError(null);
    setBudgetModalOpen(true);
  };

  const openEditBudgetModal = (budget: Budget) => {
    setEditingBudget(budget);
    setBudgetCategory(budget.category);
    setMonthlyLimit(String(budget.monthlyLimit));
    setWarningPct(String(budget.warningThresholdPct));
    setCriticalPct(String(budget.criticalThresholdPct));
    setFormError(null);
    setBudgetModalOpen(true);
  };

  const handleSaveBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setFormError(null);

    const limitVal = Number.parseFloat(monthlyLimit);
    const warnVal = Number.parseFloat(warningPct);
    const critVal = Number.parseFloat(criticalPct);

    if (!Number.isFinite(limitVal) || limitVal <= 0) {
      setFormError('Monthly limit must be greater than zero.');
      return;
    }
    if (!Number.isFinite(warnVal) || warnVal < 10 || warnVal > 100) {
      setFormError('Warning threshold must be between 10% and 100%.');
      return;
    }
    if (!Number.isFinite(critVal) || critVal < warnVal || critVal > 150) {
      setFormError('Critical threshold must be >= warning threshold and <= 150%.');
      return;
    }

    setSavingBudget(true);
    try {
      if (editingBudget) {
        await updateDoc(doc(db, 'budgets', editingBudget.id), {
          monthlyLimit: limitVal,
          warningThresholdPct: warnVal,
          criticalThresholdPct: critVal,
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'budgets'), {
          ownerId: user.uid,
          category: budgetCategory,
          monthlyLimit: limitVal,
          warningThresholdPct: warnVal,
          criticalThresholdPct: critVal,
          alertsEnabled: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setBudgetModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'budgets');
    } finally {
      setSavingBudget(false);
    }
  };

  const toggleBudgetAlert = async (budget: Budget) => {
    try {
      await updateDoc(doc(db, 'budgets', budget.id), {
        alertsEnabled: !budget.alertsEnabled,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `budgets/${budget.id}`);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="h-80 bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Period Selector & Summary Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 font-display">
            Real-Time Treasury &amp; Spending Insights
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Live cash positions across {accounts.length} linked accounts · {transactions.length}{' '}
            recorded ledger entries
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="insight-month-select" className="text-xs font-medium text-slate-600">
            Reporting Month
          </label>
          <select
            id="insight-month-select"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            {availableMonths.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 4-Column Consolidated Financial Health KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Consolidated Net Worth</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {formatCurrency(assetSummary.consolidatedNetWorth)}
          </p>
          <p className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
            Bank {formatCompactCurrency(netCashPosition)} + Portfolio{' '}
            {formatCompactCurrency(assetSummary.netPortfolioValue)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Investment Portfolio</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {formatCurrency(assetSummary.netPortfolioValue)}
          </p>
          <p
            className={`text-xs mt-2 font-mono tabular-nums font-medium ${
              assetSummary.unrealizedGain >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {assetSummary.unrealizedGain >= 0 ? '+' : ''}
            {formatCompactCurrency(assetSummary.unrealizedGain)} (
            {assetSummary.unrealizedPct >= 0 ? '+' : ''}
            {assetSummary.unrealizedPct.toFixed(1)}%) · {assetSummary.activeBrokerageCount} brokerages
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Monthly Spend ({selectedMonth})</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {formatCurrency(mtdSpend)}
          </p>
          <p className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
            Inflow {formatCurrency(mtdInflow)} · Recurring {formatCompactCurrency(recurringMonthlyBurn)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Personalized Budget Alerts</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {activeAlerts.length}
          </p>
          <p className="text-xs text-slate-500 mt-2">
            {activeAlerts.filter((a) => a.severity === 'critical').length} critical ·{' '}
            {activeAlerts.filter((a) => a.severity === 'warning').length} warning
          </p>
        </div>
      </section>

      {/* Main Analytics Split: Monthly Cash Flow Chart + Category Spend Breakdown */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <div>
              <h3 className="text-base font-semibold text-slate-900 font-display">
                Monthly Cash Flow Trajectory
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Credits vs debits across tracked calendar months
              </p>
            </div>
            <div className="flex items-center gap-5 text-xs text-slate-600">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-slate-900 inline-block" />
                Inflows
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-slate-400 inline-block" />
                Outflows
              </span>
            </div>
          </div>

          <div className="relative">
            {monthlySeries.length === 0 ? (
              <div className="h-56 flex items-center justify-center text-sm text-slate-500">
                No monthly series data recorded yet.
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-4 items-end h-56 pt-6 pb-2 border-b border-slate-200">
                {monthlySeries.map((pt) => {
                  const inflowH = Math.max(4, Math.round((pt.inflow / maxChartValue) * 165));
                  const outflowH = Math.max(4, Math.round((pt.outflow / maxChartValue) * 165));
                  const isHovered = hoveredMonth === pt.month;
                  return (
                    <div
                      key={pt.month}
                      onMouseEnter={() => setHoveredMonth(pt.month)}
                      onMouseLeave={() => setHoveredMonth(null)}
                      onClick={() => setSelectedMonth(pt.month)}
                      className={`flex flex-col items-center justify-end h-full cursor-pointer rounded-lg px-1.5 transition-colors ${
                        selectedMonth === pt.month ? 'bg-slate-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      {isHovered && (
                        <div className="mb-2 text-[11px] font-mono tabular-nums text-slate-700 text-center whitespace-nowrap">
                          {formatCompactCurrency(pt.inflow)} / {formatCompactCurrency(pt.outflow)}
                        </div>
                      )}
                      <div className="flex items-end gap-1.5 w-full justify-center">
                        <div
                          className="w-5 bg-slate-900 rounded-t transition-all duration-150"
                          style={{ height: `${inflowH}px` }}
                          title={`Inflow ${pt.month}: ${formatCurrency(pt.inflow)}`}
                        />
                        <div
                          className="w-5 bg-slate-400 rounded-t transition-all duration-150"
                          style={{ height: `${outflowH}px` }}
                          title={`Outflow ${pt.month}: ${formatCurrency(pt.outflow)}`}
                        />
                      </div>
                      <span className="text-xs font-mono text-slate-600 mt-2">{pt.month}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600">
            <span>
              Selected period net cash flow:{' '}
              <strong className="font-mono tabular-nums text-slate-900">
                {formatCurrency(mtdInflow - mtdSpend)}
              </strong>
            </span>
            <button
              type="button"
              onClick={() => onNavigateTab('ledger')}
              className="text-slate-900 font-medium hover:underline cursor-pointer"
            >
              Inspect full ledger
            </button>
          </div>
        </div>

        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Category Spend Share ({selectedMonth})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 mb-5">
              Distribution of settled and pending outflows
            </p>

            {categoryBreakdown.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-500">
                No debit transactions in {selectedMonth}.
              </div>
            ) : (
              <div className="space-y-4">
                {categoryBreakdown.map((row) => (
                  <div key={row.category}>
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="font-medium text-slate-800">{row.category}</span>
                      <span className="font-mono tabular-nums text-slate-600">
                        {formatCurrency(row.amount)} · {row.share.toFixed(1)}%
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-slate-800 rounded-full transition-all duration-200"
                        style={{ width: `${Math.min(100, Math.max(3, row.share))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-500">Uncategorized feeds?</span>
            <button
              type="button"
              onClick={() => onNavigateTab('batch')}
              className="font-medium text-slate-900 hover:underline cursor-pointer"
            >
              Run batch categorizer
            </button>
          </div>
        </div>
      </section>

      {/* Consolidated Portfolio & Asset Custody Summary */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Investment Portfolio &amp; Asset Allocation Summary
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {assetSummary.activeBrokerageCount} linked brokerages · {assetSummary.activeCount}{' '}
              positions · {assetSummary.custodiedCount} MFA custodied ·{' '}
              {formatCurrency(assetSummary.brokerageCash)} brokerage cash
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigateTab('assets')}
              className="px-4 py-2 text-xs font-medium text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Asset Onboarding
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('portfolio')}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Open Investment Portfolio
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-5">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-xs font-medium text-slate-500">Total Investment Holdings</p>
            <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
              {formatCurrency(assetSummary.totalValue)}
            </p>
          </div>
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-xs font-medium text-slate-500">Public Securities</p>
            <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
              {formatCurrency(assetSummary.publicSecurities)}
            </p>
          </div>
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-xs font-medium text-slate-500">Alternatives &amp; Commodities</p>
            <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
              {formatCurrency(assetSummary.alternatives)}
            </p>
          </div>
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-xs font-medium text-slate-500">Real Estate &amp; REITs</p>
            <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
              {formatCurrency(assetSummary.realEstate)}
            </p>
          </div>
        </div>
      </section>

      {/* Acquisition Workflow & Purchases Account Summary */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Acquisition Workflow &amp; Purchases Treasury Coverage
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {acquisitionSummary.activeCount} active pipelines ·{' '}
              {acquisitionSummary.escrowFundedCount} escrow funded ·{' '}
              {acquisitionSummary.closedCount} closed
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenAcquisitionWorkflow}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Open Acquisition Workflow
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-5">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-xs font-medium text-slate-500">Account for Purchases</p>
            <p className="text-sm font-semibold text-slate-900 mt-1.5 truncate">
              {purchasesAccount
                ? `${purchasesAccount.accountName} (····${purchasesAccount.accountMask})`
                : 'Not Designated'}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5 capitalize">
              {purchasesAccount ? `${purchasesAccount.institutionName} · ${purchasesAccount.accountType}` : 'Set under Acquisition Architecture'}
            </p>
          </div>
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-xs font-medium text-slate-500">Purchases Liquidity</p>
            <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
              {formatCurrency(purchasesAccount?.balance ?? 0)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">Available for escrow funding</p>
          </div>
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-xs font-medium text-slate-500">Committed Acquisition Capital</p>
            <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
              {formatCompactCurrency(acquisitionSummary.committedCapital)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
              Target EV {formatCompactCurrency(acquisitionSummary.targetValuation)}
            </p>
          </div>
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-xs font-medium text-slate-500">Coverage Status</p>
            <p
              className={`text-lg font-semibold font-mono tabular-nums mt-1.5 ${
                (purchasesAccount?.balance ?? 0) >= acquisitionSummary.committedCapital
                  ? 'text-emerald-700'
                  : 'text-amber-700'
              }`}
            >
              {acquisitionSummary.committedCapital > 0
                ? `${Math.min(
                    999,
                    Math.round(
                      ((purchasesAccount?.balance ?? 0) / acquisitionSummary.committedCapital) * 100,
                    ),
                  )}% Covered`
                : '100% Ready'}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">MFA &amp; diligence enforced</p>
          </div>
        </div>
      </section>

      {/* Personalized Budget Thresholds & Real-Time Alerts */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Personalized Budget Controls &amp; Threshold Alerts
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Evaluated dynamically against {selectedMonth} category spending
            </p>
          </div>
          <button
            type="button"
            onClick={openNewBudgetModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Category Budget</span>
          </button>
        </div>

        {budgetEvaluations.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm text-slate-600 mb-4">
              No monthly category budgets configured yet.
            </p>
            <button
              type="button"
              onClick={openNewBudgetModal}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
            >
              Create First Budget
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {budgetEvaluations.map(({ budget, spent, pct, severity }) => (
              <div
                key={budget.id}
                className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="min-w-0 lg:w-64">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900 truncate">
                      {budget.category}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                    Warn {budget.warningThresholdPct}% · Critical {budget.criticalThresholdPct}%
                  </p>
                </div>

                <div className="flex-1 max-w-xl">
                  <div className="flex items-center justify-between text-xs mb-1.5 font-mono tabular-nums">
                    <span className="text-slate-700">
                      {formatCurrency(spent)} of {formatCurrency(budget.monthlyLimit)}
                    </span>
                    <span className="text-slate-600">{pct.toFixed(1)}%</span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-200 ${
                        severity === 'critical'
                          ? 'bg-red-600'
                          : severity === 'warning'
                            ? 'bg-amber-500'
                            : 'bg-emerald-600'
                      }`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between lg:justify-end gap-4 shrink-0">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${
                      severity === 'critical'
                        ? 'text-red-700'
                        : severity === 'warning'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                    }`}
                  >
                    {severity === 'critical' ? (
                      <>
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>Critical · Over Threshold</span>
                      </>
                    ) : severity === 'warning' ? (
                      <>
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>Warning · Approaching Limit</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Normal · On Track</span>
                      </>
                    )}
                  </span>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggleBudgetAlert(budget)}
                      className="p-2 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg cursor-pointer"
                      title={budget.alertsEnabled ? 'Mute alerts' : 'Enable alerts'}
                      aria-label={budget.alertsEnabled ? 'Mute alerts' : 'Enable alerts'}
                    >
                      {budget.alertsEnabled ? (
                        <Bell className="w-3.5 h-3.5" />
                      ) : (
                        <BellOff className="w-3.5 h-3.5 text-slate-400" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditBudgetModal(budget)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      <span>Adjust</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Budget Modal */}
      {budgetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingBudget ? 'Adjust Category Budget' : 'New Category Budget'}
              </h3>
              <button
                type="button"
                onClick={() => setBudgetModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveBudget(e)} className="mt-5 space-y-4">
              {formError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {formError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                <select
                  value={budgetCategory}
                  disabled={Boolean(editingBudget)}
                  onChange={(e) => setBudgetCategory(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900 disabled:bg-slate-100"
                >
                  {TRANSACTION_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Monthly Limit (USD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  value={monthlyLimit}
                  onChange={(e) => setMonthlyLimit(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Warning Alert (%)
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="100"
                    value={warningPct}
                    onChange={(e) => setWarningPct(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Critical Alert (%)
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="150"
                    value={criticalPct}
                    onChange={(e) => setCriticalPct(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg text-slate-900"
                    required
                  />
                </div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setBudgetModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBudget}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  {savingBudget ? 'Saving...' : 'Save Budget'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
