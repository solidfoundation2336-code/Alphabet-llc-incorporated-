import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import {
  CheckCircle2,
  Download,
  FileText,
  KeyRound,
  Printer,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  BankAccount,
  FinancialReport,
  Payment,
  PaymentRail,
  ReportType,
  Transaction,
} from '../types/finance';
import {
  csvEscape,
  downloadTextFile,
  formatCurrency,
  generateSafeId,
} from '../utils/formatters';
import {
  generateTotpCode,
  generateTotpSecret,
  getTotpSecondsRemaining,
  verifyTotpCode,
} from '../utils/totp';

interface PaymentsReportsViewProps {
  accounts: BankAccount[];
  transactions: Transaction[];
  payments: Payment[];
  reports: FinancialReport[];
  purchasesAccountId?: string;
  openPaymentModalTrigger: number;
}

export function PaymentsReportsView({
  accounts,
  transactions,
  payments,
  reports,
  purchasesAccountId,
  openPaymentModalTrigger,
}: PaymentsReportsViewProps) {
  const { user } = useAuth();
  const [lastTrigger, setLastTrigger] = useState(openPaymentModalTrigger);

  // Payment creation state
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [sourceAccountId, setSourceAccountId] = useState(accounts[0]?.id || '');
  const [recipientName, setRecipientName] = useState('');
  const [routingMask, setRoutingMask] = useState('021000021');
  const [paymentRail, setPaymentRail] = useState<PaymentRail>('WIRE');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [stagingPayment, setStagingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // MFA Settlement Challenge state
  const [mfaTargetPayment, setMfaTargetPayment] = useState<Payment | null>(null);
  const [totpSecret, setTotpSecret] = useState(() => generateTotpSecret());
  const [liveCode, setLiveCode] = useState('------');
  const [secondsLeft, setSecondsLeft] = useState(getTotpSecondsRemaining());
  const [enteredCode, setEnteredCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);

  // Report generator & statement preview state
  const [reportAccountId, setReportAccountId] = useState(accounts[0]?.id || '');
  const [reportPeriod, setReportPeriod] = useState('2026-11');
  const [reportType, setReportType] = useState<ReportType>('monthly_statement');
  const [generatingReport, setGeneratingReport] = useState(false);
  const [previewReport, setPreviewReport] = useState<FinancialReport | null>(null);

  if (openPaymentModalTrigger !== lastTrigger) {
    setLastTrigger(openPaymentModalTrigger);
    setSourceAccountId(accounts[0]?.id || '');
    setPaymentError(null);
    setPaymentModalOpen(true);
  }

  useEffect(() => {
    let active = true;
    const tick = async () => {
      const code = await generateTotpCode(totpSecret);
      if (active) {
        setLiveCode(code);
        setSecondsLeft(getTotpSecondsRemaining());
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [totpSecret]);

  const accountLookup = useMemo(() => {
    const map = new Map<string, BankAccount>();
    accounts.forEach((a) => map.set(a.id, a));
    return map;
  }, [accounts]);

  const handleStagePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setPaymentError(null);

    const accId = sourceAccountId || accounts[0]?.id;
    const acc = accId ? accountLookup.get(accId) : undefined;
    if (!acc) {
      setPaymentError('Select a funded source account.');
      return;
    }

    const numAmount = Number.parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      setPaymentError('Enter a valid positive amount.');
      return;
    }
    if (numAmount > acc.balance) {
      setPaymentError('Amount exceeds available account balance.');
      return;
    }

    setStagingPayment(true);
    try {
      const docRef = await addDoc(collection(db, 'payments'), {
        ownerId: user.uid,
        sourceAccountId: acc.id,
        recipientName: recipientName.trim(),
        recipientRoutingMask: routingMask.trim().slice(0, 12),
        paymentRail,
        amount: Math.round(numAmount * 100) / 100,
        memo: memo.trim() || `${paymentRail} settlement to ${recipientName.trim()}`,
        mfaVerified: false,
        idempotencyKey: generateSafeId('PAY'),
        status: 'pending_mfa',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setPaymentModalOpen(false);
      setRecipientName('');
      setAmount('');
      setMemo('');
      // Immediately open fresh per-action MFA verification challenge
      setTotpSecret(generateTotpSecret());
      setMfaTargetPayment({
        id: docRef.id,
        ownerId: user.uid,
        sourceAccountId: acc.id,
        recipientName: recipientName.trim(),
        recipientRoutingMask: routingMask.trim().slice(0, 12),
        paymentRail,
        amount: Math.round(numAmount * 100) / 100,
        memo: memo.trim() || `${paymentRail} settlement`,
        mfaVerified: false,
        idempotencyKey: 'STAGED',
        status: 'pending_mfa',
      });
      setEnteredCode('');
      setMfaError(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'payments');
    } finally {
      setStagingPayment(false);
    }
  };

  const handleVerifyAndSettle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !mfaTargetPayment) return;
    setMfaError(null);

    const valid = await verifyTotpCode(totpSecret, enteredCode);
    if (!valid) {
      setMfaError('Invalid 6-digit TOTP authenticator code. Enter the current live code.');
      return;
    }

    const sourceAcc = accountLookup.get(mfaTargetPayment.sourceAccountId);
    if (!sourceAcc) {
      setMfaError('Source bank account could not be located.');
      return;
    }

    setSettling(true);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'payments', mfaTargetPayment.id), {
        mfaVerified: true,
        status: 'settled',
        updatedAt: serverTimestamp(),
      });

      const updatedBal =
        Math.round((sourceAcc.balance - mfaTargetPayment.amount) * 100) / 100;
      batch.update(doc(db, 'bank_accounts', sourceAcc.id), {
        balance: updatedBal,
        updatedAt: serverTimestamp(),
      });

      const txRef = doc(collection(db, 'transactions'));
      batch.set(txRef, {
        ownerId: user.uid,
        accountId: sourceAcc.id,
        merchant: mfaTargetPayment.recipientName,
        description: `${mfaTargetPayment.paymentRail} Payment · ${mfaTargetPayment.memo}`,
        amount: mfaTargetPayment.amount,
        direction: 'debit',
        category: 'Settlement & Clearing',
        isRecurring: false,
        recurrenceCadence: 'none',
        batchId: '',
        status: 'posted',
        occurredAt: new Date().toISOString().slice(0, 10),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
      setMfaTargetPayment(null);
      setEnteredCode('');
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `payments/${mfaTargetPayment.id}`);
    } finally {
      setSettling(false);
    }
  };

  const handleCancelPayment = async (payment: Payment) => {
    try {
      await updateDoc(doc(db, 'payments', payment.id), {
        status: 'cancelled',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `payments/${payment.id}`);
    }
  };

  const handleGenerateReport = async () => {
    if (!user) return;
    const accId = reportAccountId || accounts[0]?.id;
    const acc = accId ? accountLookup.get(accId) : undefined;
    if (!acc) return;

    const matchingTxs = transactions.filter(
      (tx) =>
        tx.accountId === acc.id &&
        (reportPeriod === 'all' || tx.occurredAt.startsWith(reportPeriod)),
    );
    const totalInflow = matchingTxs
      .filter((t) => t.direction === 'credit')
      .reduce((s, t) => s + t.amount, 0);
    const totalOutflow = matchingTxs
      .filter((t) => t.direction === 'debit')
      .reduce((s, t) => s + t.amount, 0);

    setGeneratingReport(true);
    try {
      await addDoc(collection(db, 'financial_reports'), {
        ownerId: user.uid,
        accountId: acc.id,
        reportTitle: `${acc.accountName} · ${reportPeriod === 'all' ? 'YTD' : reportPeriod} ${reportType.replace('_', ' ').toUpperCase()}`,
        reportPeriod: reportPeriod === 'all' ? '2026-YTD' : reportPeriod,
        reportType,
        totalInflow: Math.round(totalInflow * 100) / 100,
        totalOutflow: Math.round(totalOutflow * 100) / 100,
        netCashFlow: Math.round((totalInflow - totalOutflow) * 100) / 100,
        transactionCount: matchingTxs.length,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'financial_reports');
    } finally {
      setGeneratingReport(false);
    }
  };

  const handleDownloadReportCsv = (report: FinancialReport) => {
    const acc = accountLookup.get(report.accountId);
    const matchingTxs = transactions.filter(
      (tx) =>
        tx.accountId === report.accountId &&
        (report.reportPeriod.includes('YTD') || tx.occurredAt.startsWith(report.reportPeriod)),
    );
    const lines = [
      'Report Title,Account,Period,Total Inflow,Total Outflow,Net Cash Flow,Transaction Count',
      [
        csvEscape(report.reportTitle),
        csvEscape(acc ? `${acc.accountName} (${acc.accountMask})` : report.accountId),
        csvEscape(report.reportPeriod),
        csvEscape(report.totalInflow.toFixed(2)),
        csvEscape(report.totalOutflow.toFixed(2)),
        csvEscape(report.netCashFlow.toFixed(2)),
        csvEscape(report.transactionCount),
      ].join(','),
      '',
      'Date,Merchant,Category,Direction,Amount,Status',
      ...matchingTxs.map((tx) =>
        [
          csvEscape(tx.occurredAt),
          csvEscape(tx.merchant),
          csvEscape(tx.category),
          csvEscape(tx.direction),
          csvEscape(tx.amount.toFixed(2)),
          csvEscape(tx.status),
        ].join(','),
      ),
    ];
    downloadTextFile(`${report.reportPeriod}-${report.reportType}.csv`, lines.join('\n'));
  };

  const handleDownloadReportJson = (report: FinancialReport) => {
    const acc = accountLookup.get(report.accountId);
    const matchingTxs = transactions.filter(
      (tx) =>
        tx.accountId === report.accountId &&
        (report.reportPeriod.includes('YTD') || tx.occurredAt.startsWith(report.reportPeriod)),
    );
    const categoryTotals: Record<string, number> = {};
    matchingTxs
      .filter((tx) => tx.direction === 'debit')
      .forEach((tx) => {
        categoryTotals[tx.category] =
          Math.round(((categoryTotals[tx.category] || 0) + tx.amount) * 100) / 100;
      });

    const auditPack = {
      schema: 'veridian-ledger-audit-pack-v1',
      exportedAt: new Date().toISOString(),
      report: {
        id: report.id,
        title: report.reportTitle,
        period: report.reportPeriod,
        type: report.reportType,
        totalInflow: report.totalInflow,
        totalOutflow: report.totalOutflow,
        netCashFlow: report.netCashFlow,
        transactionCount: report.transactionCount,
      },
      account: acc
        ? {
            id: acc.id,
            accountName: acc.accountName,
            institutionName: acc.institutionName,
            accountType: acc.accountType,
            accountMask: acc.accountMask,
            currency: acc.currency,
            currentBalance: acc.balance,
          }
        : null,
      categoryOutflows: categoryTotals,
      transactions: matchingTxs.map((tx) => ({
        id: tx.id,
        occurredAt: tx.occurredAt,
        merchant: tx.merchant,
        description: tx.description,
        category: tx.category,
        direction: tx.direction,
        amount: tx.amount,
        isRecurring: tx.isRecurring,
        recurrenceCadence: tx.recurrenceCadence,
        status: tx.status,
      })),
    };

    downloadTextFile(
      `${report.reportPeriod}-${report.reportType}-audit-pack.json`,
      JSON.stringify(auditPack, null, 2),
      'application/json;charset=utf-8;',
    );
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 font-display">
            Secure Payment Settlement &amp; Financial Statements
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Dual-control TOTP MFA verification for outgoing transfers and per-account financial
            report generation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setSourceAccountId(accounts[0]?.id || '');
            setPaymentError(null);
            setPaymentModalOpen(true);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Initiate Payment</span>
        </button>
      </div>

      {/* Secure Payment Queue */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 font-display">
            Payment Settlement Ledger
          </h3>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            {payments.filter((p) => p.status === 'pending_mfa').length} awaiting MFA
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="py-3 px-4">Recipient &amp; Memo</th>
                <th className="py-3 px-4">Source Account</th>
                <th className="py-3 px-4">Rail</th>
                <th className="py-3 px-4 text-right">Amount</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-xs text-slate-500">
                    No outgoing payments initiated yet. Click Initiate Payment to stage an
                    MFA-protected transfer.
                  </td>
                </tr>
              ) : (
                payments.map((p) => {
                  const acc = accountLookup.get(p.sourceAccountId);
                  return (
                    <tr key={p.id}>
                      <td className="py-3 px-4">
                        <p className="font-medium text-slate-900">{p.recipientName}</p>
                        <p className="text-xs text-slate-500">
                          Routing •••• {p.recipientRoutingMask.slice(-4)} · {p.memo}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        {acc
                          ? `${acc.accountName} (•••• ${acc.accountMask})${
                              acc.id === purchasesAccountId ? ' · Purchases' : ''
                            }`
                          : p.sourceAccountId}
                      </td>
                      <td className="py-3 px-4 text-xs font-mono text-slate-700">
                        {p.paymentRail}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                        {formatCurrency(p.amount)}
                      </td>
                      <td className="py-3 px-4 text-xs font-medium">
                        {p.status === 'settled' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Settled · MFA Verified</span>
                          </span>
                        ) : p.status === 'pending_mfa' ? (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <KeyRound className="w-3.5 h-3.5" />
                            <span>Pending MFA</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-slate-500">
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Cancelled</span>
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {p.status === 'pending_mfa' && (
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setTotpSecret(generateTotpSecret());
                                setMfaTargetPayment(p);
                                setEnteredCode('');
                                setMfaError(null);
                              }}
                              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                            >
                              Verify &amp; Settle
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleCancelPayment(p)}
                              className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Financial Report Generator & Archive */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Account Financial Reports &amp; Audit Statements
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Compile real-time inflow/outflow statements per bank account for export or print
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="no-print inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print View</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">User Account</label>
            <select
              value={reportAccountId || accounts[0]?.id || ''}
              onChange={(e) => setReportAccountId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountName} (•••• {a.accountMask})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Period</label>
            <select
              value={reportPeriod}
              onChange={(e) => setReportPeriod(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg bg-white"
            >
              <option value="2026-11">2026-11</option>
              <option value="2026-10">2026-10</option>
              <option value="2026-09">2026-09</option>
              <option value="all">Full Year 2026 (YTD)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Report Format</label>
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value as ReportType)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              <option value="monthly_statement">Monthly Statement</option>
              <option value="cash_flow">Cash Flow Analysis</option>
              <option value="tax_ledger">Tax-Ready Ledger</option>
              <option value="audit_pack">Compliance Audit Pack</option>
            </select>
          </div>
          <button
            type="button"
            disabled={generatingReport || accounts.length === 0}
            onClick={() => void handleGenerateReport()}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer h-[38px]"
          >
            {generatingReport ? 'Generating...' : 'Generate Account Report'}
          </button>
        </div>

        <div className="divide-y divide-slate-100">
          {reports.map((rep) => {
            const acc = accountLookup.get(rep.accountId);
            return (
              <div
                key={rep.id}
                className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="flex items-start gap-3">
                  <FileText className="w-4 h-4 text-slate-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-slate-900">{rep.reportTitle}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {acc ? acc.accountName : rep.accountId} · Period {rep.reportPeriod} ·{' '}
                      <span className="font-mono tabular-nums">{rep.transactionCount}</span>{' '}
                      entries
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="text-xs font-mono tabular-nums text-slate-600 mr-2">
                    Inflow <strong className="text-emerald-700">{formatCurrency(rep.totalInflow)}</strong>{' '}
                    · Outflow <strong className="text-slate-900">{formatCurrency(rep.totalOutflow)}</strong>{' '}
                    · Net <strong className="text-slate-900">{formatCurrency(rep.netCashFlow)}</strong>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviewReport(rep)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>Statement</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadReportCsv(rep)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>CSV</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadReportJson(rep)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-900 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 cursor-pointer whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>JSON Audit</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Stage Payment Modal */}
      {paymentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                Initiate Secure Payment
              </h3>
              <button
                type="button"
                onClick={() => setPaymentModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleStagePayment(e)} className="mt-5 space-y-4">
              {paymentError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {paymentError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Source Account
                </label>
                <select
                  value={sourceAccountId || accounts[0]?.id || ''}
                  onChange={(e) => setSourceAccountId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.accountName}
                      {a.id === purchasesAccountId ? ' [Purchases Account]' : ''} (
                      {formatCurrency(a.balance)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Beneficiary / Recipient Name
                </label>
                <input
                  type="text"
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  placeholder="Meridian Clearing & Custody LLC"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Settlement Rail
                  </label>
                  <select
                    value={paymentRail}
                    onChange={(e) => setPaymentRail(e.target.value as PaymentRail)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="WIRE">Fedwire</option>
                    <option value="ACH">ACH Same-Day</option>
                    <option value="FEDNOW">FedNow Instant</option>
                    <option value="INTERNAL">Internal Book</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Routing / Account Mask
                  </label>
                  <input
                    type="text"
                    value={routingMask}
                    onChange={(e) => setRoutingMask(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Amount (USD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="12500.00"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Settlement Memo
                </label>
                <input
                  type="text"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="Q4 DTC margin collateral funding"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>
              <div className="pt-3 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setPaymentModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={stagingPayment}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {stagingPayment ? 'Staging...' : 'Proceed to MFA Verification'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TOTP MFA Settlement Challenge Modal */}
      {mfaTargetPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-slate-900" />
                <h3 className="text-base font-semibold text-slate-900 font-display">
                  Multi-Factor Payment Authorization
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setMfaTargetPayment(null)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleVerifyAndSettle(e)} className="mt-5 space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1">
                <p className="text-slate-500">Authorizing {mfaTargetPayment.paymentRail} Transfer</p>
                <p className="text-sm font-semibold text-slate-900">
                  {mfaTargetPayment.recipientName}
                </p>
                <p className="text-lg font-mono tabular-nums font-semibold text-slate-900">
                  {formatCurrency(mfaTargetPayment.amount)}
                </p>
              </div>

              <div className="p-4 border border-slate-200 rounded-lg space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>Active Authenticator Token (RFC-6238)</span>
                  <span className="font-mono tabular-nums">Refreshes in {secondsLeft}s</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xl font-mono font-semibold tracking-widest text-slate-900 tabular-nums">
                    {liveCode}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEnteredCode(liveCode)}
                    className="text-xs font-medium text-slate-700 underline hover:text-slate-900 cursor-pointer"
                  >
                    Fill Token
                  </button>
                </div>
              </div>

              {mfaError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {mfaError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Enter 6-Digit Verification Code
                </label>
                <input
                  type="text"
                  maxLength={6}
                  value={enteredCode}
                  onChange={(e) => setEnteredCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full px-3 py-2.5 text-center text-lg font-mono tracking-widest border border-slate-200 rounded-lg"
                  required
                />
              </div>

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setMfaTargetPayment(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={settling}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {settling ? 'Settling...' : 'Verify MFA & Settle'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Printable Statement Preview Modal */}
      {previewReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full p-8 my-8 space-y-6">
            <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <p className="text-xs font-medium text-slate-500">
                  Veridian Ledger Official Financial Statement
                </p>
                <h3 className="text-lg font-semibold text-slate-900 mt-1 font-display">
                  {previewReport.reportTitle}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">
                  Period {previewReport.reportPeriod} · Generated for {user?.email || 'Account Holder'}
                </p>
              </div>
              <div className="no-print flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print / Save PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewReport(null)}
                  className="p-1.5 text-slate-500 hover:text-slate-900"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 text-xs">
              <div className="p-4 border border-slate-200 rounded-lg">
                <span className="text-slate-500 block">Total Inflow</span>
                <span className="text-base font-mono font-semibold text-emerald-700 tabular-nums mt-1 block">
                  {formatCurrency(previewReport.totalInflow)}
                </span>
              </div>
              <div className="p-4 border border-slate-200 rounded-lg">
                <span className="text-slate-500 block">Total Outflow</span>
                <span className="text-base font-mono font-semibold text-slate-900 tabular-nums mt-1 block">
                  {formatCurrency(previewReport.totalOutflow)}
                </span>
              </div>
              <div className="p-4 border border-slate-200 rounded-lg">
                <span className="text-slate-500 block">Net Cash Flow</span>
                <span className="text-base font-mono font-semibold text-slate-900 tabular-nums mt-1 block">
                  {formatCurrency(previewReport.netCashFlow)}
                </span>
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Merchant</th>
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {transactions
                    .filter(
                      (tx) =>
                        tx.accountId === previewReport.accountId &&
                        (previewReport.reportPeriod.includes('YTD') ||
                          tx.occurredAt.startsWith(previewReport.reportPeriod)),
                    )
                    .map((tx) => (
                      <tr key={tx.id}>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                          {tx.occurredAt}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-slate-900">{tx.merchant}</td>
                        <td className="py-2.5 px-3 text-slate-600">{tx.category}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                          {tx.direction === 'credit' ? '+' : '-'}
                          {formatCurrency(tx.amount)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
