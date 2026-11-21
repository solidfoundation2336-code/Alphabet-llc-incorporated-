import { useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { ArrowRightLeft, Download, Pencil, Plus, Repeat, Search, Send, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  TRANSACTION_CATEGORIES,
  type BankAccount,
  type BankAccountStatus,
  type BankAccountType,
  type BrokerageAccount,
  type RecurrenceCadence,
  type Transaction,
  type TransactionDirection,
  type TransactionStatus,
} from '../types/finance';
import { csvEscape, downloadTextFile, formatCurrency } from '../utils/formatters';
import { FundTransfersModal } from './FundTransfersModal';

interface LedgerViewProps {
  accounts: BankAccount[];
  brokerageAccounts?: BrokerageAccount[];
  transactions: Transaction[];
  purchasesAccountId?: string;
  openTxModalTrigger: number;
}

export function LedgerView({
  accounts,
  brokerageAccounts = [],
  transactions,
  purchasesAccountId,
  openTxModalTrigger,
}: LedgerViewProps) {
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [directionFilter, setDirectionFilter] = useState<'all' | TransactionDirection>('all');
  const [recurringOnly, setRecurringOnly] = useState(false);

  // Add / Edit Bank Account modal
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<BankAccount | null>(null);
  const [accName, setAccName] = useState('');
  const [accInstitution, setAccInstitution] = useState('');
  const [accType, setAccType] = useState<BankAccountType>('checking');
  const [accMask, setAccMask] = useState('');
  const [accBalance, setAccBalance] = useState('25000');
  const [accStatus, setAccStatus] = useState<BankAccountStatus>('active');
  const [savingAccount, setSavingAccount] = useState(false);
  const [accError, setAccError] = useState<string | null>(null);

  // Log Transaction modal
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [lastTrigger, setLastTrigger] = useState(openTxModalTrigger);
  const [txAccountId, setTxAccountId] = useState(accounts[0]?.id || '');
  const [txMerchant, setTxMerchant] = useState('');
  const [txDescription, setTxDescription] = useState('');
  const [txAmount, setTxAmount] = useState('');
  const [txDirection, setTxDirection] = useState<TransactionDirection>('debit');
  const [txCategory, setTxCategory] = useState<string>(TRANSACTION_CATEGORIES[0]);
  const [txRecurring, setTxRecurring] = useState(false);
  const [txCadence, setTxCadence] = useState<RecurrenceCadence>('none');
  const [txDate, setTxDate] = useState('2026-11-18');
  const [savingTx, setSavingTx] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  // Tri-Core Consolidated Sweep modal (DTC + Operating + Treasury)
  const [sweepModalOpen, setSweepModalOpen] = useState(false);
  const [dtcTargetId, setDtcTargetId] = useState('');
  const [operatingTargetId, setOperatingTargetId] = useState('');
  const [treasuryTargetId, setTreasuryTargetId] = useState('');
  const [dtcPct, setDtcPct] = useState('33.34');
  const [operatingPct, setOperatingPct] = useState('33.33');
  const [treasuryPct, setTreasuryPct] = useState('33.33');
  const [includeBrokerageCash, setIncludeBrokerageCash] = useState(false);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepError, setSweepError] = useState<string | null>(null);
  const [sweepBanner, setSweepBanner] = useState<string | null>(null);
  const [transferModalOpen, setTransferModalOpen] = useState(false);

  if (openTxModalTrigger !== lastTrigger) {
    setLastTrigger(openTxModalTrigger);
    setTxAccountId(accounts[0]?.id || '');
    setTxError(null);
    setTxModalOpen(true);
  }

  const activeBankAccounts = useMemo(
    () => accounts.filter((a) => a.status !== 'closed'),
    [accounts],
  );

  const openSweepModal = () => {
    const dtcMatch =
      activeBankAccounts.find(
        (a) =>
          a.accountType === 'settlement' ||
          a.accountName.toLowerCase().includes('dtc'),
      ) || activeBankAccounts[0];
    const opMatch =
      activeBankAccounts.find(
        (a) =>
          a.id !== dtcMatch?.id &&
          (a.accountType === 'checking' ||
            a.accountName.toLowerCase().includes('operating')),
      ) || activeBankAccounts.find((a) => a.id !== dtcMatch?.id) || dtcMatch;
    const treasMatch =
      activeBankAccounts.find(
        (a) =>
          a.id !== dtcMatch?.id &&
          a.id !== opMatch?.id &&
          (a.accountType === 'treasury' ||
            a.accountName.toLowerCase().includes('treasury')),
      ) ||
      activeBankAccounts.find((a) => a.id !== dtcMatch?.id && a.id !== opMatch?.id) ||
      opMatch;

    setDtcTargetId(dtcMatch?.id || '');
    setOperatingTargetId(opMatch?.id || '');
    setTreasuryTargetId(treasMatch?.id || '');
    setDtcPct('33.34');
    setOperatingPct('33.33');
    setTreasuryPct('33.33');
    setIncludeBrokerageCash(false);
    setSweepError(null);
    setSweepModalOpen(true);
  };

  const sweepPlan = useMemo(() => {
    const targetIds = new Set([dtcTargetId, operatingTargetId, treasuryTargetId].filter(Boolean));
    const sourceBankAccounts = activeBankAccounts.filter(
      (a) => !targetIds.has(a.id) && a.balance > 0,
    );
    const sourceBrokerages = includeBrokerageCash
      ? brokerageAccounts.filter((b) => b.status !== 'closed' && b.cashBalance > 0)
      : [];

    const bankSweepTotal = sourceBankAccounts.reduce((s, a) => s + a.balance, 0);
    const brokerageSweepTotal = sourceBrokerages.reduce((s, b) => s + b.cashBalance, 0);
    const totalToSweep = Math.round((bankSweepTotal + brokerageSweepTotal) * 100) / 100;

    const pDtc = Number.parseFloat(dtcPct) || 0;
    const pOp = Number.parseFloat(operatingPct) || 0;
    const pTreas = Number.parseFloat(treasuryPct) || 0;
    const pctSum = Math.round((pDtc + pOp + pTreas) * 100) / 100;

    const dtcShare = Math.round(totalToSweep * (pDtc / 100) * 100) / 100;
    const opShare = Math.round(totalToSweep * (pOp / 100) * 100) / 100;
    const treasShare = Math.max(
      0,
      Math.round((totalToSweep - dtcShare - opShare) * 100) / 100,
    );

    return {
      sourceBankAccounts,
      sourceBrokerages,
      bankSweepTotal,
      brokerageSweepTotal,
      totalToSweep,
      pctSum,
      dtcShare,
      opShare,
      treasShare,
    };
  }, [
    activeBankAccounts,
    brokerageAccounts,
    dtcTargetId,
    operatingTargetId,
    treasuryTargetId,
    dtcPct,
    operatingPct,
    treasuryPct,
    includeBrokerageCash,
  ]);

  const accountLookup = useMemo(() => {
    const map = new Map<string, BankAccount>();
    accounts.forEach((a) => map.set(a.id, a));
    return map;
  }, [accounts]);

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (selectedAccountId !== 'all' && tx.accountId !== selectedAccountId) return false;
      if (selectedCategory !== 'all' && tx.category !== selectedCategory) return false;
      if (directionFilter !== 'all' && tx.direction !== directionFilter) return false;
      if (recurringOnly && !tx.isRecurring) return false;
      if (q) {
        const hay = `${tx.merchant} ${tx.description} ${tx.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    transactions,
    selectedAccountId,
    selectedCategory,
    directionFilter,
    recurringOnly,
    searchQuery,
  ]);

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setAccError(null);

    if (editingAccount) {
      if (accName.trim().length < 2) {
        setAccError('Account nickname must be at least 2 characters.');
        return;
      }
      setSavingAccount(true);
      try {
        await updateDoc(doc(db, 'bank_accounts', editingAccount.id), {
          accountName: accName.trim(),
          status: accStatus,
          updatedAt: serverTimestamp(),
        });
        setEditingAccount(null);
        setAccountModalOpen(false);
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `bank_accounts/${editingAccount.id}`);
      } finally {
        setSavingAccount(false);
      }
      return;
    }

    if (!/^[0-9]{4}$/.test(accMask)) {
      setAccError('Account mask must be exactly 4 digits.');
      return;
    }
    const bal = Number.parseFloat(accBalance);
    if (!Number.isFinite(bal)) {
      setAccError('Enter a valid starting balance.');
      return;
    }

    setSavingAccount(true);
    try {
      await addDoc(collection(db, 'bank_accounts'), {
        ownerId: user.uid,
        accountName: accName.trim(),
        institutionName: accInstitution.trim(),
        accountType: accType,
        accountMask: accMask,
        currency: 'USD',
        balance: Math.round(bal * 100) / 100,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setAccName('');
      setAccInstitution('');
      setAccMask('');
      setAccountModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'bank_accounts');
    } finally {
      setSavingAccount(false);
    }
  };

  const handleCreateTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setTxError(null);

    const targetAccountId = txAccountId || accounts[0]?.id;
    const targetAccount = targetAccountId ? accountLookup.get(targetAccountId) : undefined;
    if (!targetAccount) {
      setTxError('Select a linked bank account first.');
      return;
    }

    const parsedAmount = Number.parseFloat(txAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setTxError('Transaction amount must be positive.');
      return;
    }

    setSavingTx(true);
    try {
      const batch = writeBatch(db);
      const txRef = doc(collection(db, 'transactions'));
      const amountRounded = Math.round(parsedAmount * 100) / 100;
      const newBalance =
        txDirection === 'credit'
          ? Math.round((targetAccount.balance + amountRounded) * 100) / 100
          : Math.round((targetAccount.balance - amountRounded) * 100) / 100;

      batch.set(txRef, {
        ownerId: user.uid,
        accountId: targetAccount.id,
        merchant: txMerchant.trim(),
        description: txDescription.trim() || `${txMerchant.trim()} ledger entry`,
        amount: amountRounded,
        direction: txDirection,
        category: txCategory,
        isRecurring: txRecurring,
        recurrenceCadence: txRecurring ? (txCadence === 'none' ? 'monthly' : txCadence) : 'none',
        batchId: '',
        status: 'posted',
        occurredAt: txDate,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.update(doc(db, 'bank_accounts', targetAccount.id), {
        balance: newBalance,
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
      setTxMerchant('');
      setTxDescription('');
      setTxAmount('');
      setTxModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'transactions');
    } finally {
      setSavingTx(false);
    }
  };

  const handleCategoryChange = async (tx: Transaction, nextCategory: string) => {
    try {
      await updateDoc(doc(db, 'transactions', tx.id), {
        category: nextCategory,
        isRecurring: tx.isRecurring,
        recurrenceCadence: tx.recurrenceCadence,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `transactions/${tx.id}`);
    }
  };

  const handleToggleRecurring = async (tx: Transaction) => {
    const nextRecurring = !tx.isRecurring;
    try {
      await updateDoc(doc(db, 'transactions', tx.id), {
        category: tx.category,
        isRecurring: nextRecurring,
        recurrenceCadence: nextRecurring ? 'monthly' : 'none',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `transactions/${tx.id}`);
    }
  };

  const handleStatusChange = async (tx: Transaction, nextStatus: TransactionStatus) => {
    try {
      await updateDoc(doc(db, 'transactions', tx.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `transactions/${tx.id}`);
    }
  };

  const handleExecuteConsolidatedSweep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSweepError(null);

    if (!dtcTargetId || !operatingTargetId || !treasuryTargetId) {
      setSweepError('Select all three destination accounts (DTC, Operating, and Treasury).');
      return;
    }
    if (
      dtcTargetId === operatingTargetId ||
      dtcTargetId === treasuryTargetId ||
      operatingTargetId === treasuryTargetId
    ) {
      setSweepError('DTC, Operating, and Treasury must be three distinct accounts.');
      return;
    }
    if (Math.abs(sweepPlan.pctSum - 100) > 0.05) {
      setSweepError('Allocation percentages must total 100%.');
      return;
    }
    if (sweepPlan.totalToSweep <= 0) {
      setSweepError('No positive balances remain outside your three main accounts to sweep.');
      return;
    }

    const allocations = [
      { id: dtcTargetId, amount: sweepPlan.dtcShare, label: 'DTC Clearing' },
      { id: operatingTargetId, amount: sweepPlan.opShare, label: 'Operating' },
      { id: treasuryTargetId, amount: sweepPlan.treasShare, label: 'Treasury' },
    ];

    for (const target of allocations) {
      const acc = accountLookup.get(target.id);
      if (!acc) {
        setSweepError(`Destination account ${target.label} was not found.`);
        return;
      }
      if (acc.balance + target.amount > 1000000000) {
        setSweepError(
          `${acc.accountName} balance would exceed the $1,000,000,000 single-account ledger limit.`,
        );
        return;
      }
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const nowStamp = new Date().toISOString().slice(0, 19) + 'Z';
    setSweepBusy(true);
    try {
      const batch = writeBatch(db);

      // 1. Zero out swept source bank accounts and log debit entries
      for (const src of sweepPlan.sourceBankAccounts) {
        const amt = Math.round(src.balance * 100) / 100;
        batch.update(doc(db, 'bank_accounts', src.id), {
          balance: 0,
          updatedAt: serverTimestamp(),
        });

        let remaining = amt;
        while (remaining > 0.001) {
          const chunk = Math.min(remaining, 100000000);
          batch.set(doc(collection(db, 'transactions')), {
            ownerId: user.uid,
            accountId: src.id,
            merchant: 'Tri-Core Treasury Sweep',
            description: 'Consolidated balance transfer to DTC, Operating & Treasury',
            amount: Math.round(chunk * 100) / 100,
            direction: 'debit',
            category: 'Settlement & Clearing',
            isRecurring: false,
            recurrenceCadence: 'none',
            batchId: '',
            status: 'posted',
            occurredAt: todayIso,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          remaining = Math.round((remaining - chunk) * 100) / 100;
        }
      }

      // 2. Optionally zero out uninvested brokerage cash balances
      for (const brk of sweepPlan.sourceBrokerages) {
        batch.update(doc(db, 'brokerage_accounts', brk.id), {
          syncStatus: brk.connectionMode === 'api_sync' ? 'synced' : brk.syncStatus,
          lastSyncedAt: nowStamp,
          cashBalance: 0,
          marginDebt: brk.marginDebt,
          status: brk.status,
          updatedAt: serverTimestamp(),
        });
      }

      // 3. Credit the 3 main destination accounts atomically
      for (const target of allocations) {
        if (target.amount <= 0) continue;
        const acc = accountLookup.get(target.id)!;
        const nextBalance = Math.round((acc.balance + target.amount) * 100) / 100;
        batch.update(doc(db, 'bank_accounts', acc.id), {
          balance: nextBalance,
          updatedAt: serverTimestamp(),
        });

        let remaining = target.amount;
        while (remaining > 0.001) {
          const chunk = Math.min(remaining, 100000000);
          batch.set(doc(collection(db, 'transactions')), {
            ownerId: user.uid,
            accountId: acc.id,
            merchant: 'Consolidated Treasury Sweep',
            description: `Inbound fund consolidation to ${target.label} account`,
            amount: Math.round(chunk * 100) / 100,
            direction: 'credit',
            category: 'Settlement & Clearing',
            isRecurring: false,
            recurrenceCadence: 'none',
            batchId: '',
            status: 'posted',
            occurredAt: todayIso,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          remaining = Math.round((remaining - chunk) * 100) / 100;
        }
      }

      await batch.commit();
      setSweepBanner(
        `Consolidated ${formatCurrency(sweepPlan.totalToSweep)} into DTC (${formatCurrency(sweepPlan.dtcShare)}), Operating (${formatCurrency(sweepPlan.opShare)}), and Treasury (${formatCurrency(sweepPlan.treasShare)}).`,
      );
      setSweepModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'bank_accounts/consolidated_sweep');
    } finally {
      setSweepBusy(false);
    }
  };

  const handleExportCsv = () => {
    const header = [
      'Date',
      'Account',
      'Merchant',
      'Description',
      'Category',
      'Direction',
      'Amount',
      'Recurring',
      'Cadence',
      'Status',
    ].join(',');
    const lines = filteredTransactions.map((tx) => {
      const acc = accountLookup.get(tx.accountId);
      return [
        csvEscape(tx.occurredAt),
        csvEscape(acc ? `${acc.accountName} (•••• ${acc.accountMask})` : tx.accountId),
        csvEscape(tx.merchant),
        csvEscape(tx.description),
        csvEscape(tx.category),
        csvEscape(tx.direction),
        csvEscape(tx.amount.toFixed(2)),
        csvEscape(tx.isRecurring),
        csvEscape(tx.recurrenceCadence),
        csvEscape(tx.status),
      ].join(',');
    });
    downloadTextFile('veridian-ledger-transactions.csv', [header, ...lines].join('\n'));
  };

  return (
    <div className="space-y-8">
      {/* Linked Bank Accounts Strip */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900 font-display">
              Linked Bank &amp; Custody Accounts
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Real-time account balances updated atomically with ledger activity
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setTransferModalOpen(true)}
              disabled={accounts.filter((a) => a.status === 'active').length < 2}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Fund Transfers</span>
            </button>
            <button
              type="button"
              onClick={openSweepModal}
              disabled={activeBankAccounts.length < 3}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              <span>Consolidate to Main 3</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingAccount(null);
                setAccName('');
                setAccInstitution('');
                setAccMask('');
                setAccBalance('25000');
                setAccStatus('active');
                setAccError(null);
                setAccountModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Link Account</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setTxAccountId(accounts[0]?.id || '');
                setTxError(null);
                setTxModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Record Entry</span>
            </button>
          </div>
        </div>

        {sweepBanner && (
          <div className="flex items-center justify-between gap-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800">
            <span>{sweepBanner}</span>
            <button
              type="button"
              onClick={() => setSweepBanner(null)}
              className="text-emerald-700 hover:text-emerald-900 cursor-pointer"
              aria-label="Dismiss sweep confirmation"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {accounts.map((acc) => {
            const isPurchases = acc.id === purchasesAccountId;
            return (
              <div
                key={acc.id}
                onClick={() =>
                  setSelectedAccountId((prev) => (prev === acc.id ? 'all' : acc.id))
                }
                className={`text-left p-5 rounded-xl border transition-colors cursor-pointer ${
                  selectedAccountId === acc.id
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-900 border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className={selectedAccountId === acc.id ? 'text-slate-300' : 'text-slate-500'}>
                    {acc.institutionName} · •••• {acc.accountMask}
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      className={`capitalize ${
                        selectedAccountId === acc.id ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {acc.accountType} · {acc.status}
                    </span>
                    <button
                      type="button"
                      aria-label={`Edit ${acc.accountName}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingAccount(acc);
                        setAccName(acc.accountName);
                        setAccInstitution(acc.institutionName);
                        setAccType(acc.accountType);
                        setAccMask(acc.accountMask);
                        setAccBalance(String(acc.balance));
                        setAccStatus(acc.status);
                        setAccError(null);
                        setAccountModalOpen(true);
                      }}
                      className={`p-1 rounded hover:bg-slate-200/30 cursor-pointer ${
                        selectedAccountId === acc.id ? 'text-slate-200' : 'text-slate-500'
                      }`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium truncate">{acc.accountName}</p>
                  {isPurchases && (
                    <span
                      className={`text-[10px] font-mono uppercase tracking-wider shrink-0 ${
                        selectedAccountId === acc.id ? 'text-emerald-300' : 'text-emerald-700'
                      }`}
                    >
                      PURCHASES ACCOUNT
                    </span>
                  )}
                </div>
                <p className="text-2xl font-semibold font-mono tabular-nums mt-2">
                  {formatCurrency(acc.balance, acc.currency)}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Transaction Filter Toolbar & High-Density Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[260px]">
            <div className="relative flex-1 max-w-xs min-w-[200px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search merchant or memo..."
                className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-700"
            >
              <option value="all">All Categories</option>
              {TRANSACTION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['all', 'debit', 'credit'] as const).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setDirectionFilter(dir)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer capitalize ${
                    directionFilter === dir
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {dir === 'all' ? 'All' : dir === 'debit' ? 'Debits' : 'Credits'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setRecurringOnly((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border cursor-pointer whitespace-nowrap ${
                recurringOnly
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Repeat className="w-3.5 h-3.5" />
              <span>Recurring Only</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Counterparty &amp; Memo</th>
                <th className="py-3 px-4">Account</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Cadence</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredTransactions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-sm text-slate-500">
                    No matching transactions found for the active filter criteria.
                  </td>
                </tr>
              ) : (
                filteredTransactions.map((tx) => {
                  const acc = accountLookup.get(tx.accountId);
                  return (
                    <tr key={tx.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {tx.occurredAt}
                      </td>
                      <td className="py-3 px-4 min-w-[220px]">
                        <p className="font-medium text-slate-900">{tx.merchant}</p>
                        <p className="text-xs text-slate-500 truncate max-w-xs">{tx.description}</p>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {acc ? `${acc.accountName} · •••• ${acc.accountMask}` : tx.accountId}
                      </td>
                      <td className="py-3 px-4">
                        <select
                          aria-label={`Category for ${tx.merchant}`}
                          value={tx.category}
                          onChange={(e) => void handleCategoryChange(tx, e.target.value)}
                          className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-800"
                        >
                          {TRANSACTION_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void handleToggleRecurring(tx)}
                          className={`inline-flex items-center gap-1 text-xs cursor-pointer ${
                            tx.isRecurring ? 'text-slate-900 font-medium' : 'text-slate-400'
                          }`}
                        >
                          <Repeat className="w-3.5 h-3.5" />
                          <span className="capitalize">
                            {tx.isRecurring ? tx.recurrenceCadence : 'One-time'}
                          </span>
                        </button>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <select
                          aria-label={`Status for ${tx.merchant}`}
                          value={tx.status}
                          onChange={(e) =>
                            void handleStatusChange(tx, e.target.value as TransactionStatus)
                          }
                          className={`text-xs border border-slate-200 rounded-md px-2 py-1 bg-white ${
                            tx.status === 'flagged'
                              ? 'text-red-700 font-medium'
                              : tx.status === 'pending'
                                ? 'text-amber-700'
                                : 'text-slate-700'
                          }`}
                        >
                          <option value="posted">Posted</option>
                          <option value="pending">Pending</option>
                          <option value="flagged">Flagged</option>
                        </select>
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-mono tabular-nums font-medium whitespace-nowrap ${
                          tx.direction === 'credit' ? 'text-emerald-700' : 'text-slate-900'
                        }`}
                      >
                        {tx.direction === 'credit' ? '+' : '-'}
                        {formatCurrency(tx.amount)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Link / Edit Bank Account Modal */}
      {accountModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingAccount ? 'Update Bank Account' : 'Link Bank or Custody Account'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setEditingAccount(null);
                  setAccountModalOpen(false);
                }}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveAccount(e)} className="mt-5 space-y-4">
              {accError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {accError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Account Nickname
                </label>
                <input
                  type="text"
                  value={accName}
                  onChange={(e) => setAccName(e.target.value)}
                  placeholder="Reserve Liquidity Account"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>
              {editingAccount ? (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Account Status
                  </label>
                  <select
                    value={accStatus}
                    onChange={(e) => setAccStatus(e.target.value as BankAccountStatus)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="active">Active</option>
                    <option value="frozen">Frozen</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Institution Name
                    </label>
                    <input
                      type="text"
                      value={accInstitution}
                      onChange={(e) => setAccInstitution(e.target.value)}
                      placeholder="Bank of New York Mellon"
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Account Type
                      </label>
                      <select
                        value={accType}
                        onChange={(e) => setAccType(e.target.value as BankAccountType)}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                      >
                        <option value="checking">Checking</option>
                        <option value="savings">Savings</option>
                        <option value="treasury">Treasury</option>
                        <option value="settlement">Settlement</option>
                        <option value="purchases">Purchases</option>
                        <option value="company">Company</option>
                        <option value="public">Public</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Last 4 Digits
                      </label>
                      <input
                        type="text"
                        maxLength={4}
                        value={accMask}
                        onChange={(e) => setAccMask(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="8142"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Opening Balance (USD)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={accBalance}
                      onChange={(e) => setAccBalance(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                      required
                    />
                  </div>
                </>
              )}
              <div className="pt-3 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditingAccount(null);
                    setAccountModalOpen(false);
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAccount}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingAccount
                    ? 'Saving...'
                    : editingAccount
                      ? 'Save Changes'
                      : 'Link Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Log Transaction Modal */}
      {txModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                Record Real-Time Transaction
              </h3>
              <button
                type="button"
                onClick={() => setTxModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleCreateTransaction(e)} className="mt-5 space-y-4">
              {txError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {txError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Account</label>
                <select
                  value={txAccountId || accounts[0]?.id || ''}
                  onChange={(e) => setTxAccountId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  required
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.accountName} (•••• {a.accountMask})
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Merchant / Counterparty
                  </label>
                  <input
                    type="text"
                    value={txMerchant}
                    onChange={(e) => setTxMerchant(e.target.value)}
                    placeholder="Datadog Enterprise"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
                  <input
                    type="date"
                    value={txDate}
                    onChange={(e) => setTxDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={txDescription}
                  onChange={(e) => setTxDescription(e.target.value)}
                  placeholder="Monthly APM observability & log retention"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Amount (USD)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={txAmount}
                    onChange={(e) => setTxAmount(e.target.value)}
                    placeholder="740.00"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Direction</label>
                  <select
                    value={txDirection}
                    onChange={(e) => setTxDirection(e.target.value as TransactionDirection)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="debit">Debit (Outflow)</option>
                    <option value="credit">Credit (Inflow)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                <select
                  value={txCategory}
                  onChange={(e) => setTxCategory(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {TRANSACTION_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-4 pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={txRecurring}
                    onChange={(e) => {
                      setTxRecurring(e.target.checked);
                      setTxCadence(e.target.checked ? 'monthly' : 'none');
                    }}
                  />
                  <span>Recurring commitment</span>
                </label>
                {txRecurring && (
                  <select
                    value={txCadence}
                    onChange={(e) => setTxCadence(e.target.value as RecurrenceCadence)}
                    className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annual">Annual</option>
                  </select>
                )}
              </div>
              <div className="pt-3 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setTxModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTx}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingTx ? 'Posting...' : 'Post to Ledger'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Tri-Core Consolidated Sweep Modal */}
      {sweepModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="text-base font-semibold text-slate-900 font-display">
                  Consolidate All Funds to Main 3 Accounts
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Atomically sweep balances from all other ledger accounts into DTC, Operating, and
                  Treasury
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSweepModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleExecuteConsolidatedSweep(e)} className="mt-5 space-y-4">
              {sweepError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {sweepError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    1. DTC Account
                  </label>
                  <select
                    value={dtcTargetId}
                    onChange={(e) => setDtcTargetId(e.target.value)}
                    className="w-full px-2.5 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
                  >
                    {activeBankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountName} (····{a.accountMask})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    2. Operating Account
                  </label>
                  <select
                    value={operatingTargetId}
                    onChange={(e) => setOperatingTargetId(e.target.value)}
                    className="w-full px-2.5 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
                  >
                    {activeBankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountName} (····{a.accountMask})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    3. Treasury Account
                  </label>
                  <select
                    value={treasuryTargetId}
                    onChange={(e) => setTreasuryTargetId(e.target.value)}
                    className="w-full px-2.5 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
                  >
                    {activeBankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountName} (····{a.accountMask})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                  <span className="text-xs font-medium text-slate-700">
                    Destination Allocation Split (Total: {sweepPlan.pctSum.toFixed(2)}%)
                  </span>
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => {
                        setDtcPct('33.34');
                        setOperatingPct('33.33');
                        setTreasuryPct('33.33');
                      }}
                      className="px-2 py-0.5 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                    >
                      Equal 3-Way
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDtcPct('20');
                        setOperatingPct('20');
                        setTreasuryPct('60');
                      }}
                      className="px-2 py-0.5 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                    >
                      Treasury 60%
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDtcPct('50');
                        setOperatingPct('25');
                        setTreasuryPct('25');
                      }}
                      className="px-2 py-0.5 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                    >
                      DTC 50%
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={dtcPct}
                    onChange={(e) => setDtcPct(e.target.value)}
                    aria-label="DTC percentage"
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-200 rounded-lg"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={operatingPct}
                    onChange={(e) => setOperatingPct(e.target.value)}
                    aria-label="Operating percentage"
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-200 rounded-lg"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={treasuryPct}
                    onChange={(e) => setTreasuryPct(e.target.value)}
                    aria-label="Treasury percentage"
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              {brokerageAccounts.some((b) => b.status !== 'closed' && b.cashBalance > 0) && (
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={includeBrokerageCash}
                    onChange={(e) => setIncludeBrokerageCash(e.target.checked)}
                  />
                  <span>
                    Also sweep uninvested cash from linked Brokerage Accounts (
                    {formatCurrency(
                      brokerageAccounts
                        .filter((b) => b.status !== 'closed')
                        .reduce((s, b) => s + b.cashBalance, 0),
                    )}
                    )
                  </span>
                </label>
              )}

              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                <div className="flex items-center justify-between font-medium text-slate-900">
                  <span>
                    Source Accounts to Sweep ({sweepPlan.sourceBankAccounts.length} bank
                    {sweepPlan.sourceBrokerages.length > 0
                      ? ` + ${sweepPlan.sourceBrokerages.length} brokerage`
                      : ''}
                    )
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatCurrency(sweepPlan.totalToSweep)}
                  </span>
                </div>
                {sweepPlan.sourceBankAccounts.length === 0 && sweepPlan.sourceBrokerages.length === 0 ? (
                  <p className="text-slate-500">
                    All active balances are already concentrated inside your three selected main
                    accounts.
                  </p>
                ) : (
                  <div className="space-y-1 text-slate-600 pt-1 border-t border-slate-200">
                    {sweepPlan.sourceBankAccounts.map((s) => (
                      <div key={s.id} className="flex items-center justify-between font-mono tabular-nums">
                        <span className="truncate">
                          {s.accountName} (····{s.accountMask})
                        </span>
                        <span>{formatCurrency(s.balance)} → $0.00</span>
                      </div>
                    ))}
                    {sweepPlan.sourceBrokerages.map((b) => (
                      <div key={b.id} className="flex items-center justify-between font-mono tabular-nums">
                        <span className="truncate">
                          {b.accountName} Cash (····{b.accountMask})
                        </span>
                        <span>{formatCurrency(b.cashBalance)} → $0.00</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="pt-2 border-t border-slate-200 space-y-1 font-mono tabular-nums text-slate-700">
                  <div className="flex items-center justify-between">
                    <span>→ DTC Credit</span>
                    <span className="text-emerald-700">+{formatCurrency(sweepPlan.dtcShare)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>→ Operating Credit</span>
                    <span className="text-emerald-700">+{formatCurrency(sweepPlan.opShare)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>→ Treasury Credit</span>
                    <span className="text-emerald-700">+{formatCurrency(sweepPlan.treasShare)}</span>
                  </div>
                </div>
              </div>

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setSweepModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sweepBusy || sweepPlan.totalToSweep <= 0}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  {sweepBusy ? 'Executing Sweep...' : 'Execute Consolidated Sweep'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {transferModalOpen && (
        <FundTransfersModal
          accounts={accounts}
          onClose={() => setTransferModalOpen(false)}
          onSuccess={(summary) => setSweepBanner(summary)}
        />
      )}
    </div>
  );
}
