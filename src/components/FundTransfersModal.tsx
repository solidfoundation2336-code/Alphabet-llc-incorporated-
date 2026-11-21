import { useMemo, useState } from 'react';
import { collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ArrowRightLeft, Send, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  FIELD_LIMITS,
  TRANSACTION_CATEGORIES,
  type BankAccount,
} from '../types/finance';
import { formatCurrency } from '../utils/formatters';

interface FundTransfersModalProps {
  accounts: BankAccount[];
  onClose: () => void;
  onSuccess: (summary: string) => void;
}

type TransferMode = 'multi_source' | 'direct';

const MAX_ACCOUNT_BALANCE = 1_000_000_000;
const MAX_TX_CHUNK = 100_000_000;

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function FundTransfersModal({
  accounts,
  onClose,
  onSuccess,
}: FundTransfersModalProps) {
  const { user } = useAuth();

  const activeAccounts = useMemo(
    () => accounts.filter((a) => a.status === 'active'),
    [accounts],
  );

  const defaultTargets = useMemo(() => {
    const dtc =
      activeAccounts.find(
        (a) =>
          a.accountType === 'settlement' ||
          a.accountName.toLowerCase().includes('dtc'),
      ) || activeAccounts[0];
    const operating =
      activeAccounts.find(
        (a) =>
          a.id !== dtc?.id &&
          (a.accountType === 'checking' ||
            a.accountName.toLowerCase().includes('operating')),
      ) ||
      activeAccounts.find((a) => a.id !== dtc?.id) ||
      dtc;
    const treasury =
      activeAccounts.find(
        (a) =>
          a.id !== dtc?.id &&
          a.id !== operating?.id &&
          (a.accountType === 'treasury' ||
            a.accountName.toLowerCase().includes('treasury')),
      ) ||
      activeAccounts.find((a) => a.id !== dtc?.id && a.id !== operating?.id) ||
      operating;

    return {
      dtcId: dtc?.id || '',
      operatingId: operating?.id || '',
      treasuryId: treasury?.id || '',
    };
  }, [activeAccounts]);

  const [mode, setMode] = useState<TransferMode>(
    activeAccounts.length >= 3 ? 'multi_source' : 'direct',
  );

  // Shared fields
  const [transferDate, setTransferDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [transferCategory, setTransferCategory] = useState<string>(
    'Settlement & Clearing',
  );
  const [transferMemo, setTransferMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Multi-source state
  const [dtcTargetId, setDtcTargetId] = useState(defaultTargets.dtcId);
  const [operatingTargetId, setOperatingTargetId] = useState(
    defaultTargets.operatingId,
  );
  const [treasuryTargetId, setTreasuryTargetId] = useState(
    defaultTargets.treasuryId,
  );
  const [dtcPct, setDtcPct] = useState('33.34');
  const [operatingPct, setOperatingPct] = useState('33.33');
  const [treasuryPct, setTreasuryPct] = useState('33.33');
  const [selectedSources, setSelectedSources] = useState<Record<string, string>>(
    () => {
      const targetIds = new Set(
        [
          defaultTargets.dtcId,
          defaultTargets.operatingId,
          defaultTargets.treasuryId,
        ].filter(Boolean),
      );
      const initial: Record<string, string> = {};
      for (const acc of activeAccounts) {
        if (!targetIds.has(acc.id) && acc.balance > 0) {
          initial[acc.id] = acc.balance.toFixed(2);
        }
      }
      return initial;
    },
  );

  // Direct transfer state
  const defaultDirectSource =
    activeAccounts.find((a) => a.balance > 0) || activeAccounts[0];
  const defaultDirectDest =
    activeAccounts.find((a) => a.id !== defaultDirectSource?.id) ||
    activeAccounts[1];
  const [directSourceId, setDirectSourceId] = useState(
    defaultDirectSource?.id || '',
  );
  const [directTargetId, setDirectTargetId] = useState(
    defaultDirectDest?.id || '',
  );
  const [directAmount, setDirectAmount] = useState('');

  const accountLookup = useMemo(() => {
    const map = new Map<string, BankAccount>();
    for (const acc of accounts) {
      map.set(acc.id, acc);
    }
    return map;
  }, [accounts]);

  const multiTargetIds = useMemo(() => {
    const ids = new Set<string>();
    const pDtc = Number.parseFloat(dtcPct) || 0;
    const pOp = Number.parseFloat(operatingPct) || 0;
    const pTreas = Number.parseFloat(treasuryPct) || 0;
    if (dtcTargetId && pDtc > 0) ids.add(dtcTargetId);
    if (operatingTargetId && pOp > 0) ids.add(operatingTargetId);
    if (treasuryTargetId && pTreas > 0) ids.add(treasuryTargetId);
    return ids;
  }, [
    dtcTargetId,
    operatingTargetId,
    treasuryTargetId,
    dtcPct,
    operatingPct,
    treasuryPct,
  ]);

  const multiSourcePlan = useMemo(() => {
    const pDtc = Number.parseFloat(dtcPct) || 0;
    const pOp = Number.parseFloat(operatingPct) || 0;
    const pTreas = Number.parseFloat(treasuryPct) || 0;
    const pctSum = roundCents(pDtc + pOp + pTreas);

    const sources: Array<{
      account: BankAccount;
      amount: number;
      projectedBalance: number;
      overdrawn: boolean;
    }> = [];

    for (const acc of activeAccounts) {
      if (multiTargetIds.has(acc.id)) continue;
      const raw = selectedSources[acc.id];
      if (raw === undefined) continue;
      const parsed = Number.parseFloat(raw);
      const amount = Number.isFinite(parsed) && parsed > 0 ? roundCents(parsed) : 0;
      if (amount <= 0) continue;
      sources.push({
        account: acc,
        amount,
        projectedBalance: roundCents(acc.balance - amount),
        overdrawn: amount > acc.balance + 0.001,
      });
    }

    const totalAmount = roundCents(
      sources.reduce((sum, item) => sum + item.amount, 0),
    );

    const rawShares = [
      { key: 'dtc', label: 'DTC Clearing', id: dtcTargetId, pct: pDtc },
      {
        key: 'operating',
        label: 'Operating',
        id: operatingTargetId,
        pct: pOp,
      },
      { key: 'treasury', label: 'Treasury', id: treasuryTargetId, pct: pTreas },
    ];

    const nonZeroIndices = rawShares
      .map((s, idx) => (s.pct > 0 ? idx : -1))
      .filter((idx) => idx >= 0);
    const lastActiveIdx =
      nonZeroIndices.length > 0
        ? nonZeroIndices[nonZeroIndices.length - 1]
        : -1;

    let runningAssigned = 0;
    const destinations = rawShares.map((item, idx) => {
      let share = 0;
      if (totalAmount > 0 && item.pct > 0) {
        if (idx === lastActiveIdx) {
          share = Math.max(0, roundCents(totalAmount - runningAssigned));
        } else {
          share = roundCents(totalAmount * (item.pct / 100));
          runningAssigned = roundCents(runningAssigned + share);
        }
      }
      const acc = item.id ? accountLookup.get(item.id) : undefined;
      const projected = acc ? roundCents(acc.balance + share) : share;
      return {
        ...item,
        account: acc,
        share,
        projectedBalance: projected,
        exceedsLimit: projected > MAX_ACCOUNT_BALANCE,
      };
    });

    const hasDistinctTargets =
      Boolean(dtcTargetId) &&
      Boolean(operatingTargetId) &&
      Boolean(treasuryTargetId) &&
      dtcTargetId !== operatingTargetId &&
      dtcTargetId !== treasuryTargetId &&
      operatingTargetId !== treasuryTargetId;

    return {
      sources,
      destinations,
      totalAmount,
      pctSum,
      hasDistinctTargets,
    };
  }, [
    activeAccounts,
    multiTargetIds,
    selectedSources,
    dtcTargetId,
    operatingTargetId,
    treasuryTargetId,
    dtcPct,
    operatingPct,
    treasuryPct,
    accountLookup,
  ]);

  const directPlan = useMemo(() => {
    const src = directSourceId ? accountLookup.get(directSourceId) : undefined;
    const dest = directTargetId ? accountLookup.get(directTargetId) : undefined;
    const parsed = Number.parseFloat(directAmount);
    const amount = Number.isFinite(parsed) && parsed > 0 ? roundCents(parsed) : 0;
    const srcProjected = src ? roundCents(src.balance - amount) : 0;
    const destProjected = dest ? roundCents(dest.balance + amount) : 0;
    return {
      src,
      dest,
      amount,
      srcProjected,
      destProjected,
      overdrawn: Boolean(src && amount > src.balance + 0.001),
      exceedsLimit: destProjected > MAX_ACCOUNT_BALANCE,
    };
  }, [directSourceId, directTargetId, directAmount, accountLookup]);

  const toggleSourceSelection = (acc: BankAccount) => {
    setFormError(null);
    setSelectedSources((prev) => {
      const next = { ...prev };
      if (next[acc.id] !== undefined) {
        delete next[acc.id];
      } else {
        next[acc.id] = acc.balance > 0 ? acc.balance.toFixed(2) : '0.00';
      }
      return next;
    });
  };

  const setSourceFraction = (acc: BankAccount, ratio: number) => {
    setFormError(null);
    const val = roundCents(acc.balance * ratio);
    setSelectedSources((prev) => ({
      ...prev,
      [acc.id]: val.toFixed(2),
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setFormError(null);

    if (!transferDate || transferDate.length < 10) {
      setFormError('Select a valid transfer posting date.');
      return;
    }

    const memoTrimmed = transferMemo.trim();

    if (mode === 'multi_source') {
      if (!multiSourcePlan.hasDistinctTargets) {
        setFormError(
          'Select three distinct active accounts for DTC, Operating, and Treasury.',
        );
        return;
      }
      if (Math.abs(multiSourcePlan.pctSum - 100) > 0.05) {
        setFormError('Destination allocation percentages must total 100%.');
        return;
      }
      if (multiSourcePlan.sources.length === 0 || multiSourcePlan.totalAmount <= 0) {
        setFormError(
          'Select at least one active funding source with a positive transfer amount.',
        );
        return;
      }
      const overdrawn = multiSourcePlan.sources.find((s) => s.overdrawn);
      if (overdrawn) {
        setFormError(
          `Transfer amount for ${overdrawn.account.accountName} exceeds its available balance of ${formatCurrency(overdrawn.account.balance, overdrawn.account.currency)}.`,
        );
        return;
      }
      const overLimit = multiSourcePlan.destinations.find((d) => d.exceedsLimit);
      if (overLimit && overLimit.account) {
        setFormError(
          `${overLimit.account.accountName} would exceed the $1,000,000,000 single-account balance limit.`,
        );
        return;
      }

      setSubmitting(true);
      try {
        const batch = writeBatch(db);
        const targetNames = multiSourcePlan.destinations
          .filter((d) => d.share > 0 && d.account)
          .map((d) => d.label)
          .join(', ');

        for (const src of multiSourcePlan.sources) {
          batch.update(doc(db, 'bank_accounts', src.account.id), {
            balance: src.projectedBalance,
            updatedAt: serverTimestamp(),
          });

          let remaining = src.amount;
          while (remaining > 0.001) {
            const chunk = roundCents(Math.min(remaining, MAX_TX_CHUNK));
            const desc = (
              memoTrimmed ||
              `Multi-source fund transfer to ${targetNames || 'Primary Accounts'}`
            ).slice(0, FIELD_LIMITS.DESC_MAX);
            batch.set(doc(collection(db, 'transactions')), {
              ownerId: user.uid,
              accountId: src.account.id,
              merchant: 'Internal Fund Transfer',
              description: desc,
              amount: chunk,
              direction: 'debit',
              category: transferCategory,
              isRecurring: false,
              recurrenceCadence: 'none',
              batchId: '',
              status: 'posted',
              occurredAt: transferDate,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            remaining = roundCents(remaining - chunk);
          }
        }

        for (const dest of multiSourcePlan.destinations) {
          if (!dest.account || dest.share <= 0) continue;
          batch.update(doc(db, 'bank_accounts', dest.account.id), {
            balance: dest.projectedBalance,
            updatedAt: serverTimestamp(),
          });

          let remaining = dest.share;
          while (remaining > 0.001) {
            const chunk = roundCents(Math.min(remaining, MAX_TX_CHUNK));
            const desc = (
              memoTrimmed ||
              `Inbound multi-source transfer from ${multiSourcePlan.sources.length} account${multiSourcePlan.sources.length === 1 ? '' : 's'} to ${dest.label}`
            ).slice(0, FIELD_LIMITS.DESC_MAX);
            batch.set(doc(collection(db, 'transactions')), {
              ownerId: user.uid,
              accountId: dest.account.id,
              merchant: 'Internal Fund Transfer',
              description: desc,
              amount: chunk,
              direction: 'credit',
              category: transferCategory,
              isRecurring: false,
              recurrenceCadence: 'none',
              batchId: '',
              status: 'posted',
              occurredAt: transferDate,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            remaining = roundCents(remaining - chunk);
          }
        }

        await batch.commit();
        const dtcAmt = multiSourcePlan.destinations[0]?.share || 0;
        const opAmt = multiSourcePlan.destinations[1]?.share || 0;
        const treasAmt = multiSourcePlan.destinations[2]?.share || 0;
        onSuccess(
          `Transferred ${formatCurrency(multiSourcePlan.totalAmount)} from ${multiSourcePlan.sources.length} source account${multiSourcePlan.sources.length === 1 ? '' : 's'} into DTC (${formatCurrency(dtcAmt)}), Operating (${formatCurrency(opAmt)}), and Treasury (${formatCurrency(treasAmt)}).`,
        );
        onClose();
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.WRITE,
          'bank_accounts/fund_transfers',
        );
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Direct 1-to-1 Transfer
    if (!directPlan.src || !directPlan.dest) {
      setFormError('Select both an active source account and destination account.');
      return;
    }
    if (directPlan.src.id === directPlan.dest.id) {
      setFormError('Source and destination accounts must be distinct.');
      return;
    }
    if (
      directPlan.src.status !== 'active' ||
      directPlan.dest.status !== 'active'
    ) {
      setFormError('Both source and destination accounts must be active.');
      return;
    }
    if (directPlan.amount <= 0) {
      setFormError('Enter a positive transfer amount.');
      return;
    }
    if (directPlan.overdrawn) {
      setFormError(
        `Transfer amount exceeds available balance (${formatCurrency(directPlan.src.balance, directPlan.src.currency)}).`,
      );
      return;
    }
    if (directPlan.exceedsLimit) {
      setFormError(
        `${directPlan.dest.accountName} would exceed the $1,000,000,000 single-account balance limit.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'bank_accounts', directPlan.src.id), {
        balance: directPlan.srcProjected,
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'bank_accounts', directPlan.dest.id), {
        balance: directPlan.destProjected,
        updatedAt: serverTimestamp(),
      });

      let remainingDebit = directPlan.amount;
      while (remainingDebit > 0.001) {
        const chunk = roundCents(Math.min(remainingDebit, MAX_TX_CHUNK));
        batch.set(doc(collection(db, 'transactions')), {
          ownerId: user.uid,
          accountId: directPlan.src.id,
          merchant: `Transfer to ${directPlan.dest.accountName}`.slice(
            0,
            FIELD_LIMITS.NAME_MAX,
          ),
          description: (
            memoTrimmed ||
            `Internal book transfer to ${directPlan.dest.accountName} (····${directPlan.dest.accountMask})`
          ).slice(0, FIELD_LIMITS.DESC_MAX),
          amount: chunk,
          direction: 'debit',
          category: transferCategory,
          isRecurring: false,
          recurrenceCadence: 'none',
          batchId: '',
          status: 'posted',
          occurredAt: transferDate,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        remainingDebit = roundCents(remainingDebit - chunk);
      }

      let remainingCredit = directPlan.amount;
      while (remainingCredit > 0.001) {
        const chunk = roundCents(Math.min(remainingCredit, MAX_TX_CHUNK));
        batch.set(doc(collection(db, 'transactions')), {
          ownerId: user.uid,
          accountId: directPlan.dest.id,
          merchant: `Transfer from ${directPlan.src.accountName}`.slice(
            0,
            FIELD_LIMITS.NAME_MAX,
          ),
          description: (
            memoTrimmed ||
            `Internal book transfer from ${directPlan.src.accountName} (····${directPlan.src.accountMask})`
          ).slice(0, FIELD_LIMITS.DESC_MAX),
          amount: chunk,
          direction: 'credit',
          category: transferCategory,
          isRecurring: false,
          recurrenceCadence: 'none',
          batchId: '',
          status: 'posted',
          occurredAt: transferDate,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        remainingCredit = roundCents(remainingCredit - chunk);
      }

      await batch.commit();
      onSuccess(
        `Transferred ${formatCurrency(directPlan.amount)} from ${directPlan.src.accountName} to ${directPlan.dest.accountName}.`,
      );
      onClose();
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.WRITE,
        'bank_accounts/direct_transfer',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fund-transfers-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h3
              id="fund-transfers-title"
              className="text-base font-semibold text-slate-900 font-display"
            >
              Internal Fund Transfers
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Move verified balances between active linked accounts with atomic double-entry posting
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Fund Transfers modal"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {activeAccounts.length < 2 ? (
          <div className="py-10 text-center space-y-2">
            <p className="text-sm font-medium text-slate-900">
              At least two active linked accounts are required
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Link another active bank or custody account in the ledger before initiating an internal fund transfer. Frozen and closed accounts cannot initiate or receive transfers.
            </p>
            <div className="pt-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-5">
            {/* Mode Toggle */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => {
                    setFormError(null);
                    setMode('multi_source');
                  }}
                  disabled={activeAccounts.length < 3}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                    mode === 'multi_source'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Multi-Source to Main 3
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFormError(null);
                    setMode('direct');
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    mode === 'direct'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Direct Account Transfer
                </button>
              </div>
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                {activeAccounts.length} active · {accounts.length - activeAccounts.length} inactive
              </span>
            </div>

            {formError && (
              <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {formError}
              </div>
            )}

            {mode === 'multi_source' ? (
              <>
                {/* Primary Target Accounts */}
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        1. DTC Target Account
                      </label>
                      <select
                        value={dtcTargetId}
                        onChange={(e) => setDtcTargetId(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
                      >
                        {activeAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.accountName} (····{a.accountMask})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        2. Operating Target Account
                      </label>
                      <select
                        value={operatingTargetId}
                        onChange={(e) => setOperatingTargetId(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
                      >
                        {activeAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.accountName} (····{a.accountMask})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        3. Treasury Target Account
                      </label>
                      <select
                        value={treasuryTargetId}
                        onChange={(e) => setTreasuryTargetId(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
                      >
                        {activeAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.accountName} (····{a.accountMask})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Allocation Split */}
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                      <span className="text-xs font-medium text-slate-700">
                        Destination Split ({multiSourcePlan.pctSum.toFixed(2)}%)
                      </span>
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() => {
                            setDtcPct('33.34');
                            setOperatingPct('33.33');
                            setTreasuryPct('33.33');
                          }}
                          className="px-2.5 py-1 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer whitespace-nowrap"
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
                          className="px-2.5 py-1 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer whitespace-nowrap"
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
                          className="px-2.5 py-1 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer whitespace-nowrap"
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
                        aria-label="DTC allocation percentage"
                        className="w-full px-3 py-1.5 text-xs font-mono tabular-nums border border-slate-200 rounded-lg"
                      />
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        value={operatingPct}
                        onChange={(e) => setOperatingPct(e.target.value)}
                        aria-label="Operating allocation percentage"
                        className="w-full px-3 py-1.5 text-xs font-mono tabular-nums border border-slate-200 rounded-lg"
                      />
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        value={treasuryPct}
                        onChange={(e) => setTreasuryPct(e.target.value)}
                        aria-label="Treasury allocation percentage"
                        className="w-full px-3 py-1.5 text-xs font-mono tabular-nums border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                </div>

                {/* Funding Source Checklist */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-700">
                      Select Verified Source Accounts &amp; Amounts
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-500">
                      Total Selected: {formatCurrency(multiSourcePlan.totalAmount)}
                    </span>
                  </div>

                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-200">
                    {accounts.map((acc) => {
                      const isTarget = multiTargetIds.has(acc.id);
                      const isInactive = acc.status !== 'active';
                      const noFunds = acc.balance <= 0;
                      const disabled = isTarget || isInactive || noFunds;
                      const isChecked =
                        !disabled && selectedSources[acc.id] !== undefined;

                      const reason = isInactive
                        ? `Status: ${acc.status} · Locked`
                        : isTarget
                          ? 'Assigned as receiving destination'
                          : noFunds
                            ? 'No positive balance available'
                            : null;

                      return (
                        <div
                          key={acc.id}
                          className={`p-3 flex flex-wrap items-center justify-between gap-3 ${
                            disabled ? 'bg-slate-50/70 opacity-75' : 'bg-white'
                          }`}
                        >
                          <label
                            className={`flex items-start gap-2.5 flex-1 min-w-[200px] ${
                              disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              disabled={disabled}
                              onChange={() => toggleSourceSelection(acc)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-slate-900 truncate">
                                {acc.accountName}
                              </p>
                              <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                                {acc.institutionName} · ····{acc.accountMask} ·{' '}
                                {formatCurrency(acc.balance, acc.currency)}
                                {reason ? ` · ${reason}` : ''}
                              </p>
                            </div>
                          </label>

                          {!disabled && isChecked && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => setSourceFraction(acc, 0.25)}
                                className="px-2 py-1 text-[11px] border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                              >
                                25%
                              </button>
                              <button
                                type="button"
                                onClick={() => setSourceFraction(acc, 0.5)}
                                className="px-2 py-1 text-[11px] border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                              >
                                50%
                              </button>
                              <button
                                type="button"
                                onClick={() => setSourceFraction(acc, 1)}
                                className="px-2 py-1 text-[11px] border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                              >
                                Max
                              </button>
                              <input
                                type="number"
                                step="0.01"
                                min="0.01"
                                max={acc.balance}
                                value={selectedSources[acc.id] ?? ''}
                                onChange={(e) => {
                                  setFormError(null);
                                  setSelectedSources((prev) => ({
                                    ...prev,
                                    [acc.id]: e.target.value,
                                  }));
                                }}
                                aria-label={`Transfer amount from ${acc.accountName}`}
                                className="w-28 px-2.5 py-1 text-xs font-mono tabular-nums text-right border border-slate-200 rounded-md"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              /* Direct 1-to-1 Transfer */
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Source Account (Active)
                    </label>
                    <select
                      value={directSourceId}
                      onChange={(e) => {
                        setFormError(null);
                        setDirectSourceId(e.target.value);
                      }}
                      className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
                    >
                      {activeAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.accountName} (····{a.accountMask}) ·{' '}
                          {formatCurrency(a.balance, a.currency)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Destination Account (Active)
                    </label>
                    <select
                      value={directTargetId}
                      onChange={(e) => {
                        setFormError(null);
                        setDirectTargetId(e.target.value);
                      }}
                      className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-900"
                    >
                      {activeAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.accountName} (····{a.accountMask}) ·{' '}
                          {formatCurrency(a.balance, a.currency)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-700">
                      Transfer Amount (USD)
                    </label>
                    {directPlan.src && (
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() =>
                            setDirectAmount(
                              roundCents(directPlan.src!.balance * 0.25).toFixed(2),
                            )
                          }
                          className="px-2 py-0.5 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          25%
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDirectAmount(
                              roundCents(directPlan.src!.balance * 0.5).toFixed(2),
                            )
                          }
                          className="px-2 py-0.5 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          50%
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDirectAmount(directPlan.src!.balance.toFixed(2))
                          }
                          className="px-2 py-0.5 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          Max
                        </button>
                      </div>
                    )}
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={directAmount}
                    onChange={(e) => {
                      setFormError(null);
                      setDirectAmount(e.target.value);
                    }}
                    placeholder="25000.00"
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg"
                  />
                </div>
              </div>
            )}

            {/* Metadata Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Posting Date
                </label>
                <input
                  type="date"
                  value={transferDate}
                  onChange={(e) => setTransferDate(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Ledger Category
                </label>
                <select
                  value={transferCategory}
                  onChange={(e) => setTransferCategory(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
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
                  Transfer Memo (Optional)
                </label>
                <input
                  type="text"
                  maxLength={160}
                  value={transferMemo}
                  onChange={(e) => setTransferMemo(e.target.value)}
                  placeholder="Liquidity rebalance"
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            {/* Pre-Flight Balance Impact Preview */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5 text-xs">
              <div className="flex items-center justify-between font-medium text-slate-900">
                <span className="inline-flex items-center gap-1.5">
                  <ArrowRightLeft className="w-3.5 h-3.5 text-slate-500" />
                  <span>Pre-Flight Balance Impact</span>
                </span>
                <span className="font-mono tabular-nums">
                  {mode === 'multi_source'
                    ? formatCurrency(multiSourcePlan.totalAmount)
                    : formatCurrency(directPlan.amount)}
                </span>
              </div>

              {mode === 'multi_source' ? (
                <div className="space-y-1.5 pt-2 border-t border-slate-200 font-mono tabular-nums">
                  {multiSourcePlan.sources.length === 0 ? (
                    <p className="text-slate-500 font-sans">
                      Select one or more active source accounts above to preview projected balances.
                    </p>
                  ) : (
                    multiSourcePlan.sources.map((s) => (
                      <div
                        key={s.account.id}
                        className="flex items-center justify-between text-slate-700"
                      >
                        <span className="truncate font-sans">
                          Debit · {s.account.accountName} (····{s.account.accountMask})
                        </span>
                        <span
                          className={
                            s.overdrawn ? 'text-red-700 font-medium' : 'text-slate-900'
                          }
                        >
                          {formatCurrency(s.account.balance)} →{' '}
                          {formatCurrency(s.projectedBalance)}
                        </span>
                      </div>
                    ))
                  )}

                  <div className="pt-1.5 border-t border-slate-200 space-y-1">
                    {multiSourcePlan.destinations.map((d) =>
                      d.account ? (
                        <div
                          key={d.key}
                          className="flex items-center justify-between text-slate-700"
                        >
                          <span className="truncate font-sans">
                            Credit ({d.label}) · {d.account.accountName}
                          </span>
                          <span className="text-emerald-700">
                            {formatCurrency(d.account.balance)} →{' '}
                            {formatCurrency(d.projectedBalance)} (+
                            {formatCurrency(d.share)})
                          </span>
                        </div>
                      ) : null,
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5 pt-2 border-t border-slate-200 font-mono tabular-nums">
                  {directPlan.src && (
                    <div className="flex items-center justify-between text-slate-700">
                      <span className="truncate font-sans">
                        Debit · {directPlan.src.accountName}
                      </span>
                      <span
                        className={
                          directPlan.overdrawn
                            ? 'text-red-700 font-medium'
                            : 'text-slate-900'
                        }
                      >
                        {formatCurrency(directPlan.src.balance)} →{' '}
                        {formatCurrency(directPlan.srcProjected)}
                      </span>
                    </div>
                  )}
                  {directPlan.dest && (
                    <div className="flex items-center justify-between text-slate-700">
                      <span className="truncate font-sans">
                        Credit · {directPlan.dest.accountName}
                      </span>
                      <span className="text-emerald-700">
                        {formatCurrency(directPlan.dest.balance)} →{' '}
                        {formatCurrency(directPlan.destProjected)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="pt-1 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  submitting ||
                  (mode === 'multi_source'
                    ? multiSourcePlan.totalAmount <= 0 ||
                      multiSourcePlan.sources.some((s) => s.overdrawn) ||
                      !multiSourcePlan.hasDistinctTargets
                    : directPlan.amount <= 0 ||
                      directPlan.overdrawn ||
                      !directPlan.src ||
                      !directPlan.dest ||
                      directPlan.src.id === directPlan.dest.id)
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{submitting ? 'Processing Transfer...' : 'Execute Transfer'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
