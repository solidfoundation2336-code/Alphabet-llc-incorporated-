import { useMemo, useState } from 'react';
import { collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { CheckCircle2, FileUp, Layers, Play, Repeat, Sparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  TRANSACTION_CATEGORIES,
  type BankAccount,
  type BatchJob,
  type BatchSourceType,
  type RecurrenceCadence,
} from '../types/finance';
import {
  parseAndClassifyBatch,
  SAMPLE_BATCH_CSV,
  type StagedBatchRow,
} from '../utils/batchClassifier';
import { formatCurrency } from '../utils/formatters';

interface BatchProcessorViewProps {
  accounts: BankAccount[];
  batchJobs: BatchJob[];
}

export function BatchProcessorView({ accounts, batchJobs }: BatchProcessorViewProps) {
  const { user } = useAuth();
  const [targetAccountId, setTargetAccountId] = useState(accounts[0]?.id || '');
  const [batchName, setBatchName] = useState('November Treasury Bank Feed');
  const [sourceType, setSourceType] = useState<BatchSourceType>('bank_feed');
  const [rawCsv, setRawCsv] = useState(SAMPLE_BATCH_CSV);
  const [stagedRows, setStagedRows] = useState<StagedBatchRow[]>(() =>
    parseAndClassifyBatch(SAMPLE_BATCH_CSV),
  );
  const [committing, setCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === targetAccountId) || accounts[0],
    [accounts, targetAccountId],
  );

  const stagedSummary = useMemo(() => {
    const recurringCount = stagedRows.filter((r) => r.isRecurring).length;
    const totalVolume = stagedRows.reduce((s, r) => s + r.amount, 0);
    const netDelta = stagedRows.reduce(
      (s, r) => s + (r.direction === 'credit' ? r.amount : -r.amount),
      0,
    );
    return { recurringCount, totalVolume, netDelta };
  }, [stagedRows]);

  const handleAnalyze = () => {
    setErrorMsg(null);
    setCommitMessage(null);
    const parsed = parseAndClassifyBatch(rawCsv);
    if (parsed.length === 0) {
      setErrorMsg('No valid CSV rows detected. Expected: YYYY-MM-DD,Merchant,Description,Amount,debit|credit');
      return;
    }
    setStagedRows(parsed);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawCsv(text);
    setSourceType('csv_import');
    setBatchName(file.name.replace(/\.[^.]+$/, '').slice(0, 120) || 'CSV Batch Import');
    const parsed = parseAndClassifyBatch(text);
    setStagedRows(parsed);
    setCommitMessage(null);
  };

  const updateStagedRow = (
    rowId: string,
    patch: Partial<Pick<StagedBatchRow, 'category' | 'isRecurring' | 'recurrenceCadence'>>,
  ) => {
    setStagedRows((prev) =>
      prev.map((row) =>
        row.rowId === rowId ? { ...row, ...patch, confidence: 'manual' } : row,
      ),
    );
  };

  const handleCommitBatch = async () => {
    if (!user || !selectedAccount || stagedRows.length === 0) return;
    setErrorMsg(null);
    setCommitMessage(null);
    setCommitting(true);

    try {
      const batch = writeBatch(db);
      const batchRef = doc(collection(db, 'batch_jobs'));

      batch.set(batchRef, {
        ownerId: user.uid,
        batchName: batchName.trim() || 'Batch Feed Run',
        sourceType,
        totalItems: stagedRows.length,
        categorizedCount: stagedRows.length,
        recurringDetectedCount: stagedSummary.recurringCount,
        totalVolume: Math.round(stagedSummary.totalVolume * 100) / 100,
        status: 'committed',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const row of stagedRows) {
        const txRef = doc(collection(db, 'transactions'));
        batch.set(txRef, {
          ownerId: user.uid,
          accountId: selectedAccount.id,
          merchant: row.merchant,
          description: row.description,
          amount: row.amount,
          direction: row.direction,
          category: row.category,
          isRecurring: row.isRecurring,
          recurrenceCadence: row.isRecurring
            ? row.recurrenceCadence === 'none'
              ? 'monthly'
              : row.recurrenceCadence
            : 'none',
          batchId: batchRef.id,
          status: 'posted',
          occurredAt: row.occurredAt,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const nextBalance =
        Math.round((selectedAccount.balance + stagedSummary.netDelta) * 100) / 100;
      batch.update(doc(db, 'bank_accounts', selectedAccount.id), {
        balance: nextBalance,
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
      setCommitMessage(
        `Committed ${stagedRows.length} transactions (${stagedSummary.recurringCount} recurring commitments identified) to ${selectedAccount.accountName}.`,
      );
      setStagedRows([]);
      setRawCsv('');
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'batch_jobs');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-900 font-display">
          Batch Transaction Processing &amp; Recurring Rules
        </h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Ingest CSV feeds, normalize merchant strings, classify recurring expenses, and commit
          atomically to your ledger.
        </p>
      </div>

      {/* Ingestion & Configuration Panel */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Batch Label</label>
            <input
              type="text"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Target Bank Account
            </label>
            <select
              value={selectedAccount?.id || ''}
              onChange={(e) => setTargetAccountId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.accountName} (•••• {acc.accountMask})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Source Channel</label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as BatchSourceType)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              <option value="bank_feed">Automated Bank Feed</option>
              <option value="csv_import">CSV File Upload</option>
              <option value="manual_batch">Manual Batch Entry</option>
            </select>
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <label className="text-xs font-medium text-slate-700">
              CSV / Feed Payload (Date, Merchant, Description, Amount, Direction)
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setRawCsv(SAMPLE_BATCH_CSV);
                  setStagedRows(parseAndClassifyBatch(SAMPLE_BATCH_CSV));
                  setCommitMessage(null);
                  setErrorMsg(null);
                }}
                className="text-xs font-medium text-slate-700 hover:text-slate-900 underline cursor-pointer"
              >
                Load Sample Feed
              </button>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer">
                <FileUp className="w-3.5 h-3.5" />
                <span>Upload CSV</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => void handleFileUpload(e)}
                  className="hidden"
                />
              </label>
            </div>
          </div>
          <textarea
            rows={5}
            value={rawCsv}
            onChange={(e) => setRawCsv(e.target.value)}
            placeholder="2026-11-16,Bloomberg Terminal,Monthly Data Seat,2150.00,debit"
            className="w-full p-3 text-xs font-mono border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </div>

        {errorMsg && (
          <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {errorMsg}
          </div>
        )}

        {commitMessage && (
          <div className="p-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{commitMessage}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            onClick={handleAnalyze}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Analyze &amp; Categorize Batch</span>
          </button>

          {stagedRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-xs text-slate-600 font-mono tabular-nums">
                {stagedRows.length} rows · {stagedSummary.recurringCount} recurring · Volume{' '}
                {formatCurrency(stagedSummary.totalVolume)}
              </span>
              <button
                type="button"
                disabled={committing || !selectedAccount}
                onClick={() => void handleCommitBatch()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-50 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{committing ? 'Committing...' : 'Commit Batch to Ledger'}</span>
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Staged Classification Preview Table */}
      {stagedRows.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              Staged Batch Classification Preview
            </h3>
            <span className="text-xs text-slate-500">
              Override categories or cadences prior to atomic commit
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4">Merchant</th>
                  <th className="py-3 px-4">Assigned Category</th>
                  <th className="py-3 px-4">Recurring Rule</th>
                  <th className="py-3 px-4 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {stagedRows.map((row) => (
                  <tr key={row.rowId} className="hover:bg-slate-50">
                    <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-600">
                      {row.occurredAt}
                    </td>
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900">{row.merchant}</p>
                      <p className="text-xs text-slate-500">{row.description}</p>
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={row.category}
                        onChange={(e) => updateStagedRow(row.rowId, { category: e.target.value })}
                        className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white"
                      >
                        {TRANSACTION_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            updateStagedRow(row.rowId, {
                              isRecurring: !row.isRecurring,
                              recurrenceCadence: !row.isRecurring ? 'monthly' : 'none',
                            })
                          }
                          className={`inline-flex items-center gap-1 text-xs cursor-pointer ${
                            row.isRecurring ? 'text-slate-900 font-medium' : 'text-slate-400'
                          }`}
                        >
                          <Repeat className="w-3.5 h-3.5" />
                          <span>{row.isRecurring ? 'Recurring' : 'One-time'}</span>
                        </button>
                        {row.isRecurring && (
                          <select
                            value={row.recurrenceCadence}
                            onChange={(e) =>
                              updateStagedRow(row.rowId, {
                                recurrenceCadence: e.target.value as RecurrenceCadence,
                              })
                            }
                            className="text-xs border border-slate-200 rounded px-1.5 py-0.5 bg-white"
                          >
                            <option value="weekly">Weekly</option>
                            <option value="monthly">Monthly</option>
                            <option value="quarterly">Quarterly</option>
                            <option value="annual">Annual</option>
                          </select>
                        )}
                      </div>
                    </td>
                    <td
                      className={`py-3 px-4 text-right font-mono tabular-nums font-medium ${
                        row.direction === 'credit' ? 'text-emerald-700' : 'text-slate-900'
                      }`}
                    >
                      {row.direction === 'credit' ? '+' : '-'}
                      {formatCurrency(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Historical Batch Jobs Audit Log */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2">
          <Layers className="w-4 h-4 text-slate-600" />
          <h3 className="text-sm font-semibold text-slate-900 font-display">
            Committed Batch Processing Runs
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="py-3 px-4">Batch Name</th>
                <th className="py-3 px-4">Source</th>
                <th className="py-3 px-4 text-right">Items</th>
                <th className="py-3 px-4 text-right">Recurring Detected</th>
                <th className="py-3 px-4 text-right">Total Volume</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {batchJobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-xs text-slate-500">
                    No batch runs committed yet. Analyze and commit the staged feed above.
                  </td>
                </tr>
              ) : (
                batchJobs.map((job) => (
                  <tr key={job.id}>
                    <td className="py-3 px-4 font-medium text-slate-900">{job.batchName}</td>
                    <td className="py-3 px-4 text-xs text-slate-600 capitalize">
                      {job.sourceType.replace('_', ' ')}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                      {job.totalItems}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                      {job.recurringDetectedCount}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                      {formatCurrency(job.totalVolume)}
                    </td>
                    <td className="py-3 px-4 text-xs text-emerald-700 font-medium capitalize">
                      {job.status}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
