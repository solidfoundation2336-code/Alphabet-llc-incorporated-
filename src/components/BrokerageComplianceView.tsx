import { useMemo, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { Building2, CheckCircle2, Download, FileSpreadsheet, Pencil, Plus, ShieldAlert, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  REGULATORY_FRAMEWORKS,
  type BankAccount,
  type BrokerageFirm,
  type ComplianceStatus,
  type TaxDocument,
  type TaxFilingStatus,
  type TaxFormType,
} from '../types/finance';
import {
  csvEscape,
  downloadTextFile,
  formatCurrency,
  generateSafeId,
} from '../utils/formatters';

interface BrokerageComplianceViewProps {
  accounts: BankAccount[];
  firms: BrokerageFirm[];
  taxDocuments: TaxDocument[];
}

export function BrokerageComplianceView({
  accounts,
  firms,
  taxDocuments,
}: BrokerageComplianceViewProps) {
  const { user } = useAuth();

  // Add / Edit Brokerage Firm Modal
  const [firmModalOpen, setFirmModalOpen] = useState(false);
  const [editingFirm, setEditingFirm] = useState<BrokerageFirm | null>(null);
  const [firmName, setFirmName] = useState('');
  const [crdNumber, setCrdNumber] = useState('');
  const [secFileNumber, setSecFileNumber] = useState('8-70124');
  const [dtcParticipantNumber, setDtcParticipantNumber] = useState('');
  const [clearingHouse, setClearingHouse] = useState('DTCC / NSCC Clearing');
  const [complianceOfficer, setComplianceOfficer] = useState('');
  const [finraDistrict, setFinraDistrict] = useState('District 10 · New York');
  const [firmComplianceStatus, setFirmComplianceStatus] = useState<ComplianceStatus>('pending_review');
  const [selectedRegs, setSelectedRegs] = useState<string[]>([
    REGULATORY_FRAMEWORKS[0],
    REGULATORY_FRAMEWORKS[1],
    REGULATORY_FRAMEWORKS[5],
  ]);
  const [savingFirm, setSavingFirm] = useState(false);
  const [firmError, setFirmError] = useState<string | null>(null);

  // Add / Edit Tax Document Modal
  const [taxModalOpen, setTaxModalOpen] = useState(false);
  const [editingTaxDoc, setEditingTaxDoc] = useState<TaxDocument | null>(null);
  const [taxFirmId, setTaxFirmId] = useState(firms[0]?.id || '');
  const [taxAccountId, setTaxAccountId] = useState(accounts[0]?.id || '');
  const [formType, setFormType] = useState<TaxFormType>('1099-B');
  const [taxYear, setTaxYear] = useState('2026');
  const [grossProceeds, setGrossProceeds] = useState('84200');
  const [withheldTax, setWithheldTax] = useState('11250');
  const [savingTax, setSavingTax] = useState(false);
  const [taxError, setTaxError] = useState<string | null>(null);

  const firmLookup = useMemo(() => {
    const map = new Map<string, BrokerageFirm>();
    firms.forEach((f) => map.set(f.id, f));
    return map;
  }, [firms]);

  const accountLookup = useMemo(() => {
    const map = new Map<string, BankAccount>();
    accounts.forEach((a) => map.set(a.id, a));
    return map;
  }, [accounts]);

  const toggleRegulation = (reg: string) => {
    setSelectedRegs((prev) => {
      if (prev.includes(reg)) {
        return prev.length > 1 ? prev.filter((r) => r !== reg) : prev;
      }
      return prev.length < 10 ? [...prev, reg] : prev;
    });
  };

  const handleSaveFirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setFirmError(null);

    if (selectedRegs.length === 0) {
      setFirmError('Select at least one regulatory compliance framework.');
      return;
    }

    if (editingFirm) {
      setSavingFirm(true);
      try {
        await updateDoc(doc(db, 'brokerage_firms', editingFirm.id), {
          complianceOfficer: complianceOfficer.trim(),
          complianceStatus: firmComplianceStatus,
          regulations: selectedRegs,
          updatedAt: serverTimestamp(),
        });
        setEditingFirm(null);
        setFirmModalOpen(false);
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `brokerage_firms/${editingFirm.id}`);
      } finally {
        setSavingFirm(false);
      }
      return;
    }

    if (!/^[0-9]{4,16}$/.test(crdNumber)) {
      setFirmError('FINRA CRD Number must be 4 to 16 digits.');
      return;
    }
    if (!/^[0-9]{4,12}$/.test(dtcParticipantNumber)) {
      setFirmError('DTC Participant Number must be 4 to 12 digits.');
      return;
    }

    setSavingFirm(true);
    try {
      await addDoc(collection(db, 'brokerage_firms'), {
        ownerId: user.uid,
        firmName: firmName.trim(),
        crdNumber: crdNumber.trim(),
        secFileNumber: secFileNumber.trim(),
        dtcParticipantNumber: dtcParticipantNumber.trim(),
        clearingHouse: clearingHouse.trim(),
        complianceOfficer: complianceOfficer.trim(),
        finraDistrict: finraDistrict.trim(),
        complianceStatus: 'pending_review',
        regulations: selectedRegs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setFirmName('');
      setCrdNumber('');
      setDtcParticipantNumber('');
      setComplianceOfficer('');
      setFirmModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'brokerage_firms');
    } finally {
      setSavingFirm(false);
    }
  };

  const handleAdvanceFirmStatus = async (firm: BrokerageFirm) => {
    const nextStatus: ComplianceStatus =
      firm.complianceStatus === 'pending_review'
        ? 'registered'
        : firm.complianceStatus === 'registered'
          ? 'active'
          : 'active';
    try {
      await updateDoc(doc(db, 'brokerage_firms', firm.id), {
        complianceOfficer: firm.complianceOfficer,
        complianceStatus: nextStatus,
        regulations: firm.regulations,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `brokerage_firms/${firm.id}`);
    }
  };

  const handleSaveTaxDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setTaxError(null);

    const proceeds = Number.parseFloat(grossProceeds);
    const withheld = Number.parseFloat(withheldTax);
    if (!Number.isFinite(proceeds) || proceeds < 0 || !Number.isFinite(withheld) || withheld < 0) {
      setTaxError('Proceeds and withheld tax must be non-negative numbers.');
      return;
    }

    if (editingTaxDoc) {
      setSavingTax(true);
      try {
        await updateDoc(doc(db, 'tax_documents', editingTaxDoc.id), {
          filingStatus: editingTaxDoc.filingStatus,
          grossProceeds: Math.round(proceeds * 100) / 100,
          withheldTax: Math.round(withheld * 100) / 100,
          updatedAt: serverTimestamp(),
        });
        setEditingTaxDoc(null);
        setTaxModalOpen(false);
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `tax_documents/${editingTaxDoc.id}`);
      } finally {
        setSavingTax(false);
      }
      return;
    }

    const fId = taxFirmId || firms[0]?.id;
    const aId = taxAccountId || accounts[0]?.id;
    if (!fId || !aId) {
      setTaxError('Both a registered brokerage firm and a bank account are required.');
      return;
    }

    const yearInt = Number.parseInt(taxYear, 10);
    if (!Number.isInteger(yearInt) || yearInt < 2015 || yearInt > 2035) {
      setTaxError('Tax year must be between 2015 and 2035.');
      return;
    }

    setSavingTax(true);
    try {
      await addDoc(collection(db, 'tax_documents'), {
        ownerId: user.uid,
        firmId: fId,
        accountId: aId,
        formType,
        taxYear: yearInt,
        filingStatus: 'ready',
        grossProceeds: Math.round(proceeds * 100) / 100,
        withheldTax: Math.round(withheld * 100) / 100,
        referenceCode: generateSafeId('TAX'),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setTaxModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'tax_documents');
    } finally {
      setSavingTax(false);
    }
  };

  const handleAdvanceTaxFiling = async (docItem: TaxDocument) => {
    const nextStatus: TaxFilingStatus = docItem.filingStatus === 'draft' ? 'ready' : 'filed';
    try {
      await updateDoc(doc(db, 'tax_documents', docItem.id), {
        filingStatus: nextStatus,
        grossProceeds: docItem.grossProceeds,
        withheldTax: docItem.withheldTax,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `tax_documents/${docItem.id}`);
    }
  };

  const handleDownloadTaxDoc = (docItem: TaxDocument) => {
    const firm = firmLookup.get(docItem.firmId);
    const acc = accountLookup.get(docItem.accountId);
    const rows = [
      'Reference Code,Form Type,Tax Year,Brokerage Firm,CRD Number,Account,Gross Proceeds,Withheld Tax,Filing Status',
      [
        csvEscape(docItem.referenceCode),
        csvEscape(docItem.formType),
        csvEscape(docItem.taxYear),
        csvEscape(firm ? firm.firmName : docItem.firmId),
        csvEscape(firm ? firm.crdNumber : ''),
        csvEscape(acc ? `${acc.accountName} (${acc.accountMask})` : docItem.accountId),
        csvEscape(docItem.grossProceeds.toFixed(2)),
        csvEscape(docItem.withheldTax.toFixed(2)),
        csvEscape(docItem.filingStatus),
      ].join(','),
    ];
    downloadTextFile(`${docItem.formType}-${docItem.taxYear}-${docItem.referenceCode}.csv`, rows.join('\n'));
  };

  const handleDownloadTaxJson = (docItem: TaxDocument) => {
    const firm = firmLookup.get(docItem.firmId);
    const acc = accountLookup.get(docItem.accountId);
    const payload = {
      schema: 'veridian-tax-filing-v1',
      exportedAt: new Date().toISOString(),
      document: {
        referenceCode: docItem.referenceCode,
        formType: docItem.formType,
        taxYear: docItem.taxYear,
        filingStatus: docItem.filingStatus,
        grossProceeds: docItem.grossProceeds,
        withheldTax: docItem.withheldTax,
      },
      brokerageFirm: firm
        ? {
            firmName: firm.firmName,
            crdNumber: firm.crdNumber,
            secFileNumber: firm.secFileNumber,
            dtcParticipantNumber: firm.dtcParticipantNumber,
            regulations: firm.regulations,
          }
        : null,
      account: acc
        ? {
            accountName: acc.accountName,
            institutionName: acc.institutionName,
            accountMask: acc.accountMask,
          }
        : null,
    };
    downloadTextFile(
      `${docItem.formType}-${docItem.taxYear}-${docItem.referenceCode}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8;',
    );
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 font-display">
            Brokerage Firms, Regulatory Compliance &amp; Tax Reporting
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Register broker-dealer firms with FINRA/SEC/DTCC identifiers and manage 1099-B, W-9,
            and Schedule-D tax filings.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={firms.length === 0 || accounts.length === 0}
            onClick={() => {
              setEditingTaxDoc(null);
              setTaxFirmId(firms[0]?.id || '');
              setTaxAccountId(accounts[0]?.id || '');
              setTaxError(null);
              setTaxModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Generate Tax Form</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingFirm(null);
              setFirmName('');
              setCrdNumber('');
              setDtcParticipantNumber('');
              setComplianceOfficer('');
              setFirmComplianceStatus('pending_review');
              setFirmError(null);
              setFirmModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Brokerage Firm</span>
          </button>
        </div>
      </div>

      {/* Brokerage Firms & Regulatory Compliance Grid */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-slate-900 font-display">
          Registered Brokerage &amp; Clearing Firms ({firms.length})
        </h3>
        {firms.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
            No brokerage firms registered yet. Add a firm to track FINRA/SEC compliance and tax
            filings.
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {firms.map((firm) => (
              <div
                key={firm.id}
                className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-5"
              >
                <div>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <Building2 className="w-5 h-5 text-slate-700 mt-0.5 shrink-0" />
                      <div>
                        <h4 className="text-base font-semibold text-slate-900 font-display">
                          {firm.firmName}
                        </h4>
                        <p className="text-xs font-mono text-slate-500 mt-0.5">
                          CRD {firm.crdNumber} · SEC {firm.secFileNumber} · DTC #
                          {firm.dtcParticipantNumber}
                        </p>
                      </div>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap ${
                        firm.complianceStatus === 'active'
                          ? 'text-emerald-700'
                          : firm.complianceStatus === 'registered'
                            ? 'text-slate-900'
                            : 'text-amber-700'
                      }`}
                    >
                      {firm.complianceStatus === 'active' ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <ShieldAlert className="w-3.5 h-3.5" />
                      )}
                      <span className="capitalize">{firm.complianceStatus.replace('_', ' ')}</span>
                    </span>
                  </div>

                  <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-slate-500 block">Clearing House</span>
                      <span className="text-slate-900 font-medium">{firm.clearingHouse}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Compliance Officer</span>
                      <span className="text-slate-900 font-medium">{firm.complianceOfficer}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-slate-500 block">Registered Regulatory Mandates</span>
                      <p className="text-slate-700 mt-1 leading-relaxed">
                        {firm.regulations.join(' · ')}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-500">{firm.finraDistrict}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingFirm(firm);
                        setFirmName(firm.firmName);
                        setCrdNumber(firm.crdNumber);
                        setSecFileNumber(firm.secFileNumber);
                        setDtcParticipantNumber(firm.dtcParticipantNumber);
                        setClearingHouse(firm.clearingHouse);
                        setComplianceOfficer(firm.complianceOfficer);
                        setFinraDistrict(firm.finraDistrict);
                        setFirmComplianceStatus(firm.complianceStatus);
                        setSelectedRegs(firm.regulations);
                        setFirmError(null);
                        setFirmModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>Edit Compliance</span>
                    </button>
                    {firm.complianceStatus !== 'active' && (
                      <button
                        type="button"
                        onClick={() => void handleAdvanceFirmStatus(firm)}
                        className="px-3 py-1.5 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                      >
                        {firm.complianceStatus === 'pending_review'
                          ? 'Mark Registered'
                          : 'Activate Compliance'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Tax Reporting Documentation Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              Tax Reporting Documentation &amp; Regulatory Filings
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              1099-B, 1099-DIV, W-9, and Schedule-D records tied to registered brokerage firms
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="py-3 px-4">Reference &amp; Form</th>
                <th className="py-3 px-4">Brokerage Firm</th>
                <th className="py-3 px-4">Account</th>
                <th className="py-3 px-4 text-right">Gross Proceeds</th>
                <th className="py-3 px-4 text-right">Withheld Tax</th>
                <th className="py-3 px-4">Filing Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {taxDocuments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-xs text-slate-500">
                    No tax reporting documents generated yet.
                  </td>
                </tr>
              ) : (
                taxDocuments.map((docItem) => {
                  const firm = firmLookup.get(docItem.firmId);
                  const acc = accountLookup.get(docItem.accountId);
                  return (
                    <tr key={docItem.id}>
                      <td className="py-3 px-4">
                        <p className="font-medium text-slate-900">
                          Form {docItem.formType} · {docItem.taxYear}
                        </p>
                        <p className="text-xs font-mono text-slate-500">{docItem.referenceCode}</p>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700">
                        {firm ? `${firm.firmName} (CRD ${firm.crdNumber})` : docItem.firmId}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        {acc ? `${acc.accountName} (•••• ${acc.accountMask})` : docItem.accountId}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                        {formatCurrency(docItem.grossProceeds)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {formatCurrency(docItem.withheldTax)}
                      </td>
                      <td className="py-3 px-4 text-xs font-medium capitalize">
                        <span
                          className={
                            docItem.filingStatus === 'filed'
                              ? 'text-emerald-700'
                              : docItem.filingStatus === 'ready'
                                ? 'text-slate-900'
                                : 'text-amber-700'
                          }
                        >
                          {docItem.filingStatus}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          {docItem.filingStatus !== 'filed' && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingTaxDoc(docItem);
                                  setGrossProceeds(String(docItem.grossProceeds));
                                  setWithheldTax(String(docItem.withheldTax));
                                  setTaxError(null);
                                  setTaxModalOpen(true);
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                              >
                                <Pencil className="w-3 h-3" />
                                <span>Edit</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleAdvanceTaxFiling(docItem)}
                                className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                              >
                                {docItem.filingStatus === 'draft' ? 'Mark Ready' : 'File with IRS'}
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDownloadTaxDoc(docItem)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>CSV</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDownloadTaxJson(docItem)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-900 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>JSON</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Add / Edit Brokerage Firm Modal */}
      {firmModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 my-8">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingFirm
                  ? `Update Compliance · ${editingFirm.firmName}`
                  : 'Register Brokerage Firm & Compliance Profile'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setEditingFirm(null);
                  setFirmModalOpen(false);
                }}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveFirm(e)} className="mt-5 space-y-4">
              {firmError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {firmError}
                </div>
              )}
              {!editingFirm && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Brokerage Firm Legal Name
                    </label>
                    <input
                      type="text"
                      value={firmName}
                      onChange={(e) => setFirmName(e.target.value)}
                      placeholder="Summit Institutional Securities Corp."
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        CRD Number
                      </label>
                      <input
                        type="text"
                        value={crdNumber}
                        onChange={(e) => setCrdNumber(e.target.value.replace(/\D/g, ''))}
                        placeholder="319420"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        SEC File #
                      </label>
                      <input
                        type="text"
                        value={secFileNumber}
                        onChange={(e) => setSecFileNumber(e.target.value)}
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        DTC Participant #
                      </label>
                      <input
                        type="text"
                        value={dtcParticipantNumber}
                        onChange={(e) => setDtcParticipantNumber(e.target.value.replace(/\D/g, ''))}
                        placeholder="0528"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                        required
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="grid grid-cols-2 gap-3">
                {editingFirm ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Compliance Status
                    </label>
                    <select
                      value={firmComplianceStatus}
                      onChange={(e) =>
                        setFirmComplianceStatus(e.target.value as ComplianceStatus)
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                    >
                      <option value="pending_review">Pending Review</option>
                      <option value="registered">Registered</option>
                      <option value="active">Active</option>
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Clearing House
                    </label>
                    <input
                      type="text"
                      value={clearingHouse}
                      onChange={(e) => setClearingHouse(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                      required
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Chief Compliance Officer
                  </label>
                  <input
                    type="text"
                    value={complianceOfficer}
                    onChange={(e) => setComplianceOfficer(e.target.value)}
                    placeholder="Marcus Sterling, CCO"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>
              </div>
              {!editingFirm && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    FINRA District
                  </label>
                  <input
                    type="text"
                    value={finraDistrict}
                    onChange={(e) => setFinraDistrict(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-2">
                  Regulatory Compliance Frameworks ({selectedRegs.length}/10)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {REGULATORY_FRAMEWORKS.map((reg) => (
                    <label
                      key={reg}
                      className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedRegs.includes(reg)}
                        onChange={() => toggleRegulation(reg)}
                        className="mt-0.5"
                      />
                      <span>{reg}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="pt-3 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditingFirm(null);
                    setFirmModalOpen(false);
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingFirm}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingFirm ? 'Saving...' : editingFirm ? 'Save Compliance' : 'Register Firm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Generate / Edit Tax Form Modal */}
      {taxModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingTaxDoc
                  ? `Update Tax Figures · ${editingTaxDoc.formType} (${editingTaxDoc.taxYear})`
                  : 'Generate Tax Reporting Document'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setEditingTaxDoc(null);
                  setTaxModalOpen(false);
                }}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveTaxDoc(e)} className="mt-5 space-y-4">
              {taxError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {taxError}
                </div>
              )}
              {!editingTaxDoc && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Brokerage Firm
                    </label>
                    <select
                      value={taxFirmId || firms[0]?.id || ''}
                      onChange={(e) => setTaxFirmId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                    >
                      {firms.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.firmName} (CRD {f.crdNumber})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Linked Bank / Custody Account
                    </label>
                    <select
                      value={taxAccountId || accounts[0]?.id || ''}
                      onChange={(e) => setTaxAccountId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
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
                        IRS / Tax Form
                      </label>
                      <select
                        value={formType}
                        onChange={(e) => setFormType(e.target.value as TaxFormType)}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                      >
                        <option value="1099-B">1099-B (Broker Proceeds)</option>
                        <option value="1099-DIV">1099-DIV (Dividends)</option>
                        <option value="1099-INT">1099-INT (Interest)</option>
                        <option value="W-9">W-9 (TIN Certification)</option>
                        <option value="W-8BEN">W-8BEN (Foreign Status)</option>
                        <option value="Schedule-D">Schedule-D (Capital Gains)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Tax Year
                      </label>
                      <input
                        type="number"
                        min="2015"
                        max="2035"
                        value={taxYear}
                        onChange={(e) => setTaxYear(e.target.value)}
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                        required
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Gross Proceeds (USD)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={grossProceeds}
                    onChange={(e) => setGrossProceeds(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Withheld Tax (USD)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={withheldTax}
                    onChange={(e) => setWithheldTax(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
              </div>
              <div className="pt-3 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditingTaxDoc(null);
                    setTaxModalOpen(false);
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTax}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingTax
                    ? 'Saving...'
                    : editingTaxDoc
                      ? 'Save Tax Figures'
                      : 'Create Tax Document'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
