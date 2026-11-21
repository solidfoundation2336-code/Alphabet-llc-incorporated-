import { useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import {
  BriefcaseBusiness,
  Check,
  Copy,
  Download,
  Edit3,
  Globe,
  Landmark,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  COMPANY_ENTITY_META,
  PUBLIC_ISSUER_META,
  type BankAccount,
  type CompanyAccount,
  type CompanyAccountStatus,
  type CompanyEntityType,
  type PublicAccount,
  type PublicAccountStatus,
  type PublicAccountVisibility,
  type PublicIssuerType,
} from '../types/finance';
import { csvEscape, downloadTextFile, formatCompactCurrency, formatCurrency } from '../utils/formatters';

interface PublicCompanyAccountsViewProps {
  accounts: BankAccount[];
  companyAccounts: CompanyAccount[];
  publicAccounts: PublicAccount[];
}

type SubView = 'company' | 'public' | 'bank';

const ENTITY_TYPES = Object.keys(COMPANY_ENTITY_META) as CompanyEntityType[];
const ISSUER_TYPES = Object.keys(PUBLIC_ISSUER_META) as PublicIssuerType[];

export function PublicCompanyAccountsView({
  accounts,
  companyAccounts,
  publicAccounts,
}: PublicCompanyAccountsViewProps) {
  const { user } = useAuth();
  const [subView, setSubView] = useState<SubView>('company');

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // --- Company Accounts State ---
  const [companySearch, setCompanySearch] = useState('');
  const [entityFilter, setEntityFilter] = useState<string>('ALL');
  const [companyModalOpen, setCompanyModalOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<CompanyAccount | null>(null);
  const [companyForm, setCompanyForm] = useState<{
    linkedAccountId: string;
    companyName: string;
    entityType: CompanyEntityType;
    einLast4: string;
    jurisdiction: string;
    industrySector: string;
    authorizedSignersCount: string;
    creditFacilityLimit: string;
    operatingBalance: string;
    dualApprovalRequired: boolean;
    status: CompanyAccountStatus;
  }>({
    linkedAccountId: accounts[0]?.id || '',
    companyName: '',
    entityType: 'llc',
    einLast4: '4820',
    jurisdiction: 'United States · Delaware',
    industrySector: 'Financial Technology & Treasury',
    authorizedSignersCount: '2',
    creditFacilityLimit: '2500000',
    operatingBalance: '150000',
    dualApprovalRequired: true,
    status: 'active',
  });
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [savingCompany, setSavingCompany] = useState(false);

  // --- Public Accounts State ---
  const [publicSearch, setPublicSearch] = useState('');
  const [issuerFilter, setIssuerFilter] = useState<string>('ALL');
  const [publicScope, setPublicScope] = useState<'all' | 'owned' | 'directory'>('all');
  const [copiedHandleId, setCopiedHandleId] = useState<string | null>(null);
  const [publicModalOpen, setPublicModalOpen] = useState(false);
  const [editingPublic, setEditingPublic] = useState<PublicAccount | null>(null);
  const [publicForm, setPublicForm] = useState<{
    linkedAccountId: string;
    publicHandle: string;
    displayTitle: string;
    issuerType: PublicIssuerType;
    publicTickerOrLei: string;
    disclosedReserveUsd: string;
    transparencyStandard: string;
    visibility: PublicAccountVisibility;
    allowInboundTransfers: boolean;
    status: PublicAccountStatus;
  }>({
    linkedAccountId: accounts[0]?.id || '',
    publicHandle: '',
    displayTitle: '',
    issuerType: 'public_corporation',
    publicTickerOrLei: '',
    disclosedReserveUsd: '250000',
    transparencyStandard: 'SEC Form 10-Q · Proof of Reserve',
    visibility: 'public_directory',
    allowInboundTransfers: true,
    status: 'published',
  });
  const [publicError, setPublicError] = useState<string | null>(null);
  const [savingPublic, setSavingPublic] = useState(false);

  // --- Quick Link Public/Company Bank Account Modal ---
  const [bankLinkModalOpen, setBankLinkModalOpen] = useState(false);
  const [bankLinkType, setBankLinkType] = useState<'company' | 'public'>('company');
  const [bankLinkName, setBankLinkName] = useState('');
  const [bankLinkInst, setBankLinkInst] = useState('');
  const [bankLinkMask, setBankLinkMask] = useState('');
  const [bankLinkBalance, setBankLinkBalance] = useState('100000');
  const [bankLinkError, setBankLinkError] = useState<string | null>(null);
  const [savingBankLink, setSavingBankLink] = useState(false);

  // =========================================================================
  // COMPUTED SUMMARIES & FILTERS
  // =========================================================================
  const filteredCompanies = useMemo(() => {
    const q = companySearch.trim().toLowerCase();
    return companyAccounts.filter((c) => {
      if (entityFilter !== 'ALL' && c.entityType !== entityFilter) return false;
      if (!q) return true;
      return (
        c.companyName.toLowerCase().includes(q) ||
        c.jurisdiction.toLowerCase().includes(q) ||
        c.industrySector.toLowerCase().includes(q) ||
        c.einLast4.includes(q)
      );
    });
  }, [companyAccounts, companySearch, entityFilter]);

  const companyTotals = useMemo(() => {
    const active = companyAccounts.filter((c) => c.status === 'active');
    return {
      activeCount: active.length,
      operatingSum: companyAccounts
        .filter((c) => c.status !== 'dissolved')
        .reduce((s, c) => s + c.operatingBalance, 0),
      creditSum: companyAccounts
        .filter((c) => c.status !== 'dissolved')
        .reduce((s, c) => s + c.creditFacilityLimit, 0),
      dualControlCount: companyAccounts.filter((c) => c.dualApprovalRequired).length,
    };
  }, [companyAccounts]);

  const filteredPublicAccounts = useMemo(() => {
    const q = publicSearch.trim().toLowerCase();
    return publicAccounts.filter((p) => {
      if (publicScope === 'owned' && p.ownerId !== user?.uid) return false;
      if (publicScope === 'directory' && !(p.visibility === 'public_directory' && p.status === 'published')) {
        return false;
      }
      if (issuerFilter !== 'ALL' && p.issuerType !== issuerFilter) return false;
      if (!q) return true;
      return (
        p.displayTitle.toLowerCase().includes(q) ||
        p.publicHandle.toLowerCase().includes(q) ||
        p.publicTickerOrLei.toLowerCase().includes(q) ||
        p.transparencyStandard.toLowerCase().includes(q)
      );
    });
  }, [publicAccounts, publicScope, issuerFilter, publicSearch, user?.uid]);

  const publicTotals = useMemo(() => {
    const published = publicAccounts.filter((p) => p.status === 'published');
    return {
      publishedCount: published.length,
      directoryCount: published.filter((p) => p.visibility === 'public_directory').length,
      disclosedReserveSum: published.reduce((s, p) => s + p.disclosedReserveUsd, 0),
      inboundCount: published.filter((p) => p.allowInboundTransfers).length,
    };
  }, [publicAccounts]);

  const entityBankAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === 'company' || a.accountType === 'public'),
    [accounts],
  );

  // =========================================================================
  // COMPANY ACCOUNT HANDLERS
  // =========================================================================
  const openNewCompanyModal = () => {
    setEditingCompany(null);
    setCompanyForm({
      linkedAccountId: accounts[0]?.id || '',
      companyName: '',
      entityType: 'llc',
      einLast4: '4820',
      jurisdiction: 'United States · Delaware',
      industrySector: 'Financial Technology & Treasury',
      authorizedSignersCount: '2',
      creditFacilityLimit: '2500000',
      operatingBalance: '150000',
      dualApprovalRequired: true,
      status: 'active',
    });
    setCompanyError(null);
    setCompanyModalOpen(true);
  };

  const openEditCompanyModal = (item: CompanyAccount) => {
    setEditingCompany(item);
    setCompanyForm({
      linkedAccountId: item.linkedAccountId,
      companyName: item.companyName,
      entityType: item.entityType,
      einLast4: item.einLast4,
      jurisdiction: item.jurisdiction,
      industrySector: item.industrySector,
      authorizedSignersCount: String(item.authorizedSignersCount),
      creditFacilityLimit: String(item.creditFacilityLimit),
      operatingBalance: String(item.operatingBalance),
      dualApprovalRequired: item.dualApprovalRequired,
      status: item.status,
    });
    setCompanyError(null);
    setCompanyModalOpen(true);
  };

  const handleSaveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setCompanyError(null);

    if (!companyForm.linkedAccountId) {
      setCompanyError('Select a linked settlement bank account.');
      return;
    }
    if (companyForm.companyName.trim().length < 2) {
      setCompanyError('Company legal name must be at least 2 characters.');
      return;
    }
    if (!/^[0-9]{4}$/.test(companyForm.einLast4)) {
      setCompanyError('EIN / Tax Registration last 4 must be exactly 4 digits.');
      return;
    }
    const signers = Number.parseInt(companyForm.authorizedSignersCount, 10);
    const credit = Number(companyForm.creditFacilityLimit);
    const balance = Number(companyForm.operatingBalance);
    if (!Number.isInteger(signers) || signers < 1 || signers > 50) {
      setCompanyError('Authorized signers must be an integer between 1 and 50.');
      return;
    }
    if (!Number.isFinite(credit) || credit < 0) {
      setCompanyError('Credit facility limit must be zero or greater.');
      return;
    }
    if (!Number.isFinite(balance) || balance < -100000000) {
      setCompanyError('Enter a valid operating balance.');
      return;
    }

    setSavingCompany(true);
    try {
      const payload = {
        linkedAccountId: companyForm.linkedAccountId,
        companyName: companyForm.companyName.trim().slice(0, 140),
        entityType: companyForm.entityType,
        einLast4: companyForm.einLast4,
        jurisdiction: companyForm.jurisdiction.trim().slice(0, 80),
        industrySector: companyForm.industrySector.trim().slice(0, 80),
        authorizedSignersCount: signers,
        creditFacilityLimit: credit,
        operatingBalance: balance,
        dualApprovalRequired: companyForm.dualApprovalRequired,
        status: companyForm.status,
        updatedAt: serverTimestamp(),
      };

      if (editingCompany) {
        await updateDoc(doc(db, 'company_accounts', editingCompany.id), payload);
      } else {
        await addDoc(collection(db, 'company_accounts'), {
          ownerId: user.uid,
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      setCompanyModalOpen(false);
    } catch (error) {
      handleFirestoreError(
        error,
        editingCompany ? OperationType.UPDATE : OperationType.CREATE,
        'company_accounts',
      );
    } finally {
      setSavingCompany(false);
    }
  };

  const handleToggleCompanyHold = async (item: CompanyAccount) => {
    if (item.status === 'dissolved') return;
    const nextStatus: CompanyAccountStatus = item.status === 'active' ? 'audit_hold' : 'active';
    try {
      await updateDoc(doc(db, 'company_accounts', item.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `company_accounts/${item.id}`);
    }
  };

  const handleDeleteCompany = async (item: CompanyAccount) => {
    if (item.status === 'dissolved') return;
    try {
      await deleteDoc(doc(db, 'company_accounts', item.id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `company_accounts/${item.id}`);
    }
  };

  const exportCompaniesCsv = () => {
    const headers = [
      'Company Name',
      'Entity Type',
      'EIN Last 4',
      'Jurisdiction',
      'Industry Sector',
      'Linked Bank Account',
      'Authorized Signers',
      'Dual Approval',
      'Operating Balance',
      'Credit Facility Limit',
      'Status',
    ];
    const rows = filteredCompanies.map((c) =>
      [
        c.companyName,
        COMPANY_ENTITY_META[c.entityType].label,
        c.einLast4,
        c.jurisdiction,
        c.industrySector,
        accountMap.get(c.linkedAccountId)?.accountName || c.linkedAccountId,
        c.authorizedSignersCount,
        c.dualApprovalRequired,
        c.operatingBalance,
        c.creditFacilityLimit,
        c.status,
      ]
        .map(csvEscape)
        .join(','),
    );
    downloadTextFile('veridian-company-accounts.csv', [headers.join(','), ...rows].join('\n'));
  };

  // =========================================================================
  // PUBLIC ACCOUNT HANDLERS
  // =========================================================================
  const openNewPublicModal = () => {
    setEditingPublic(null);
    setPublicForm({
      linkedAccountId: accounts[0]?.id || '',
      publicHandle: '',
      displayTitle: '',
      issuerType: 'public_corporation',
      publicTickerOrLei: '',
      disclosedReserveUsd: '250000',
      transparencyStandard: 'SEC Form 10-Q · Proof of Reserve',
      visibility: 'public_directory',
      allowInboundTransfers: true,
      status: 'published',
    });
    setPublicError(null);
    setPublicModalOpen(true);
  };

  const openEditPublicModal = (item: PublicAccount) => {
    setEditingPublic(item);
    setPublicForm({
      linkedAccountId: item.linkedAccountId,
      publicHandle: item.publicHandle,
      displayTitle: item.displayTitle,
      issuerType: item.issuerType,
      publicTickerOrLei: item.publicTickerOrLei,
      disclosedReserveUsd: String(item.disclosedReserveUsd),
      transparencyStandard: item.transparencyStandard,
      visibility: item.visibility,
      allowInboundTransfers: item.allowInboundTransfers,
      status: item.status,
    });
    setPublicError(null);
    setPublicModalOpen(true);
  };

  const handleSavePublic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setPublicError(null);

    if (!publicForm.linkedAccountId) {
      setPublicError('Select a linked settlement bank account.');
      return;
    }
    const handleClean = publicForm.publicHandle.trim().toLowerCase();
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(handleClean)) {
      setPublicError(
        'Public handle must be 3–40 characters using letters, numbers, dots, underscores, or hyphens.',
      );
      return;
    }
    if (publicForm.displayTitle.trim().length < 2) {
      setPublicError('Public display title must be at least 2 characters.');
      return;
    }
    if (publicForm.publicTickerOrLei.trim().length < 2) {
      setPublicError('Ticker / LEI identifier must be at least 2 characters.');
      return;
    }
    const reserve = Number(publicForm.disclosedReserveUsd);
    if (!Number.isFinite(reserve) || reserve < 0) {
      setPublicError('Disclosed reserve must be zero or greater.');
      return;
    }

    setSavingPublic(true);
    try {
      const payload = {
        linkedAccountId: publicForm.linkedAccountId,
        publicHandle: handleClean,
        displayTitle: publicForm.displayTitle.trim().slice(0, 140),
        issuerType: publicForm.issuerType,
        publicTickerOrLei: publicForm.publicTickerOrLei.trim().slice(0, 32),
        disclosedReserveUsd: reserve,
        transparencyStandard: publicForm.transparencyStandard.trim().slice(0, 80),
        visibility: publicForm.visibility,
        allowInboundTransfers: publicForm.allowInboundTransfers,
        status: publicForm.status,
        updatedAt: serverTimestamp(),
      };

      if (editingPublic) {
        await updateDoc(doc(db, 'public_accounts', editingPublic.id), payload);
      } else {
        await addDoc(collection(db, 'public_accounts'), {
          ownerId: user.uid,
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      setPublicModalOpen(false);
    } catch (error) {
      handleFirestoreError(
        error,
        editingPublic ? OperationType.UPDATE : OperationType.CREATE,
        'public_accounts',
      );
    } finally {
      setSavingPublic(false);
    }
  };

  const handleTogglePublicVisibility = async (item: PublicAccount) => {
    if (item.ownerId !== user?.uid || item.status === 'archived') return;
    const nextVis: PublicAccountVisibility =
      item.visibility === 'public_directory' ? 'unlisted' : 'public_directory';
    try {
      await updateDoc(doc(db, 'public_accounts', item.id), {
        status: item.status,
        visibility: nextVis,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `public_accounts/${item.id}`);
    }
  };

  const handleDeletePublic = async (item: PublicAccount) => {
    if (item.ownerId !== user?.uid || item.status === 'archived') return;
    try {
      await deleteDoc(doc(db, 'public_accounts', item.id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `public_accounts/${item.id}`);
    }
  };

  const exportPublicCsv = () => {
    const headers = [
      'Public Handle',
      'Display Title',
      'Issuer Type',
      'Ticker / LEI',
      'Disclosed Reserve USD',
      'Transparency Standard',
      'Visibility',
      'Inbound Transfers',
      'Status',
    ];
    const rows = filteredPublicAccounts.map((p) =>
      [
        p.publicHandle,
        p.displayTitle,
        PUBLIC_ISSUER_META[p.issuerType].label,
        p.publicTickerOrLei,
        p.disclosedReserveUsd,
        p.transparencyStandard,
        p.visibility,
        p.allowInboundTransfers,
        p.status,
      ]
        .map(csvEscape)
        .join(','),
    );
    downloadTextFile('veridian-public-accounts.csv', [headers.join(','), ...rows].join('\n'));
  };

  // =========================================================================
  // LINK PUBLIC / COMPANY BANK ACCOUNT HANDLER
  // =========================================================================
  const handleCreateEntityBankAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBankLinkError(null);

    if (bankLinkName.trim().length < 2 || bankLinkInst.trim().length < 2) {
      setBankLinkError('Account name and institution name must be at least 2 characters.');
      return;
    }
    if (!/^[0-9]{4}$/.test(bankLinkMask)) {
      setBankLinkError('Last 4 digits must be exactly 4 numeric digits.');
      return;
    }
    const bal = Number(bankLinkBalance);
    if (!Number.isFinite(bal)) {
      setBankLinkError('Enter a valid opening balance.');
      return;
    }

    setSavingBankLink(true);
    try {
      await addDoc(collection(db, 'bank_accounts'), {
        ownerId: user.uid,
        accountName: bankLinkName.trim().slice(0, 100),
        institutionName: bankLinkInst.trim().slice(0, 100),
        accountType: bankLinkType,
        accountMask: bankLinkMask,
        currency: 'USD',
        balance: Math.round(bal * 100) / 100,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setBankLinkName('');
      setBankLinkInst('');
      setBankLinkMask('');
      setBankLinkModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'bank_accounts');
    } finally {
      setSavingBankLink(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Sub-Navigation Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'company', label: 'Company Accounts', icon: BriefcaseBusiness },
              { id: 'public', label: 'Public Accounts & Directory', icon: Globe },
              { id: 'bank', label: 'Public & Company Cash Accounts', icon: Landmark },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = subView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSubView(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="px-2 text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
          {companyAccounts.length} Company · {publicAccounts.length} Public ·{' '}
          {entityBankAccounts.length} Entity Cash
        </div>
      </div>

      {/* =================================================================== */}
      {/* TAB 1: COMPANY ACCOUNTS                                             */}
      {/* =================================================================== */}
      {subView === 'company' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Active Company Entities</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {companyTotals.activeCount}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                of {companyAccounts.length} corporate accounts
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Corporate Operating Liquidity</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCurrency(companyTotals.operatingSum)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Across non-dissolved entities</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Aggregate Credit Facilities</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCompactCurrency(companyTotals.creditSum)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Committed corporate lines</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Dual-Control Governance</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {companyTotals.dualControlCount} / {companyAccounts.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Multi-signer treasury enforcement</p>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={companySearch}
                  onChange={(e) => setCompanySearch(e.target.value)}
                  placeholder="Search company, EIN, jurisdiction..."
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg w-60"
                />
                <select
                  value={entityFilter}
                  onChange={(e) => setEntityFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="ALL">All Entity Structures</option>
                  {ENTITY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {COMPANY_ENTITY_META[t].label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={exportCompaniesCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV</span>
                </button>
                <button
                  type="button"
                  onClick={openNewCompanyModal}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Company Account</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-3 px-4">Company &amp; Tax Form</th>
                    <th className="py-3 px-4">Structure &amp; EIN</th>
                    <th className="py-3 px-4">Jurisdiction &amp; Settlement</th>
                    <th className="py-3 px-4">Governance</th>
                    <th className="py-3 px-4 text-right">Balance &amp; Credit Line</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {filteredCompanies.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        No company accounts found. Add a corporate entity account to manage treasury signers and limits.
                      </td>
                    </tr>
                  ) : (
                    filteredCompanies.map((item) => {
                      const linked = accountMap.get(item.linkedAccountId);
                      const isLocked = item.status === 'dissolved';
                      return (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-900">{item.companyName}</p>
                            <p className="text-[11px] text-slate-500">
                              {item.industrySector} · {COMPANY_ENTITY_META[item.entityType].taxForm}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-slate-900">{COMPANY_ENTITY_META[item.entityType].label}</p>
                            <p className="text-[11px] font-mono text-slate-500">
                              EIN ····{item.einLast4}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-slate-900">{item.jurisdiction}</p>
                            <p className="text-[11px] text-slate-500">
                              {linked
                                ? `${linked.accountName} (····${linked.accountMask})`
                                : item.linkedAccountId}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-mono text-slate-900 tabular-nums">
                              {item.authorizedSignersCount} Authorized Signer
                              {item.authorizedSignersCount === 1 ? '' : 's'}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {item.dualApprovalRequired ? 'Dual-Control Required' : 'Single Signer'}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            <p className="font-medium text-slate-900">
                              {formatCurrency(item.operatingBalance)}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              Credit {formatCompactCurrency(item.creditFacilityLimit)}
                            </p>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <button
                              type="button"
                              disabled={isLocked}
                              onClick={() => void handleToggleCompanyHold(item)}
                              title={isLocked ? 'Dissolved entities are immutable' : 'Click to toggle active / audit hold'}
                              className={`font-medium ${
                                isLocked
                                  ? 'text-slate-400 cursor-not-allowed'
                                  : item.status === 'active'
                                    ? 'text-emerald-700 cursor-pointer'
                                    : 'text-amber-700 cursor-pointer'
                              }`}
                            >
                              {item.status.replace('_', ' ').toUpperCase()}
                            </button>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                disabled={isLocked}
                                onClick={() => openEditCompanyModal(item)}
                                title="Edit company account"
                                className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer disabled:opacity-40"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={isLocked}
                                onClick={() => void handleDeleteCompany(item)}
                                title="Delete company account"
                                className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded cursor-pointer disabled:opacity-40"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
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
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* TAB 2: PUBLIC ACCOUNTS & DIRECTORY                                  */}
      {/* =================================================================== */}
      {subView === 'public' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Published Public Accounts</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {publicTotals.publishedCount}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {publicTotals.directoryCount} listed in public directory
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Disclosed Public Reserves</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCurrency(publicTotals.disclosedReserveSum)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Zero-PII attested treasury balances</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Inbound-Enabled Endpoints</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {publicTotals.inboundCount}
              </p>
              <p className="mt-1 text-xs text-slate-500">Accepting public routing handles</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">My Public Profiles</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {publicAccounts.filter((p) => p.ownerId === user?.uid).length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Owner-managed public accounts</p>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {(
                    [
                      { id: 'all', label: 'All Visible' },
                      { id: 'owned', label: 'Owned by Me' },
                      { id: 'directory', label: 'Public Directory' },
                    ] as const
                  ).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setPublicScope(s.id)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap ${
                        publicScope === s.id
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                <input
                  type="text"
                  value={publicSearch}
                  onChange={(e) => setPublicSearch(e.target.value)}
                  placeholder="Search @handle, title, LEI..."
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg w-52"
                />

                <select
                  value={issuerFilter}
                  onChange={(e) => setIssuerFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="ALL">All Issuer Types</option>
                  {ISSUER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PUBLIC_ISSUER_META[t].label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={exportPublicCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV</span>
                </button>
                <button
                  type="button"
                  onClick={openNewPublicModal}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Public Account</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-3 px-4">Public Title &amp; Handle</th>
                    <th className="py-3 px-4">Issuer &amp; Ticker / LEI</th>
                    <th className="py-3 px-4">Transparency Standard</th>
                    <th className="py-3 px-4">Visibility &amp; Routing</th>
                    <th className="py-3 px-4 text-right">Disclosed Reserve</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {filteredPublicAccounts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        No public accounts match your filter criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredPublicAccounts.map((item) => {
                      const isOwner = item.ownerId === user?.uid;
                      const isLocked = item.status === 'archived';
                      return (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-900">{item.displayTitle}</p>
                            <p className="text-[11px] font-mono text-slate-500">
                              @{item.publicHandle} · {isOwner ? 'Owner Managed' : 'Verified Peer'}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-slate-900">{PUBLIC_ISSUER_META[item.issuerType].label}</p>
                            <p className="text-[11px] font-mono text-slate-500">
                              {item.publicTickerOrLei}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-slate-700">
                            <p>{item.transparencyStandard}</p>
                            <p className="text-[11px] text-slate-500">
                              {PUBLIC_ISSUER_META[item.issuerType].badge}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            {isOwner && !isLocked ? (
                              <button
                                type="button"
                                onClick={() => void handleTogglePublicVisibility(item)}
                                className="text-slate-900 hover:underline cursor-pointer font-medium"
                              >
                                {item.visibility === 'public_directory'
                                  ? 'Public Directory'
                                  : 'Unlisted'}
                              </button>
                            ) : (
                              <span className="text-slate-700">
                                {item.visibility === 'public_directory'
                                  ? 'Public Directory'
                                  : 'Unlisted'}
                              </span>
                            )}
                            <p className="text-[11px] text-slate-500">
                              {item.allowInboundTransfers ? 'Inbound Transfers Open' : 'Read-Only Disclosure'}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                            {formatCurrency(item.disclosedReserveUsd)}
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <span
                              className={
                                item.status === 'published'
                                  ? 'text-emerald-700 font-medium'
                                  : item.status === 'draft'
                                    ? 'text-amber-700 font-medium'
                                    : 'text-slate-400'
                              }
                            >
                              {item.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  void navigator.clipboard.writeText(`@${item.publicHandle}`);
                                  setCopiedHandleId(item.id);
                                  window.setTimeout(() => setCopiedHandleId(null), 1500);
                                }}
                                title="Copy public handle"
                                className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer"
                              >
                                {copiedHandleId === item.id ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-700" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                              {isOwner && (
                                <>
                                  <button
                                    type="button"
                                    disabled={isLocked}
                                    onClick={() => openEditPublicModal(item)}
                                    title="Edit public account"
                                    className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer disabled:opacity-40"
                                  >
                                    <Edit3 className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isLocked}
                                    onClick={() => void handleDeletePublic(item)}
                                    title="Delete public account"
                                    className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded cursor-pointer disabled:opacity-40"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* TAB 3: LINKED BANK ACCOUNTS (PUBLIC & COMPANY CASH ACCOUNTS)        */}
      {/* =================================================================== */}
      {subView === 'bank' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200">
            <div>
              <h2 className="text-base font-semibold text-slate-900 font-display">
                Public &amp; Company Bank / Cash Accounts
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Direct <span className="font-mono">company</span> and <span className="font-mono">public</span> typed cash accounts synchronized with your real-time ledger, payments, and architecture rules.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setBankLinkType('company');
                setBankLinkName('');
                setBankLinkInst('');
                setBankLinkMask('');
                setBankLinkBalance('100000');
                setBankLinkError(null);
                setBankLinkModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Link Public / Company Cash Account</span>
            </button>
          </div>

          {entityBankAccounts.length === 0 ? (
            <div className="py-10 text-center space-y-3">
              <p className="text-sm text-slate-600">
                No dedicated <span className="font-mono">company</span> or{' '}
                <span className="font-mono">public</span> typed bank cash accounts linked yet.
              </p>
              <p className="text-xs text-slate-500">
                Your existing corporate and public profiles above are linked to your operating and treasury cash accounts, or you can link a dedicated company/public cash account now.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {entityBankAccounts.map((acc) => (
                <div
                  key={acc.id}
                  className="p-5 rounded-xl border border-slate-200 bg-slate-50 space-y-2"
                >
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {acc.institutionName} · •••• {acc.accountMask}
                    </span>
                    <span className="uppercase font-mono text-slate-700">
                      {acc.accountType} · {acc.status}
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-slate-900">{acc.accountName}</p>
                  <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                    {formatCurrency(acc.balance, acc.currency)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: CREATE / EDIT COMPANY ACCOUNT                                */}
      {/* =================================================================== */}
      {companyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingCompany ? 'Edit Company Account' : 'Create Company Account'}
              </h3>
              <button
                type="button"
                onClick={() => setCompanyModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveCompany(e)} className="mt-4 space-y-4">
              {companyError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {companyError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Legal Company Name
                  </label>
                  <input
                    type="text"
                    value={companyForm.companyName}
                    onChange={(e) => setCompanyForm({ ...companyForm, companyName: e.target.value })}
                    placeholder="e.g., Veridian Treasury Holdings LLC"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Entity Structure
                  </label>
                  <select
                    value={companyForm.entityType}
                    onChange={(e) =>
                      setCompanyForm({
                        ...companyForm,
                        entityType: e.target.value as CompanyEntityType,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {ENTITY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {COMPANY_ENTITY_META[t].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    EIN / Tax ID Last 4
                  </label>
                  <input
                    type="text"
                    maxLength={4}
                    value={companyForm.einLast4}
                    onChange={(e) =>
                      setCompanyForm({
                        ...companyForm,
                        einLast4: e.target.value.replace(/\D/g, '').slice(0, 4),
                      })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Linked Settlement Account
                  </label>
                  <select
                    value={companyForm.linkedAccountId}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm, linkedAccountId: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                    required
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountName} (····{a.accountMask})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Jurisdiction
                  </label>
                  <input
                    type="text"
                    value={companyForm.jurisdiction}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm, jurisdiction: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Industry Sector
                  </label>
                  <input
                    type="text"
                    value={companyForm.industrySector}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm, industrySector: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Authorized Signers (1–50)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={companyForm.authorizedSignersCount}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm, authorizedSignersCount: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Operating Balance ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={companyForm.operatingBalance}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm, operatingBalance: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Credit Facility Limit ($)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={companyForm.creditFacilityLimit}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm, creditFacilityLimit: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Status</label>
                  <select
                    value={companyForm.status}
                    onChange={(e) =>
                      setCompanyForm({
                        ...companyForm,
                        status: e.target.value as CompanyAccountStatus,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="active">Active</option>
                    <option value="audit_hold">Audit Hold</option>
                    <option value="dissolved">Dissolved (Terminal)</option>
                  </select>
                </div>

                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={companyForm.dualApprovalRequired}
                      onChange={(e) =>
                        setCompanyForm({
                          ...companyForm,
                          dualApprovalRequired: e.target.checked,
                        })
                      }
                    />
                    <span>Require dual-control signer approval</span>
                  </label>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setCompanyModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingCompany}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingCompany
                    ? 'Saving...'
                    : editingCompany
                      ? 'Save Company'
                      : 'Create Company'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: CREATE / EDIT PUBLIC ACCOUNT                                 */}
      {/* =================================================================== */}
      {publicModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingPublic ? 'Edit Public Account' : 'Create Public Account'}
              </h3>
              <button
                type="button"
                onClick={() => setPublicModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSavePublic(e)} className="mt-4 space-y-4">
              {publicError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {publicError}
                </div>
              )}

              <p className="text-xs text-slate-500">
                Public accounts store zero PII and can be listed in the verified Public Directory when published.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Public Display Title
                  </label>
                  <input
                    type="text"
                    value={publicForm.displayTitle}
                    onChange={(e) => setPublicForm({ ...publicForm, displayTitle: e.target.value })}
                    placeholder="e.g., Veridian Open Treasury Reserve"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Public Handle
                  </label>
                  <input
                    type="text"
                    value={publicForm.publicHandle}
                    onChange={(e) => setPublicForm({ ...publicForm, publicHandle: e.target.value })}
                    placeholder="veridian.reserve"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Ticker / LEI / Registry ID
                  </label>
                  <input
                    type="text"
                    value={publicForm.publicTickerOrLei}
                    onChange={(e) =>
                      setPublicForm({ ...publicForm, publicTickerOrLei: e.target.value })
                    }
                    placeholder="VRDN · 549300..."
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Issuer Classification
                  </label>
                  <select
                    value={publicForm.issuerType}
                    onChange={(e) =>
                      setPublicForm({
                        ...publicForm,
                        issuerType: e.target.value as PublicIssuerType,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {ISSUER_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {PUBLIC_ISSUER_META[t].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Linked Backing Bank Account
                  </label>
                  <select
                    value={publicForm.linkedAccountId}
                    onChange={(e) =>
                      setPublicForm({ ...publicForm, linkedAccountId: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                    required
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountName} (····{a.accountMask})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Disclosed Reserve (USD)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={publicForm.disclosedReserveUsd}
                    onChange={(e) =>
                      setPublicForm({ ...publicForm, disclosedReserveUsd: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Transparency Standard
                  </label>
                  <input
                    type="text"
                    value={publicForm.transparencyStandard}
                    onChange={(e) =>
                      setPublicForm({ ...publicForm, transparencyStandard: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Visibility
                  </label>
                  <select
                    value={publicForm.visibility}
                    onChange={(e) =>
                      setPublicForm({
                        ...publicForm,
                        visibility: e.target.value as PublicAccountVisibility,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="public_directory">Public Directory</option>
                    <option value="unlisted">Unlisted (Owner Only)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Status</label>
                  <select
                    value={publicForm.status}
                    onChange={(e) =>
                      setPublicForm({
                        ...publicForm,
                        status: e.target.value as PublicAccountStatus,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="published">Published</option>
                    <option value="draft">Draft</option>
                    <option value="archived">Archived (Terminal)</option>
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={publicForm.allowInboundTransfers}
                  onChange={(e) =>
                    setPublicForm({ ...publicForm, allowInboundTransfers: e.target.checked })
                  }
                />
                <span>Allow inbound counterparty settlements via public handle</span>
              </label>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setPublicModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingPublic}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingPublic
                    ? 'Saving...'
                    : editingPublic
                      ? 'Save Public Account'
                      : 'Publish Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: LINK PUBLIC / COMPANY TYPED CASH ACCOUNT                     */}
      {/* =================================================================== */}
      {bankLinkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                Link Public or Company Cash Account
              </h3>
              <button
                type="button"
                onClick={() => setBankLinkModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleCreateEntityBankAccount(e)} className="mt-4 space-y-4">
              {bankLinkError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {bankLinkError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Account Classification
                </label>
                <select
                  value={bankLinkType}
                  onChange={(e) => setBankLinkType(e.target.value as 'company' | 'public')}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="company">Company Account (Corporate Cash)</option>
                  <option value="public">Public Account (Disclosed Treasury)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Account Name
                </label>
                <input
                  type="text"
                  value={bankLinkName}
                  onChange={(e) => setBankLinkName(e.target.value)}
                  placeholder="Veridian Holdings Operating"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Institution Name
                </label>
                <input
                  type="text"
                  value={bankLinkInst}
                  onChange={(e) => setBankLinkInst(e.target.value)}
                  placeholder="JPMorgan Institutional"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Last 4 Digits
                  </label>
                  <input
                    type="text"
                    maxLength={4}
                    value={bankLinkMask}
                    onChange={(e) =>
                      setBankLinkMask(e.target.value.replace(/\D/g, '').slice(0, 4))
                    }
                    placeholder="5512"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Opening Balance (USD)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={bankLinkBalance}
                    onChange={(e) => setBankLinkBalance(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setBankLinkModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBankLink}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingBankLink ? 'Linking...' : 'Link Cash Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
