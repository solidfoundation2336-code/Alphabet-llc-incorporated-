import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  ArrowRight,
  ArrowUpRight,
  Briefcase,
  Building2,
  CheckCircle2,
  Download,
  Edit3,
  KeyRound,
  Landmark,
  Lock,
  Network,
  Pause,
  Play,
  PlayCircle,
  Plus,
  Route,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  ACQUISITION_ASSET_CLASS_MAP,
  ACQUISITION_TYPE_META,
  BANK_FLOW_META,
  BROKERAGE_TX_META,
  type AccountRecoveryConfig,
  type AcquisitionArchitecture,
  type AcquisitionStage,
  type AcquisitionType,
  type AmlScreeningLevel,
  type ArchRailCode,
  type BankAccount,
  type BankArchStatus,
  type BankFlowPattern,
  type BankTxArchitecture,
  type BrokerageArchStatus,
  type BrokerageFirm,
  type BrokerageTxArchitecture,
  type BrokerageTxType,
  type FailoverRailCode,
  type PaymentRail,
  type RailArchitecture,
  type RailMfaPolicy,
  type RailOperationalStatus,
  type UserPrivateProfile,
  type UserWorkspace,
} from '../types/finance';
import {
  csvEscape,
  downloadTextFile,
  formatCompactCurrency,
  formatCurrency,
  generateSafeId,
} from '../utils/formatters';
import {
  generateTotpCode,
  generateTotpSecret,
  getTotpSecondsRemaining,
  verifyTotpCode,
} from '../utils/totp';
import { AccountRecoveryPanel } from './AccountRecoveryPanel';
import type { WorkspaceTab } from './Sidebar';

interface ArchitectureRecoveryViewProps {
  workspace: UserWorkspace | null;
  accounts: BankAccount[];
  firms: BrokerageFirm[];
  recoveryConfig: AccountRecoveryConfig | null;
  privateProfile: UserPrivateProfile | null;
  bankTxArchitectures: BankTxArchitecture[];
  brokerageTxArchitectures: BrokerageTxArchitecture[];
  railArchitectures: RailArchitecture[];
  acquisitionArchitectures: AcquisitionArchitecture[];
  subTabRequest?: { tab: ArchSubTab; nonce: number };
  onNavigateTab?: (tab: WorkspaceTab) => void;
}

type ArchSubTab = 'recovery' | 'bank' | 'brokerage' | 'rails' | 'acquisition';

const RAIL_CODES: ArchRailCode[] = ['ACH', 'WIRE', 'FEDNOW', 'SWIFT', 'DTC_CNS', 'INTERNAL'];
const FAILOVER_CODES: FailoverRailCode[] = [...RAIL_CODES, 'NONE'];
const BANK_FLOW_KEYS = Object.keys(BANK_FLOW_META) as BankFlowPattern[];
const BROKERAGE_TYPE_KEYS = Object.keys(BROKERAGE_TX_META) as BrokerageTxType[];
const ACQUISITION_TYPE_KEYS = Object.keys(ACQUISITION_TYPE_META) as AcquisitionType[];
const ACQUISITION_STAGE_LABELS: Record<AcquisitionStage, string> = {
  pipeline: 'Pipeline',
  diligence: 'Diligence',
  escrow_funded: 'Escrow Funded',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
const ACQUISITION_STAGE_INDEX: Record<AcquisitionStage, number> = {
  pipeline: 0,
  diligence: 1,
  escrow_funded: 2,
  closed: 4,
  cancelled: 0,
};

export function ArchitectureRecoveryView({
  workspace,
  accounts,
  firms,
  recoveryConfig,
  privateProfile,
  bankTxArchitectures,
  brokerageTxArchitectures,
  railArchitectures,
  acquisitionArchitectures,
  subTabRequest,
  onNavigateTab,
}: ArchitectureRecoveryViewProps) {
  const { user } = useAuth();
  const [subTab, setSubTab] = useState<ArchSubTab>(subTabRequest?.tab ?? 'recovery');
  const [lastSubTabNonce, setLastSubTabNonce] = useState<number>(subTabRequest?.nonce ?? 0);

  if (subTabRequest && subTabRequest.nonce !== lastSubTabNonce) {
    setLastSubTabNonce(subTabRequest.nonce);
    setSubTab(subTabRequest.tab);
  }

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const firmMap = useMemo(() => new Map(firms.map((f) => [f.id, f])), [firms]);


  // --- Bank Tx Architecture State ---
  const [bankSearch, setBankSearch] = useState('');
  const [bankFlowFilter, setBankFlowFilter] = useState<string>('ALL');
  const [evalAccountId, setEvalAccountId] = useState<string>(accounts[0]?.id || '');
  const [evalFlow, setEvalFlow] = useState<BankFlowPattern>('fedwire_rtgs');
  const [evalAmount, setEvalAmount] = useState<string>('125000');

  const [bankModalOpen, setBankModalOpen] = useState(false);
  const [editingBankArch, setEditingBankArch] = useState<BankTxArchitecture | null>(null);
  const [bankForm, setBankForm] = useState<{
    accountId: string;
    ruleName: string;
    flowPattern: BankFlowPattern;
    primaryRail: ArchRailCode;
    settlementWindow: string;
    singleTxLimit: string;
    dailyLimit: string;
    mfaThreshold: string;
    dualApprovalRequired: boolean;
    autoReconcile: boolean;
    amlScreeningLevel: AmlScreeningLevel;
    status: BankArchStatus;
  }>({
    accountId: accounts[0]?.id || '',
    ruleName: '',
    flowPattern: 'fedwire_rtgs',
    primaryRail: 'WIRE',
    settlementWindow: BANK_FLOW_META.fedwire_rtgs.defaultWindow,
    singleTxLimit: '500000',
    dailyLimit: '2500000',
    mfaThreshold: '25000',
    dualApprovalRequired: true,
    autoReconcile: true,
    amlScreeningLevel: 'institutional',
    status: 'active',
  });
  const [bankFormError, setBankFormError] = useState<string | null>(null);
  const [savingBank, setSavingBank] = useState(false);

  // --- Brokerage Tx Architecture State ---
  const [brokerageSearch, setBrokerageSearch] = useState('');
  const [brokerageTypeFilter, setBrokerageTypeFilter] = useState<string>('ALL');
  const [selectedBrokerageType, setSelectedBrokerageType] = useState<BrokerageTxType>('equity_order_execution');

  const [brokerageModalOpen, setBrokerageModalOpen] = useState(false);
  const [editingBrokerageArch, setEditingBrokerageArch] = useState<BrokerageTxArchitecture | null>(null);
  const [brokerageForm, setBrokerageForm] = useState<{
    firmId: string;
    settlementAccountId: string;
    architectureName: string;
    txType: BrokerageTxType;
    clearingVenue: string;
    settlementCycle: string;
    custodyModel: string;
    regulatoryControl: string;
    primaryRail: ArchRailCode;
    maxOrderNotional: string;
    mfaRequired: boolean;
    status: BrokerageArchStatus;
  }>({
    firmId: firms[0]?.id || '',
    settlementAccountId: accounts[0]?.id || '',
    architectureName: '',
    txType: 'equity_order_execution',
    clearingVenue: BROKERAGE_TX_META.equity_order_execution.defaultVenue,
    settlementCycle: BROKERAGE_TX_META.equity_order_execution.defaultCycle,
    custodyModel: BROKERAGE_TX_META.equity_order_execution.defaultCustody,
    regulatoryControl: BROKERAGE_TX_META.equity_order_execution.defaultReg,
    primaryRail: BROKERAGE_TX_META.equity_order_execution.defaultRail,
    maxOrderNotional: '10000000',
    mfaRequired: true,
    status: 'active',
  });
  const [brokerageFormError, setBrokerageFormError] = useState<string | null>(null);
  const [savingBrokerage, setSavingBrokerage] = useState(false);

  // --- Rail Architecture State ---
  const [railSearch, setRailSearch] = useState('');
  const [railStatusFilter, setRailStatusFilter] = useState<string>('ALL');
  const [selectorAmount, setSelectorAmount] = useState<string>('75000');
  const [selectorPriority, setSelectorPriority] = useState<
    'lowest_fee' | 'instant_finality' | 'high_value_settlement' | 'securities_clearing'
  >('instant_finality');

  const [railModalOpen, setRailModalOpen] = useState(false);
  const [editingRailArch, setEditingRailArch] = useState<RailArchitecture | null>(null);
  const [railForm, setRailForm] = useState<{
    linkedAccountId: string;
    railCode: ArchRailCode;
    railName: string;
    protocolStandard: string;
    settlementFinality: string;
    cutoffWindow: string;
    slaLatency: string;
    perTxCap: string;
    feeBps: string;
    failoverRailCode: FailoverRailCode;
    mfaPolicy: RailMfaPolicy;
    status: RailOperationalStatus;
  }>({
    linkedAccountId: accounts[0]?.id || '',
    railCode: 'FEDNOW',
    railName: '',
    protocolStandard: 'ISO 20022 Instant Credit',
    settlementFinality: 'Irrevocable Instant (<10s)',
    cutoffWindow: '24/7/365 Continuous',
    slaLatency: '4 seconds',
    perTxCap: '500000',
    feeBps: '2.5',
    failoverRailCode: 'WIRE',
    mfaPolicy: 'above_threshold',
    status: 'operational',
  });
  const [railFormError, setRailFormError] = useState<string | null>(null);
  const [savingRail, setSavingRail] = useState(false);

  // --- Acquisition Architecture & Purchases Account State ---
  const [acqSearch, setAcqSearch] = useState('');
  const [acqTypeFilter, setAcqTypeFilter] = useState<string>('ALL');
  const [acqStageFilter, setAcqStageFilter] = useState<string>('ALL');
  const [selectedAcqId, setSelectedAcqId] = useState<string>('');

  const [purchasesDraftId, setPurchasesDraftId] = useState<string | null>(null);
  const [savingPurchasesAcct, setSavingPurchasesAcct] = useState(false);
  const [applyingPurchasesBatch, setApplyingPurchasesBatch] = useState(false);
  const [purchasesFeedback, setPurchasesFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const [createPurchasesModalOpen, setCreatePurchasesModalOpen] = useState(false);
  const [newPurchasesForm, setNewPurchasesForm] = useState({
    accountName: 'Strategic Acquisitions & Purchases',
    institutionName: 'JPMorgan Chase Institutional',
    accountMask: '6208',
    balance: '2500000',
  });
  const [createPurchasesError, setCreatePurchasesError] = useState<string | null>(null);
  const [creatingPurchasesAcct, setCreatingPurchasesAcct] = useState(false);

  const [workflowTargetId, setWorkflowTargetId] = useState<string | null>(null);
  const [workflowFundingAccountId, setWorkflowFundingAccountId] = useState<string>('');
  const [workflowTotpSecret] = useState(() => generateTotpSecret());
  const [workflowLiveCode, setWorkflowLiveCode] = useState('------');
  const [workflowSecondsLeft, setWorkflowSecondsLeft] = useState(getTotpSecondsRemaining());
  const [workflowEnteredCode, setWorkflowEnteredCode] = useState('');
  const [workflowOnboardAsset, setWorkflowOnboardAsset] = useState(true);
  const [workflowAssetName, setWorkflowAssetName] = useState('');
  const [workflowTicker, setWorkflowTicker] = useState('');
  const [workflowQuantity, setWorkflowQuantity] = useState('1');
  const [workflowJurisdiction, setWorkflowJurisdiction] = useState('United States');
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowRunning, setWorkflowRunning] = useState(false);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      const code = await generateTotpCode(workflowTotpSecret);
      if (active) {
        setWorkflowLiveCode(code);
        setWorkflowSecondsLeft(getTotpSecondsRemaining());
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workflowTotpSecret]);

  const [acqModalOpen, setAcqModalOpen] = useState(false);
  const [editingAcqArch, setEditingAcqArch] = useState<AcquisitionArchitecture | null>(null);
  const [acqForm, setAcqForm] = useState<{
    fundingAccountId: string;
    firmId: string;
    architectureName: string;
    acquisitionType: AcquisitionType;
    targetCounterparty: string;
    dealStructure: string;
    escrowAgent: string;
    closingHorizon: string;
    settlementRail: ArchRailCode;
    targetValuationUsd: string;
    committedCapitalUsd: string;
    escrowHoldbackPct: string;
    diligenceGateRequired: boolean;
    mfaSignoffRequired: boolean;
    stage: AcquisitionStage;
  }>({
    fundingAccountId: workspace?.purchasesAccountId || accounts[0]?.id || '',
    firmId: firms[0]?.id || '',
    architectureName: '',
    acquisitionType: 'strategic_ma_buyout',
    targetCounterparty: '',
    dealStructure: ACQUISITION_TYPE_META.strategic_ma_buyout.defaultDealStructure,
    escrowAgent: ACQUISITION_TYPE_META.strategic_ma_buyout.defaultEscrowAgent,
    closingHorizon: ACQUISITION_TYPE_META.strategic_ma_buyout.defaultClosingHorizon,
    settlementRail: ACQUISITION_TYPE_META.strategic_ma_buyout.defaultRail,
    targetValuationUsd: '2500000',
    committedCapitalUsd: '500000',
    escrowHoldbackPct: '10',
    diligenceGateRequired: true,
    mfaSignoffRequired: true,
    stage: 'pipeline',
  });
  const [acqFormError, setAcqFormError] = useState<string | null>(null);
  const [savingAcq, setSavingAcq] = useState(false);

  // =========================================================================
  // BANK TX ARCHITECTURE HANDLERS & COMPUTED
  // =========================================================================
  const effectiveEvalAccountId = evalAccountId || accounts[0]?.id || '';
  const evalAmountNum = Math.max(0, Number(evalAmount) || 0);

  const matchedBankPolicy = useMemo(() => {
    const candidates = bankTxArchitectures.filter(
      (b) =>
        b.flowPattern === evalFlow &&
        (b.accountId === effectiveEvalAccountId || b.status === 'active'),
    );
    return (
      candidates.find((c) => c.accountId === effectiveEvalAccountId && c.status === 'active') ||
      candidates.find((c) => c.accountId === effectiveEvalAccountId) ||
      candidates.find((c) => c.status === 'active') ||
      null
    );
  }, [bankTxArchitectures, evalFlow, effectiveEvalAccountId]);

  const filteredBankArchs = useMemo(() => {
    const q = bankSearch.trim().toLowerCase();
    return bankTxArchitectures.filter((item) => {
      if (bankFlowFilter !== 'ALL' && item.flowPattern !== bankFlowFilter) return false;
      if (!q) return true;
      const acctName = accountMap.get(item.accountId)?.accountName?.toLowerCase() || '';
      return (
        item.ruleName.toLowerCase().includes(q) ||
        item.primaryRail.toLowerCase().includes(q) ||
        acctName.includes(q) ||
        BANK_FLOW_META[item.flowPattern].label.toLowerCase().includes(q)
      );
    });
  }, [bankTxArchitectures, bankSearch, bankFlowFilter, accountMap]);

  const openNewBankModal = () => {
    setEditingBankArch(null);
    setBankForm({
      accountId: accounts[0]?.id || '',
      ruleName: '',
      flowPattern: 'fedwire_rtgs',
      primaryRail: 'WIRE',
      settlementWindow: BANK_FLOW_META.fedwire_rtgs.defaultWindow,
      singleTxLimit: '500000',
      dailyLimit: '2500000',
      mfaThreshold: '25000',
      dualApprovalRequired: true,
      autoReconcile: true,
      amlScreeningLevel: 'institutional',
      status: 'active',
    });
    setBankFormError(null);
    setBankModalOpen(true);
  };

  const openEditBankModal = (item: BankTxArchitecture) => {
    setEditingBankArch(item);
    setBankForm({
      accountId: item.accountId,
      ruleName: item.ruleName,
      flowPattern: item.flowPattern,
      primaryRail: item.primaryRail,
      settlementWindow: item.settlementWindow,
      singleTxLimit: String(item.singleTxLimit),
      dailyLimit: String(item.dailyLimit),
      mfaThreshold: String(item.mfaThreshold),
      dualApprovalRequired: item.dualApprovalRequired,
      autoReconcile: item.autoReconcile,
      amlScreeningLevel: item.amlScreeningLevel,
      status: item.status,
    });
    setBankFormError(null);
    setBankModalOpen(true);
  };

  const handleSaveBankArch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBankFormError(null);

    const singleTxLimit = Number(bankForm.singleTxLimit);
    const dailyLimit = Number(bankForm.dailyLimit);
    const mfaThreshold = Number(bankForm.mfaThreshold);

    if (!bankForm.accountId) {
      setBankFormError('Select a valid bank account.');
      return;
    }
    if (bankForm.ruleName.trim().length < 2) {
      setBankFormError('Rule name must be at least 2 characters.');
      return;
    }
    if (!Number.isFinite(singleTxLimit) || singleTxLimit <= 0) {
      setBankFormError('Single transaction limit must be greater than zero.');
      return;
    }
    if (!Number.isFinite(dailyLimit) || dailyLimit < singleTxLimit) {
      setBankFormError('Daily limit must be greater than or equal to the single transaction limit.');
      return;
    }
    if (!Number.isFinite(mfaThreshold) || mfaThreshold < 0) {
      setBankFormError('MFA threshold must be zero or greater.');
      return;
    }

    setSavingBank(true);
    try {
      const payload = {
        accountId: bankForm.accountId,
        ruleName: bankForm.ruleName.trim().slice(0, 120),
        flowPattern: bankForm.flowPattern,
        primaryRail: bankForm.primaryRail,
        settlementWindow: bankForm.settlementWindow.trim().slice(0, 60),
        singleTxLimit,
        dailyLimit,
        mfaThreshold,
        dualApprovalRequired: bankForm.dualApprovalRequired,
        autoReconcile: bankForm.autoReconcile,
        amlScreeningLevel: bankForm.amlScreeningLevel,
        status: bankForm.status,
        updatedAt: serverTimestamp(),
      };

      if (editingBankArch) {
        await updateDoc(doc(db, 'bank_tx_architectures', editingBankArch.id), payload);
      } else {
        await addDoc(collection(db, 'bank_tx_architectures'), {
          ownerId: user.uid,
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      setBankModalOpen(false);
    } catch (error) {
      handleFirestoreError(
        error,
        editingBankArch ? OperationType.UPDATE : OperationType.CREATE,
        'bank_tx_architectures',
      );
    } finally {
      setSavingBank(false);
    }
  };

  const handleToggleBankStatus = async (item: BankTxArchitecture) => {
    const nextStatus: BankArchStatus = item.status === 'active' ? 'paused' : 'active';
    try {
      await updateDoc(doc(db, 'bank_tx_architectures', item.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `bank_tx_architectures/${item.id}`);
    }
  };

  const handleDeleteBankArch = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'bank_tx_architectures', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `bank_tx_architectures/${id}`);
    }
  };

  const exportBankCsv = () => {
    const headers = [
      'Rule Name',
      'Account',
      'Flow Pattern',
      'Primary Rail',
      'Settlement Window',
      'Single Tx Limit',
      'Daily Limit',
      'MFA Threshold',
      'Dual Approval',
      'Auto Reconcile',
      'AML Screening',
      'Status',
    ];
    const rows = filteredBankArchs.map((b) =>
      [
        b.ruleName,
        accountMap.get(b.accountId)?.accountName || b.accountId,
        BANK_FLOW_META[b.flowPattern].label,
        b.primaryRail,
        b.settlementWindow,
        b.singleTxLimit,
        b.dailyLimit,
        b.mfaThreshold,
        b.dualApprovalRequired,
        b.autoReconcile,
        b.amlScreeningLevel,
        b.status,
      ]
        .map(csvEscape)
        .join(','),
    );
    downloadTextFile('veridian-bank-tx-architecture.csv', [headers.join(','), ...rows].join('\n'));
  };

  const exportBankJson = () => {
    downloadTextFile(
      'veridian-bank-tx-architecture.json',
      JSON.stringify(filteredBankArchs, null, 2),
      'application/json',
    );
  };

  // =========================================================================
  // BROKERAGE TX ARCHITECTURE HANDLERS & COMPUTED
  // =========================================================================
  const brokerageCoverageByType = useMemo(() => {
    const map = new Map<BrokerageTxType, BrokerageTxArchitecture[]>();
    BROKERAGE_TYPE_KEYS.forEach((k) => map.set(k, []));
    brokerageTxArchitectures.forEach((b) => {
      const list = map.get(b.txType) || [];
      list.push(b);
      map.set(b.txType, list);
    });
    return map;
  }, [brokerageTxArchitectures]);

  const coveredBrokerageCount = useMemo(
    () => BROKERAGE_TYPE_KEYS.filter((k) => (brokerageCoverageByType.get(k)?.length || 0) > 0).length,
    [brokerageCoverageByType],
  );

  const selectedBrokerageArch = useMemo(() => {
    const list = brokerageCoverageByType.get(selectedBrokerageType) || [];
    return list.find((item) => item.status === 'active') || list[0] || null;
  }, [brokerageCoverageByType, selectedBrokerageType]);

  const filteredBrokerageArchs = useMemo(() => {
    const q = brokerageSearch.trim().toLowerCase();
    return brokerageTxArchitectures.filter((item) => {
      if (brokerageTypeFilter !== 'ALL' && item.txType !== brokerageTypeFilter) return false;
      if (!q) return true;
      const firmName = firmMap.get(item.firmId)?.firmName?.toLowerCase() || '';
      return (
        item.architectureName.toLowerCase().includes(q) ||
        item.clearingVenue.toLowerCase().includes(q) ||
        item.regulatoryControl.toLowerCase().includes(q) ||
        firmName.includes(q) ||
        BROKERAGE_TX_META[item.txType].label.toLowerCase().includes(q)
      );
    });
  }, [brokerageTxArchitectures, brokerageSearch, brokerageTypeFilter, firmMap]);

  const openNewBrokerageModal = (presetType: BrokerageTxType = selectedBrokerageType) => {
    const meta = BROKERAGE_TX_META[presetType];
    setEditingBrokerageArch(null);
    setBrokerageForm({
      firmId: firms[0]?.id || '',
      settlementAccountId: accounts[0]?.id || '',
      architectureName: `${meta.label} Pipeline`,
      txType: presetType,
      clearingVenue: meta.defaultVenue,
      settlementCycle: meta.defaultCycle,
      custodyModel: meta.defaultCustody,
      regulatoryControl: meta.defaultReg,
      primaryRail: meta.defaultRail,
      maxOrderNotional: '10000000',
      mfaRequired: true,
      status: 'active',
    });
    setBrokerageFormError(null);
    setBrokerageModalOpen(true);
  };

  const openEditBrokerageModal = (item: BrokerageTxArchitecture) => {
    setEditingBrokerageArch(item);
    setBrokerageForm({
      firmId: item.firmId,
      settlementAccountId: item.settlementAccountId,
      architectureName: item.architectureName,
      txType: item.txType,
      clearingVenue: item.clearingVenue,
      settlementCycle: item.settlementCycle,
      custodyModel: item.custodyModel,
      regulatoryControl: item.regulatoryControl,
      primaryRail: item.primaryRail,
      maxOrderNotional: String(item.maxOrderNotional),
      mfaRequired: item.mfaRequired,
      status: item.status,
    });
    setBrokerageFormError(null);
    setBrokerageModalOpen(true);
  };

  const handleSaveBrokerageArch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBrokerageFormError(null);

    const maxOrderNotional = Number(brokerageForm.maxOrderNotional);
    if (!brokerageForm.firmId || !brokerageForm.settlementAccountId) {
      setBrokerageFormError('Select both a registered brokerage firm and a settlement bank account.');
      return;
    }
    if (brokerageForm.architectureName.trim().length < 2) {
      setBrokerageFormError('Architecture name must be at least 2 characters.');
      return;
    }
    if (!Number.isFinite(maxOrderNotional) || maxOrderNotional <= 0) {
      setBrokerageFormError('Max order notional must be greater than zero.');
      return;
    }

    setSavingBrokerage(true);
    try {
      const payload = {
        firmId: brokerageForm.firmId,
        settlementAccountId: brokerageForm.settlementAccountId,
        architectureName: brokerageForm.architectureName.trim().slice(0, 140),
        txType: brokerageForm.txType,
        clearingVenue: brokerageForm.clearingVenue.trim().slice(0, 80),
        settlementCycle: brokerageForm.settlementCycle.trim().slice(0, 40),
        custodyModel: brokerageForm.custodyModel.trim().slice(0, 80),
        regulatoryControl: brokerageForm.regulatoryControl.trim().slice(0, 100),
        primaryRail: brokerageForm.primaryRail,
        maxOrderNotional,
        mfaRequired: brokerageForm.mfaRequired,
        status: brokerageForm.status,
        updatedAt: serverTimestamp(),
      };

      if (editingBrokerageArch) {
        await updateDoc(doc(db, 'brokerage_tx_architectures', editingBrokerageArch.id), payload);
      } else {
        await addDoc(collection(db, 'brokerage_tx_architectures'), {
          ownerId: user.uid,
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      setBrokerageModalOpen(false);
    } catch (error) {
      handleFirestoreError(
        error,
        editingBrokerageArch ? OperationType.UPDATE : OperationType.CREATE,
        'brokerage_tx_architectures',
      );
    } finally {
      setSavingBrokerage(false);
    }
  };

  const handleCycleBrokerageStatus = async (item: BrokerageTxArchitecture) => {
    const order: BrokerageArchStatus[] = ['active', 'testing', 'suspended'];
    const nextStatus = order[(order.indexOf(item.status) + 1) % order.length];
    try {
      await updateDoc(doc(db, 'brokerage_tx_architectures', item.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `brokerage_tx_architectures/${item.id}`);
    }
  };

  const handleDeleteBrokerageArch = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'brokerage_tx_architectures', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `brokerage_tx_architectures/${id}`);
    }
  };

  const exportBrokerageCsv = () => {
    const headers = [
      'Architecture Name',
      'Transaction Class',
      'Brokerage Firm',
      'Settlement Account',
      'Clearing Venue',
      'Settlement Cycle',
      'Custody Model',
      'Regulatory Control',
      'Primary Rail',
      'Max Notional',
      'MFA Required',
      'Status',
    ];
    const rows = filteredBrokerageArchs.map((b) =>
      [
        b.architectureName,
        BROKERAGE_TX_META[b.txType].label,
        firmMap.get(b.firmId)?.firmName || b.firmId,
        accountMap.get(b.settlementAccountId)?.accountName || b.settlementAccountId,
        b.clearingVenue,
        b.settlementCycle,
        b.custodyModel,
        b.regulatoryControl,
        b.primaryRail,
        b.maxOrderNotional,
        b.mfaRequired,
        b.status,
      ]
        .map(csvEscape)
        .join(','),
    );
    downloadTextFile(
      'veridian-brokerage-tx-architecture.csv',
      [headers.join(','), ...rows].join('\n'),
    );
  };

  const exportBrokerageJson = () => {
    downloadTextFile(
      'veridian-brokerage-tx-architecture.json',
      JSON.stringify(filteredBrokerageArchs, null, 2),
      'application/json',
    );
  };

  // =========================================================================
  // RAIL ARCHITECTURE HANDLERS & COMPUTED
  // =========================================================================
  const selectorAmountNum = Math.max(0, Number(selectorAmount) || 0);

  const recommendedRailEvaluation = useMemo(() => {
    const eligible = railArchitectures.filter(
      (r) => r.status === 'operational' && r.perTxCap >= selectorAmountNum,
    );
    if (eligible.length === 0) {
      const degradedFallback = railArchitectures.find((r) => r.perTxCap >= selectorAmountNum) || null;
      return { primary: null, fallback: degradedFallback };
    }

    const sorted = [...eligible].sort((a, b) => {
      if (selectorPriority === 'lowest_fee') return a.feeBps - b.feeBps;
      if (selectorPriority === 'instant_finality') {
        const rank = (c: ArchRailCode) =>
          c === 'INTERNAL' ? 0 : c === 'FEDNOW' ? 1 : c === 'WIRE' ? 2 : 3;
        return rank(a.railCode) - rank(b.railCode);
      }
      if (selectorPriority === 'securities_clearing') {
        const rank = (c: ArchRailCode) =>
          c === 'DTC_CNS' ? 0 : c === 'WIRE' ? 1 : c === 'INTERNAL' ? 2 : 3;
        return rank(a.railCode) - rank(b.railCode);
      }
      // high_value_settlement
      return b.perTxCap - a.perTxCap;
    });

    const primary = sorted[0];
    const failover =
      primary.failoverRailCode !== 'NONE'
        ? railArchitectures.find((r) => r.railCode === primary.failoverRailCode) || null
        : null;
    return { primary, fallback: failover };
  }, [railArchitectures, selectorAmountNum, selectorPriority]);

  const filteredRailArchs = useMemo(() => {
    const q = railSearch.trim().toLowerCase();
    return railArchitectures.filter((r) => {
      if (railStatusFilter !== 'ALL' && r.status !== railStatusFilter) return false;
      if (!q) return true;
      return (
        r.railCode.toLowerCase().includes(q) ||
        r.railName.toLowerCase().includes(q) ||
        r.protocolStandard.toLowerCase().includes(q) ||
        r.settlementFinality.toLowerCase().includes(q)
      );
    });
  }, [railArchitectures, railSearch, railStatusFilter]);

  const openNewRailModal = () => {
    setEditingRailArch(null);
    setRailForm({
      linkedAccountId: accounts[0]?.id || '',
      railCode: 'FEDNOW',
      railName: '',
      protocolStandard: 'ISO 20022 Instant Credit',
      settlementFinality: 'Irrevocable Instant (<10s)',
      cutoffWindow: '24/7/365 Continuous',
      slaLatency: '4 seconds',
      perTxCap: '500000',
      feeBps: '2.5',
      failoverRailCode: 'WIRE',
      mfaPolicy: 'above_threshold',
      status: 'operational',
    });
    setRailFormError(null);
    setRailModalOpen(true);
  };

  const openEditRailModal = (item: RailArchitecture) => {
    setEditingRailArch(item);
    setRailForm({
      linkedAccountId: item.linkedAccountId,
      railCode: item.railCode,
      railName: item.railName,
      protocolStandard: item.protocolStandard,
      settlementFinality: item.settlementFinality,
      cutoffWindow: item.cutoffWindow,
      slaLatency: item.slaLatency,
      perTxCap: String(item.perTxCap),
      feeBps: String(item.feeBps),
      failoverRailCode: item.failoverRailCode,
      mfaPolicy: item.mfaPolicy,
      status: item.status,
    });
    setRailFormError(null);
    setRailModalOpen(true);
  };

  const handleSaveRailArch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setRailFormError(null);

    const perTxCap = Number(railForm.perTxCap);
    const feeBps = Number(railForm.feeBps);

    if (!railForm.linkedAccountId) {
      setRailFormError('Select a linked settlement bank account.');
      return;
    }
    if (railForm.railName.trim().length < 2) {
      setRailFormError('Rail name must be at least 2 characters.');
      return;
    }
    if (!Number.isFinite(perTxCap) || perTxCap <= 0) {
      setRailFormError('Per-transaction cap must be greater than zero.');
      return;
    }
    if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 1000) {
      setRailFormError('Fee (bps) must be between 0 and 1000.');
      return;
    }

    setSavingRail(true);
    try {
      const payload = {
        linkedAccountId: railForm.linkedAccountId,
        railCode: railForm.railCode,
        railName: railForm.railName.trim().slice(0, 120),
        protocolStandard: railForm.protocolStandard.trim().slice(0, 80),
        settlementFinality: railForm.settlementFinality.trim().slice(0, 80),
        cutoffWindow: railForm.cutoffWindow.trim().slice(0, 80),
        slaLatency: railForm.slaLatency.trim().slice(0, 40),
        perTxCap,
        feeBps,
        failoverRailCode: railForm.failoverRailCode,
        mfaPolicy: railForm.mfaPolicy,
        status: railForm.status,
        updatedAt: serverTimestamp(),
      };

      if (editingRailArch) {
        await updateDoc(doc(db, 'rail_architectures', editingRailArch.id), payload);
      } else {
        await addDoc(collection(db, 'rail_architectures'), {
          ownerId: user.uid,
          ...payload,
          createdAt: serverTimestamp(),
        });
      }
      setRailModalOpen(false);
    } catch (error) {
      handleFirestoreError(
        error,
        editingRailArch ? OperationType.UPDATE : OperationType.CREATE,
        'rail_architectures',
      );
    } finally {
      setSavingRail(false);
    }
  };

  const handleCycleRailStatus = async (item: RailArchitecture) => {
    const order: RailOperationalStatus[] = ['operational', 'degraded', 'maintenance'];
    const nextStatus = order[(order.indexOf(item.status) + 1) % order.length];
    try {
      await updateDoc(doc(db, 'rail_architectures', item.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `rail_architectures/${item.id}`);
    }
  };

  const handleDeleteRailArch = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'rail_architectures', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `rail_architectures/${id}`);
    }
  };

  const exportRailCsv = () => {
    const headers = [
      'Rail Code',
      'Rail Name',
      'Linked Account',
      'Protocol Standard',
      'Settlement Finality',
      'Cutoff Window',
      'SLA Latency',
      'Per-Tx Cap',
      'Fee (bps)',
      'Failover Rail',
      'MFA Policy',
      'Status',
    ];
    const rows = filteredRailArchs.map((r) =>
      [
        r.railCode,
        r.railName,
        accountMap.get(r.linkedAccountId)?.accountName || r.linkedAccountId,
        r.protocolStandard,
        r.settlementFinality,
        r.cutoffWindow,
        r.slaLatency,
        r.perTxCap,
        r.feeBps,
        r.failoverRailCode,
        r.mfaPolicy,
        r.status,
      ]
        .map(csvEscape)
        .join(','),
    );
    downloadTextFile('veridian-rail-architecture.csv', [headers.join(','), ...rows].join('\n'));
  };

  const exportRailJson = () => {
    downloadTextFile(
      'veridian-rail-architecture.json',
      JSON.stringify(filteredRailArchs, null, 2),
      'application/json',
    );
  };

  // =========================================================================
  // ACQUISITION ARCHITECTURE & PURCHASES ACCOUNT HANDLERS
  // =========================================================================
  const activeAcqPipelines = useMemo(
    () => acquisitionArchitectures.filter((a) => a.stage !== 'closed' && a.stage !== 'cancelled'),
    [acquisitionArchitectures],
  );

  const designatedPurchasesAccount = useMemo(
    () =>
      (workspace?.purchasesAccountId ? accountMap.get(workspace.purchasesAccountId) : undefined) ||
      accounts.find((a) => a.accountType === 'purchases') ||
      null,
    [workspace?.purchasesAccountId, accountMap, accounts],
  );

  const selectedPurchasesDraftId =
    purchasesDraftId ??
    workspace?.purchasesAccountId ??
    designatedPurchasesAccount?.id ??
    accounts[0]?.id ??
    '';

  const openPipelinesUsingPurchasesCount = useMemo(() => {
    if (!designatedPurchasesAccount) return 0;
    return activeAcqPipelines.filter((a) => a.fundingAccountId === designatedPurchasesAccount.id)
      .length;
  }, [activeAcqPipelines, designatedPurchasesAccount]);

  const openPipelinesNeedingPurchasesSync = useMemo(() => {
    if (!designatedPurchasesAccount) return [];
    return activeAcqPipelines.filter(
      (a) =>
        a.fundingAccountId !== designatedPurchasesAccount.id &&
        a.stage !== 'escrow_funded',
    );
  }, [activeAcqPipelines, designatedPurchasesAccount]);

  const selectedAcqArch = useMemo(() => {
    if (selectedAcqId) {
      const found = acquisitionArchitectures.find((a) => a.id === selectedAcqId);
      if (found) return found;
    }
    return activeAcqPipelines[0] || acquisitionArchitectures[0] || null;
  }, [acquisitionArchitectures, activeAcqPipelines, selectedAcqId]);

  const workflowTargetAcq = useMemo(
    () =>
      workflowTargetId
        ? acquisitionArchitectures.find((a) => a.id === workflowTargetId) || null
        : null,
    [acquisitionArchitectures, workflowTargetId],
  );

  const filteredAcqArchs = useMemo(() => {
    const q = acqSearch.trim().toLowerCase();
    return acquisitionArchitectures.filter((item) => {
      if (acqTypeFilter !== 'ALL' && item.acquisitionType !== acqTypeFilter) return false;
      if (acqStageFilter !== 'ALL' && item.stage !== acqStageFilter) return false;
      if (!q) return true;
      const acctName = accountMap.get(item.fundingAccountId)?.accountName?.toLowerCase() || '';
      return (
        item.architectureName.toLowerCase().includes(q) ||
        item.targetCounterparty.toLowerCase().includes(q) ||
        item.escrowAgent.toLowerCase().includes(q) ||
        item.dealStructure.toLowerCase().includes(q) ||
        acctName.includes(q) ||
        ACQUISITION_TYPE_META[item.acquisitionType].label.toLowerCase().includes(q)
      );
    });
  }, [acquisitionArchitectures, acqSearch, acqTypeFilter, acqStageFilter, accountMap]);

  const handleSetPurchasesAccount = async () => {
    if (!user || !selectedPurchasesDraftId) return;
    setPurchasesFeedback(null);
    setSavingPurchasesAcct(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        purchasesAccountId: selectedPurchasesDraftId,
        updatedAt: serverTimestamp(),
      });
      setPurchasesDraftId(null);
      const acct = accountMap.get(selectedPurchasesDraftId);
      setPurchasesFeedback({
        type: 'success',
        message: `Designated "${acct?.accountName || selectedPurchasesDraftId}" as the Purchases settlement account.`,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
    } finally {
      setSavingPurchasesAcct(false);
    }
  };

  const handleApplyPurchasesToOpenPipelines = async () => {
    if (!user || !designatedPurchasesAccount || openPipelinesNeedingPurchasesSync.length === 0) {
      return;
    }
    setPurchasesFeedback(null);
    setApplyingPurchasesBatch(true);
    try {
      const batch = writeBatch(db);
      openPipelinesNeedingPurchasesSync.forEach((acq) => {
        batch.update(doc(db, 'acquisition_architectures', acq.id), {
          fundingAccountId: designatedPurchasesAccount.id,
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
      setPurchasesFeedback({
        type: 'success',
        message: `Routed ${openPipelinesNeedingPurchasesSync.length} open acquisition pipeline(s) to ${designatedPurchasesAccount.accountName}.`,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'acquisition_architectures');
    } finally {
      setApplyingPurchasesBatch(false);
    }
  };

  const handleCreatePurchasesAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setCreatePurchasesError(null);

    const trimmedName = newPurchasesForm.accountName.trim();
    const trimmedInstitution = newPurchasesForm.institutionName.trim();
    const trimmedMask = newPurchasesForm.accountMask.trim();
    const parsedBalance = Number(newPurchasesForm.balance);

    if (trimmedName.length < 2 || trimmedName.length > 100) {
      setCreatePurchasesError('Account name must be 2 to 100 characters.');
      return;
    }
    if (trimmedInstitution.length < 2 || trimmedInstitution.length > 100) {
      setCreatePurchasesError('Institution name must be 2 to 100 characters.');
      return;
    }
    if (!/^[0-9]{4}$/.test(trimmedMask)) {
      setCreatePurchasesError('Account mask must be exactly 4 digits.');
      return;
    }
    if (!Number.isFinite(parsedBalance) || parsedBalance < 0 || parsedBalance > 1000000000) {
      setCreatePurchasesError('Opening balance must be between 0 and $1,000,000,000.');
      return;
    }

    setCreatingPurchasesAcct(true);
    try {
      const batch = writeBatch(db);
      const acctRef = doc(collection(db, 'bank_accounts'));
      batch.set(acctRef, {
        ownerId: user.uid,
        accountName: trimmedName,
        institutionName: trimmedInstitution,
        accountType: 'purchases',
        accountMask: trimmedMask,
        currency: workspace?.preferredCurrency || 'USD',
        balance: Math.round(parsedBalance * 100) / 100,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'users', user.uid), {
        purchasesAccountId: acctRef.id,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      setPurchasesDraftId(null);
      setCreatePurchasesModalOpen(false);
      setPurchasesFeedback({
        type: 'success',
        message: `Provisioned "${trimmedName}" (····${trimmedMask}) and assigned it as your Account for Purchases.`,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'bank_accounts');
    } finally {
      setCreatingPurchasesAcct(false);
    }
  };

  const openAcquisitionWorkflow = (item: AcquisitionArchitecture) => {
    setWorkflowTargetId(item.id);
    setWorkflowFundingAccountId(
      item.fundingAccountId || designatedPurchasesAccount?.id || accounts[0]?.id || '',
    );
    setWorkflowEnteredCode('');
    setWorkflowOnboardAsset(true);
    setWorkflowAssetName(item.targetCounterparty.slice(0, 140));
    const tickerSeed = item.targetCounterparty
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 6);
    setWorkflowTicker(tickerSeed ? `${tickerSeed}-ACQ` : 'ACQ-HOLD');
    setWorkflowQuantity('1');
    setWorkflowJurisdiction('United States');
    setWorkflowError(null);
    setSelectedAcqId(item.id);
  };

  const handleWorkflowCompleteDiligence = async () => {
    if (!user || !workflowTargetAcq) return;
    setWorkflowError(null);
    const chosenAccountId = workflowFundingAccountId || workflowTargetAcq.fundingAccountId;
    if (!chosenAccountId || !accountMap.has(chosenAccountId)) {
      setWorkflowError('Select a valid funding account before advancing diligence.');
      return;
    }

    setWorkflowRunning(true);
    try {
      await updateDoc(doc(db, 'acquisition_architectures', workflowTargetAcq.id), {
        fundingAccountId: chosenAccountId,
        stage: 'diligence',
        diligenceCompleted: true,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `acquisition_architectures/${workflowTargetAcq.id}`,
      );
    } finally {
      setWorkflowRunning(false);
    }
  };

  const handleWorkflowFundEscrow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !workflowTargetAcq) return;
    setWorkflowError(null);

    const chosenAccountId = workflowFundingAccountId || workflowTargetAcq.fundingAccountId;
    const fundingAcct = accountMap.get(chosenAccountId);
    if (!fundingAcct) {
      setWorkflowError('Select a valid Account for Purchases / funding bank account.');
      return;
    }
    if (fundingAcct.status !== 'active') {
      setWorkflowError(`Account "${fundingAcct.accountName}" is ${fundingAcct.status} and cannot fund escrow.`);
      return;
    }
    if (workflowTargetAcq.committedCapitalUsd > 100000000) {
      setWorkflowError(
        'Escrow wire amount exceeds the $100,000,000 single-payment settlement ceiling. Split commitment across tranches.',
      );
      return;
    }
    if (fundingAcct.balance < workflowTargetAcq.committedCapitalUsd) {
      setWorkflowError(
        `Insufficient liquidity in ${fundingAcct.accountName} (${formatCurrency(fundingAcct.balance)} available vs ${formatCurrency(workflowTargetAcq.committedCapitalUsd)} committed).`,
      );
      return;
    }

    if (workflowTargetAcq.mfaSignoffRequired) {
      const validTotp = await verifyTotpCode(workflowTotpSecret, workflowEnteredCode);
      if (!validTotp) {
        setWorkflowError('Invalid 6-digit RFC-6238 TOTP authenticator token.');
        return;
      }
    }

    const mappedPayRail: PaymentRail =
      workflowTargetAcq.settlementRail === 'ACH' ||
      workflowTargetAcq.settlementRail === 'FEDNOW' ||
      workflowTargetAcq.settlementRail === 'INTERNAL'
        ? workflowTargetAcq.settlementRail
        : 'WIRE';

    setWorkflowRunning(true);
    try {
      const batch = writeBatch(db);
      const payRef = doc(collection(db, 'payments'));
      const txRef = doc(collection(db, 'transactions'));
      const nextBalance =
        Math.round((fundingAcct.balance - workflowTargetAcq.committedCapitalUsd) * 100) / 100;

      batch.set(payRef, {
        ownerId: user.uid,
        sourceAccountId: fundingAcct.id,
        recipientName: workflowTargetAcq.escrowAgent.trim().slice(0, 120),
        recipientRoutingMask: 'ACQESC01',
        paymentRail: mappedPayRail,
        amount: workflowTargetAcq.committedCapitalUsd,
        memo: `Acquisition Escrow: ${workflowTargetAcq.architectureName}`.slice(0, 160),
        mfaVerified: true,
        idempotencyKey: generateSafeId('ACQESC'),
        status: 'settled',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(txRef, {
        ownerId: user.uid,
        accountId: fundingAcct.id,
        merchant: workflowTargetAcq.escrowAgent.trim().slice(0, 120),
        description: `Acquisition Escrow Funding: ${workflowTargetAcq.architectureName}`.slice(0, 240),
        amount: workflowTargetAcq.committedCapitalUsd,
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

      batch.update(doc(db, 'bank_accounts', fundingAcct.id), {
        balance: nextBalance,
        updatedAt: serverTimestamp(),
      });

      batch.update(doc(db, 'acquisition_architectures', workflowTargetAcq.id), {
        fundingAccountId: fundingAcct.id,
        stage: 'escrow_funded',
        diligenceCompleted: true,
        escrowPaymentId: payRef.id,
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
      setWorkflowEnteredCode('');
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.WRITE,
        `acquisition_architectures/${workflowTargetAcq.id}`,
      );
    } finally {
      setWorkflowRunning(false);
    }
  };

  const handleWorkflowFinalizeClosing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !workflowTargetAcq) return;
    setWorkflowError(null);

    const qty = Number(workflowQuantity);
    const trimmedAssetName = workflowAssetName.trim();
    const trimmedTicker = workflowTicker.trim();
    const trimmedJurisdiction = workflowJurisdiction.trim();

    if (workflowOnboardAsset) {
      if (trimmedAssetName.length < 2 || trimmedAssetName.length > 140) {
        setWorkflowError('Acquired asset name must be 2 to 140 characters.');
        return;
      }
      if (trimmedTicker.length < 1 || trimmedTicker.length > 48) {
        setWorkflowError('Asset ticker / CUSIP / deed identifier must be 1 to 48 characters.');
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1000000000) {
        setWorkflowError('Quantity must be greater than zero.');
        return;
      }
      if (trimmedJurisdiction.length < 2 || trimmedJurisdiction.length > 80) {
        setWorkflowError('Jurisdiction must be at least 2 characters.');
        return;
      }
    }

    setWorkflowRunning(true);
    try {
      const batch = writeBatch(db);
      let onboardedId = '';

      if (workflowOnboardAsset) {
        const assetRef = doc(collection(db, 'assets'));
        onboardedId = assetRef.id;
        const assetMeta = ACQUISITION_ASSET_CLASS_MAP[workflowTargetAcq.acquisitionType];
        const acctCurrency =
          accountMap.get(workflowTargetAcq.fundingAccountId)?.currency ||
          workspace?.preferredCurrency ||
          'USD';
        const unitCostBasis =
          Math.round((workflowTargetAcq.committedCapitalUsd / qty) * 100) / 100;

        batch.set(assetRef, {
          ownerId: user.uid,
          ingestionId: '',
          accountId: workflowTargetAcq.fundingAccountId,
          firmId: workflowTargetAcq.firmId || '',
          assetName: trimmedAssetName,
          tickerOrIdentifier: trimmedTicker,
          assetCategoryGroup: assetMeta.group,
          assetClass: assetMeta.assetClass,
          quantity: qty,
          unitCostBasis,
          totalMarketValue: Math.min(workflowTargetAcq.targetValuationUsd, 10000000000),
          currency: acctCurrency,
          valuationDate: new Date().toISOString().slice(0, 10),
          jurisdiction: trimmedJurisdiction,
          regulatoryClassification: assetMeta.regulatoryClassification,
          mfaVerified: false,
          custodyStatus: 'pending_verification',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      batch.update(doc(db, 'acquisition_architectures', workflowTargetAcq.id), {
        stage: 'closed',
        onboardedAssetId: onboardedId,
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.WRITE,
        `acquisition_architectures/${workflowTargetAcq.id}`,
      );
    } finally {
      setWorkflowRunning(false);
    }
  };

  const handleWorkflowCancelAcq = async () => {
    if (!user || !workflowTargetAcq) return;
    setWorkflowError(null);
    setWorkflowRunning(true);
    try {
      await updateDoc(doc(db, 'acquisition_architectures', workflowTargetAcq.id), {
        stage: 'cancelled',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `acquisition_architectures/${workflowTargetAcq.id}`,
      );
    } finally {
      setWorkflowRunning(false);
    }
  };

  const openNewAcqModal = (presetType: AcquisitionType = 'strategic_ma_buyout') => {
    const meta = ACQUISITION_TYPE_META[presetType];
    setEditingAcqArch(null);
    setAcqForm({
      fundingAccountId:
        workspace?.purchasesAccountId || designatedPurchasesAccount?.id || accounts[0]?.id || '',
      firmId: firms[0]?.id || '',
      architectureName: '',
      acquisitionType: presetType,
      targetCounterparty: '',
      dealStructure: meta.defaultDealStructure,
      escrowAgent: meta.defaultEscrowAgent,
      closingHorizon: meta.defaultClosingHorizon,
      settlementRail: meta.defaultRail,
      targetValuationUsd: '2500000',
      committedCapitalUsd: '500000',
      escrowHoldbackPct: '10',
      diligenceGateRequired: true,
      mfaSignoffRequired: true,
      stage: 'pipeline',
    });
    setAcqFormError(null);
    setAcqModalOpen(true);
  };

  const openEditAcqModal = (item: AcquisitionArchitecture) => {
    setEditingAcqArch(item);
    setAcqForm({
      fundingAccountId: item.fundingAccountId,
      firmId: item.firmId,
      architectureName: item.architectureName,
      acquisitionType: item.acquisitionType,
      targetCounterparty: item.targetCounterparty,
      dealStructure: item.dealStructure,
      escrowAgent: item.escrowAgent,
      closingHorizon: item.closingHorizon,
      settlementRail: item.settlementRail,
      targetValuationUsd: String(item.targetValuationUsd),
      committedCapitalUsd: String(item.committedCapitalUsd),
      escrowHoldbackPct: String(item.escrowHoldbackPct),
      diligenceGateRequired: item.diligenceGateRequired,
      mfaSignoffRequired: item.mfaSignoffRequired,
      stage: item.stage,
    });
    setAcqFormError(null);
    setAcqModalOpen(true);
  };

  const handleSaveAcqArch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setAcqFormError(null);

    const targetValuationUsd = Number(acqForm.targetValuationUsd);
    const committedCapitalUsd = Number(acqForm.committedCapitalUsd);
    const escrowHoldbackPct = Number(acqForm.escrowHoldbackPct);

    if (!acqForm.fundingAccountId) {
      setAcqFormError('Select a funding cash bank account.');
      return;
    }
    if (acqForm.architectureName.trim().length < 2) {
      setAcqFormError('Pipeline name must be at least 2 characters.');
      return;
    }
    if (acqForm.targetCounterparty.trim().length < 2) {
      setAcqFormError('Target counterparty must be at least 2 characters.');
      return;
    }
    if (acqForm.dealStructure.trim().length < 2 || acqForm.escrowAgent.trim().length < 2) {
      setAcqFormError('Deal structure and escrow agent must each be at least 2 characters.');
      return;
    }
    if (
      !Number.isFinite(targetValuationUsd) ||
      targetValuationUsd <= 0 ||
      targetValuationUsd > 100000000000
    ) {
      setAcqFormError('Target valuation must be greater than zero and within institutional limits.');
      return;
    }
    if (
      !Number.isFinite(committedCapitalUsd) ||
      committedCapitalUsd <= 0 ||
      committedCapitalUsd > 100000000000
    ) {
      setAcqFormError('Committed capital must be greater than zero.');
      return;
    }
    if (!Number.isFinite(escrowHoldbackPct) || escrowHoldbackPct < 0 || escrowHoldbackPct > 50) {
      setAcqFormError('Escrow holdback must be between 0% and 50%.');
      return;
    }

    const safeStage: AcquisitionStage =
      !editingAcqArch && !['pipeline', 'diligence'].includes(acqForm.stage)
        ? 'pipeline'
        : acqForm.stage;

    setSavingAcq(true);
    try {
      const payload = {
        fundingAccountId: acqForm.fundingAccountId,
        firmId: acqForm.firmId,
        architectureName: acqForm.architectureName.trim().slice(0, 140),
        acquisitionType: acqForm.acquisitionType,
        targetCounterparty: acqForm.targetCounterparty.trim().slice(0, 140),
        dealStructure: acqForm.dealStructure.trim().slice(0, 100),
        escrowAgent: acqForm.escrowAgent.trim().slice(0, 100),
        closingHorizon: acqForm.closingHorizon.trim().slice(0, 60),
        settlementRail: acqForm.settlementRail,
        targetValuationUsd,
        committedCapitalUsd,
        escrowHoldbackPct,
        diligenceGateRequired: acqForm.diligenceGateRequired,
        mfaSignoffRequired: acqForm.mfaSignoffRequired,
        stage: safeStage,
        updatedAt: serverTimestamp(),
      };

      if (editingAcqArch) {
        await updateDoc(doc(db, 'acquisition_architectures', editingAcqArch.id), payload);
      } else {
        await addDoc(collection(db, 'acquisition_architectures'), {
          ownerId: user.uid,
          ...payload,
          diligenceCompleted: safeStage === 'diligence',
          escrowPaymentId: '',
          onboardedAssetId: '',
          createdAt: serverTimestamp(),
        });
      }
      setAcqModalOpen(false);
    } catch (error) {
      handleFirestoreError(
        error,
        editingAcqArch ? OperationType.UPDATE : OperationType.CREATE,
        'acquisition_architectures',
      );
    } finally {
      setSavingAcq(false);
    }
  };

  const handleDeleteAcqArch = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'acquisition_architectures', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `acquisition_architectures/${id}`);
    }
  };

  const exportAcqCsv = () => {
    const headers = [
      'Pipeline Name',
      'Acquisition Type',
      'Counterparty',
      'Funding Account',
      'Brokerage Firm',
      'Deal Structure',
      'Escrow Agent',
      'Closing Horizon',
      'Settlement Rail',
      'Target Valuation USD',
      'Committed Capital USD',
      'Escrow Holdback %',
      'Diligence Gate',
      'MFA Sign-off',
      'Stage',
    ];
    const rows = filteredAcqArchs.map((a) =>
      [
        a.architectureName,
        ACQUISITION_TYPE_META[a.acquisitionType].label,
        a.targetCounterparty,
        accountMap.get(a.fundingAccountId)?.accountName || a.fundingAccountId,
        a.firmId ? firmMap.get(a.firmId)?.firmName || a.firmId : 'Direct Escrow',
        a.dealStructure,
        a.escrowAgent,
        a.closingHorizon,
        a.settlementRail,
        a.targetValuationUsd,
        a.committedCapitalUsd,
        a.escrowHoldbackPct,
        a.diligenceGateRequired,
        a.mfaSignoffRequired,
        a.stage,
      ]
        .map(csvEscape)
        .join(','),
    );
    downloadTextFile(
      'veridian-acquisition-architecture.csv',
      [headers.join(','), ...rows].join('\n'),
    );
  };

  const exportAcqJson = () => {
    downloadTextFile(
      'veridian-acquisition-architecture.json',
      JSON.stringify(filteredAcqArchs, null, 2),
      'application/json',
    );
  };

  return (
    <div className="space-y-6">
      {/* Top Sub-Navigation Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'recovery', label: 'Account Recovery', icon: ShieldCheck },
              { id: 'bank', label: 'Bank Tx Architecture', icon: Landmark },
              { id: 'brokerage', label: 'Brokerage Tx Architecture (All 8)', icon: Building2 },
              { id: 'rails', label: 'Rail Architecture', icon: Network },
              { id: 'acquisition', label: 'Acquisition Architecture', icon: Briefcase },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = subTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSubTab(tab.id)}
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
          {bankTxArchitectures.length} Bank · {coveredBrokerageCount}/8 Brokerage ·{' '}
          {railArchitectures.length} Rails · {acquisitionArchitectures.length} Acquisitions
        </div>
      </div>

      {/* =================================================================== */}
      {/* TAB 1: ACCOUNT RECOVERY                                             */}
      {/* =================================================================== */}
      {subTab === 'recovery' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Recovery Posture</p>
              <p
                className={`mt-2 text-xl font-semibold font-display ${
                  recoveryConfig?.recoveryStatus === 'recovery_hold'
                    ? 'text-amber-700'
                    : recoveryConfig?.recoveryStatus === 'drill_verified'
                      ? 'text-emerald-700'
                      : 'text-slate-900'
                }`}
              >
                {recoveryConfig?.recoveryStatus === 'recovery_hold'
                  ? 'Recovery Hold'
                  : recoveryConfig?.recoveryStatus === 'drill_verified'
                    ? 'Drill Verified'
                    : 'Configured'}
              </p>
              <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                Last drill {recoveryConfig?.lastDrillAt || 'Pending'}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Quorum Time-Lock</p>
              <p className="mt-2 text-xl font-semibold text-slate-900 font-mono tabular-nums">
                {recoveryConfig?.timeLockHours ?? 48} Hours
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {recoveryConfig?.dualControlRequired ?? true
                  ? 'Dual-control steward required'
                  : 'Single-signer override'}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Cryptographic Backup Kit</p>
              <p className="mt-2 text-xl font-semibold text-slate-900 font-mono tabular-nums">
                {recoveryConfig?.backupCodesRemaining ?? 8} / 8 Codes
              </p>
              <p className="mt-1 text-xs text-slate-500 font-mono truncate">
                Batch {recoveryConfig?.recoveryCodeBatchId || 'Initial'}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Hardware Key &amp; Steward</p>
              <p className="mt-2 text-sm font-semibold text-slate-900 truncate">
                {recoveryConfig?.hardwareKeyLabel || 'YubiKey 5C NFC'}
              </p>
              <p className="mt-1 text-xs text-slate-500 truncate">
                {recoveryConfig?.trustedContactName || 'Unassigned Steward'}
              </p>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="pb-4 mb-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900 font-display">
                  Account Recovery &amp; Quorum Continuity Policy
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Isolated Firestore recovery vault with hardware FIDO2 registration, steward dual-control, cryptographic recovery codes, and TOTP drill verification.
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500">
                /users/&#123;uid&#125;/private/recovery
              </span>
            </div>

            <AccountRecoveryPanel
              recoveryConfig={recoveryConfig}
              privateProfile={privateProfile}
            />
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* TAB 2: BANK TRANSACTION ARCHITECTURE                                */}
      {/* =================================================================== */}
      {subTab === 'bank' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Active Bank Policies</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {bankTxArchitectures.filter((b) => b.status === 'active').length}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                of {bankTxArchitectures.length} configured patterns
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Peak Single-Tx Ceiling</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCompactCurrency(
                  Math.max(0, ...bankTxArchitectures.map((b) => b.singleTxLimit)),
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">Per-instruction cap</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Max Daily Aggregate Cap</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCompactCurrency(
                  Math.max(0, ...bankTxArchitectures.map((b) => b.dailyLimit)),
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">24h velocity envelope</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Dual-Approval Rules</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {bankTxArchitectures.filter((b) => b.dualApprovalRequired).length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Maker-checker gated</p>
            </div>
          </div>

          {/* Live Bank Transaction Route Evaluator */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900 font-display">
                  Bank Transaction Route &amp; Control Evaluator
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Simulate a banking instruction against persisted account routing rules, AML screening, and TOTP MFA gates.
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {BANK_FLOW_META[evalFlow].defaultRail} · {BANK_FLOW_META[evalFlow].defaultWindow}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Originating Bank Account
                </label>
                <select
                  value={effectiveEvalAccountId}
                  onChange={(e) => setEvalAccountId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
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
                  Bank Flow Pattern
                </label>
                <select
                  value={evalFlow}
                  onChange={(e) => setEvalFlow(e.target.value as BankFlowPattern)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {BANK_FLOW_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {BANK_FLOW_META[key].label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Simulated Notional ($)
                </label>
                <input
                  type="number"
                  min="1"
                  value={evalAmount}
                  onChange={(e) => setEvalAmount(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg bg-white"
                />
              </div>
            </div>

            {matchedBankPolicy ? (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      Matched Policy: {matchedBankPolicy.ruleName}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                      Rail {matchedBankPolicy.primaryRail} · Window {matchedBankPolicy.settlementWindow} · Single Cap{' '}
                      {formatCurrency(matchedBankPolicy.singleTxLimit)} · Daily Cap{' '}
                      {formatCurrency(matchedBankPolicy.dailyLimit)}
                    </p>
                  </div>
                  <div className="text-right">
                    {matchedBankPolicy.status !== 'active' ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
                        <ShieldAlert className="w-4 h-4" />
                        <span>Policy Status: {matchedBankPolicy.status.toUpperCase()}</span>
                      </span>
                    ) : evalAmountNum > matchedBankPolicy.singleTxLimit ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700">
                        <ShieldAlert className="w-4 h-4" />
                        <span>Exceeds Single-Tx Limit</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>
                          Cleared ·{' '}
                          {evalAmountNum >= matchedBankPolicy.mfaThreshold
                            ? 'TOTP MFA Triggered'
                            : 'Below MFA Threshold'}
                          {matchedBankPolicy.dualApprovalRequired ? ' + Dual Control' : ''}
                        </span>
                      </span>
                    )}
                  </div>
                </div>

                {/* 5-Stage Pipeline Strip */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 border border-slate-200 rounded-lg bg-white divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
                  {BANK_FLOW_META[evalFlow].stages.map((stage, index) => (
                    <div key={stage} className="p-3">
                      <span className="text-[11px] font-mono text-slate-400">
                        STAGE 0{index + 1}
                      </span>
                      <p className="text-xs font-medium text-slate-900 mt-1">{stage}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-600">
                  No rule configured yet for <span className="font-medium text-slate-900">{BANK_FLOW_META[evalFlow].label}</span>. Create a rule to enforce limits and reconciliation.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setEditingBankArch(null);
                    setBankForm({
                      accountId: effectiveEvalAccountId,
                      ruleName: `${BANK_FLOW_META[evalFlow].label} Policy`,
                      flowPattern: evalFlow,
                      primaryRail: BANK_FLOW_META[evalFlow].defaultRail,
                      settlementWindow: BANK_FLOW_META[evalFlow].defaultWindow,
                      singleTxLimit: '250000',
                      dailyLimit: '1000000',
                      mfaThreshold: '10000',
                      dualApprovalRequired: true,
                      autoReconcile: true,
                      amlScreeningLevel: 'enhanced',
                      status: 'active',
                    });
                    setBankFormError(null);
                    setBankModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Matching Rule</span>
                </button>
              </div>
            )}
          </div>

          {/* Bank Tx Architecture Directory Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={bankSearch}
                  onChange={(e) => setBankSearch(e.target.value)}
                  placeholder="Search rule, rail, account..."
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg w-56"
                />
                <select
                  value={bankFlowFilter}
                  onChange={(e) => setBankFlowFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="ALL">All Flow Patterns</option>
                  {BANK_FLOW_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {BANK_FLOW_META[key].label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={exportBankCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>CSV</span>
                </button>
                <button
                  type="button"
                  onClick={exportBankJson}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>JSON</span>
                </button>
                <button
                  type="button"
                  onClick={openNewBankModal}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Bank Rule</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-3 px-4">Rule &amp; Window</th>
                    <th className="py-3 px-4">Account</th>
                    <th className="py-3 px-4">Flow &amp; Rail</th>
                    <th className="py-3 px-4 text-right">Single / Daily / MFA</th>
                    <th className="py-3 px-4">Controls</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {filteredBankArchs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        No bank transaction architectures match your filters.
                      </td>
                    </tr>
                  ) : (
                    filteredBankArchs.map((item) => {
                      const acct = accountMap.get(item.accountId);
                      return (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-900">{item.ruleName}</p>
                            <p className="text-[11px] text-slate-500">{item.settlementWindow}</p>
                          </td>
                          <td className="py-3 px-4 text-slate-700">
                            {acct ? `${acct.accountName} (····${acct.accountMask})` : item.accountId}
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-slate-900">{BANK_FLOW_META[item.flowPattern].label}</p>
                            <p className="text-[11px] font-mono text-slate-500">{item.primaryRail}</p>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                            <p>{formatCompactCurrency(item.singleTxLimit)} / tx</p>
                            <p className="text-[11px] text-slate-500">
                              {formatCompactCurrency(item.dailyLimit)} day · MFA ≥{' '}
                              {formatCompactCurrency(item.mfaThreshold)}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-slate-600">
                            <p className="capitalize">AML: {item.amlScreeningLevel}</p>
                            <p className="text-[11px] text-slate-500">
                              {item.dualApprovalRequired ? 'Dual Control' : 'Single Signer'} ·{' '}
                              {item.autoReconcile ? 'Auto-Recon' : 'Manual Recon'}
                            </p>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <span
                              className={
                                item.status === 'active'
                                  ? 'text-emerald-700 font-medium'
                                  : item.status === 'paused'
                                    ? 'text-amber-700 font-medium'
                                    : 'text-slate-500'
                              }
                            >
                              {item.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleToggleBankStatus(item)}
                                title={item.status === 'active' ? 'Pause rule' : 'Activate rule'}
                                className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer"
                              >
                                {item.status === 'active' ? (
                                  <Pause className="w-3.5 h-3.5" />
                                ) : (
                                  <Play className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditBankModal(item)}
                                title="Edit rule"
                                className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeleteBankArch(item.id)}
                                title="Delete rule"
                                className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded cursor-pointer"
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
      {/* TAB 3: ALL BROKERAGE TRANSACTION ARCHITECTURE (8 CLASSES)           */}
      {/* =================================================================== */}
      {subTab === 'brokerage' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Transaction Class Coverage</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {coveredBrokerageCount} / 8 Classes
              </p>
              <p className="mt-1 text-xs text-slate-500">Full institutional brokerage scope</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Active Pipelines</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {brokerageTxArchitectures.filter((b) => b.status === 'active').length}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                of {brokerageTxArchitectures.length} brokerage policies
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Peak Order / Trade Cap</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCompactCurrency(
                  Math.max(0, ...brokerageTxArchitectures.map((b) => b.maxOrderNotional)),
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">Max single-ticket notional</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">MFA-Enforced Workflows</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {brokerageTxArchitectures.filter((b) => b.mfaRequired).length} /{' '}
                {brokerageTxArchitectures.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">TOTP / hardware key gated</p>
            </div>
          </div>

          {/* 8-Class Brokerage Coverage Matrix + Interactive Pipeline Inspector */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900 font-display">
                  All-Class Brokerage Transaction Matrix &amp; Pipeline Inspector
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Select any of the 8 brokerage transaction architectures to inspect its clearing venue, settlement cycle, regulatory controls, and 5-stage execution lifecycle.
                </p>
              </div>
              <button
                type="button"
                onClick={() => openNewBrokerageModal(selectedBrokerageType)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add {BROKERAGE_TX_META[selectedBrokerageType].label}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              {BROKERAGE_TYPE_KEYS.map((txType) => {
                const meta = BROKERAGE_TX_META[txType];
                const items = brokerageCoverageByType.get(txType) || [];
                const activeCount = items.filter((i) => i.status === 'active').length;
                const isSelected = selectedBrokerageType === txType;
                return (
                  <button
                    key={txType}
                    type="button"
                    onClick={() => setSelectedBrokerageType(txType)}
                    className={`text-left p-3.5 rounded-lg border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-900 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-[11px] font-mono ${
                          isSelected ? 'text-slate-300' : 'text-slate-500'
                        }`}
                      >
                        {meta.defaultCycle}
                      </span>
                      <span
                        className={`text-[11px] font-mono tabular-nums ${
                          isSelected
                            ? 'text-emerald-300'
                            : activeCount > 0
                              ? 'text-emerald-700'
                              : 'text-amber-700'
                        }`}
                      >
                        {items.length > 0 ? `${activeCount} Active` : 'Unconfigured'}
                      </span>
                    </div>
                    <p className="text-xs font-semibold mt-1.5 leading-snug">{meta.label}</p>
                    <p
                      className={`text-[11px] mt-1 truncate ${
                        isSelected ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {meta.defaultVenue}
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Selected Brokerage Architecture Inspector */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500">
                    Selected Brokerage Workflow · {selectedBrokerageType}
                  </span>
                  <h3 className="text-sm font-semibold text-slate-900 mt-0.5">
                    {selectedBrokerageArch
                      ? selectedBrokerageArch.architectureName
                      : `${BROKERAGE_TX_META[selectedBrokerageType].label} Blueprint`}
                  </h3>
                  <p className="text-xs text-slate-600 mt-1">
                    Venue:{' '}
                    <span className="font-medium text-slate-900">
                      {selectedBrokerageArch?.clearingVenue ||
                        BROKERAGE_TX_META[selectedBrokerageType].defaultVenue}
                    </span>{' '}
                    · Custody:{' '}
                    <span className="font-medium text-slate-900">
                      {selectedBrokerageArch?.custodyModel ||
                        BROKERAGE_TX_META[selectedBrokerageType].defaultCustody}
                    </span>
                  </p>
                </div>

                {selectedBrokerageArch ? (
                  <div className="text-right text-xs font-mono tabular-nums space-y-0.5">
                    <p className="text-slate-900 font-semibold">
                      Max Notional: {formatCurrency(selectedBrokerageArch.maxOrderNotional)}
                    </p>
                    <p className="text-slate-500">
                      Firm: {firmMap.get(selectedBrokerageArch.firmId)?.firmName || 'Registered Firm'} ·
                      Rail: {selectedBrokerageArch.primaryRail}
                    </p>
                    <p className="text-slate-500">
                      Control: {selectedBrokerageArch.regulatoryControl}
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => openNewBrokerageModal(selectedBrokerageType)}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                  >
                    Provision This Architecture
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 border border-slate-200 rounded-lg bg-white divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
                {BROKERAGE_TX_META[selectedBrokerageType].stages.map((stage, idx) => (
                  <div key={stage} className="p-3">
                    <span className="text-[11px] font-mono text-slate-400">STEP 0{idx + 1}</span>
                    <p className="text-xs font-medium text-slate-900 mt-1">{stage}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Full Brokerage Architecture Directory Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={brokerageSearch}
                  onChange={(e) => setBrokerageSearch(e.target.value)}
                  placeholder="Search brokerage workflow, venue, rule..."
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg w-60"
                />
                <select
                  value={brokerageTypeFilter}
                  onChange={(e) => setBrokerageTypeFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="ALL">All 8 Transaction Classes</option>
                  {BROKERAGE_TYPE_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {BROKERAGE_TX_META[key].label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={exportBrokerageCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>CSV</span>
                </button>
                <button
                  type="button"
                  onClick={exportBrokerageJson}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => openNewBrokerageModal()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Brokerage Architecture</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-3 px-4">Architecture &amp; Class</th>
                    <th className="py-3 px-4">Firm &amp; Settlement Acct</th>
                    <th className="py-3 px-4">Venue &amp; Custody</th>
                    <th className="py-3 px-4">Regulatory Control</th>
                    <th className="py-3 px-4 text-right">Rail &amp; Max Notional</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {filteredBrokerageArchs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        No brokerage transaction architectures match your filters.
                      </td>
                    </tr>
                  ) : (
                    filteredBrokerageArchs.map((item) => {
                      const firm = firmMap.get(item.firmId);
                      const acct = accountMap.get(item.settlementAccountId);
                      return (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-900">{item.architectureName}</p>
                            <p className="text-[11px] text-slate-500">
                              {BROKERAGE_TX_META[item.txType].label} · {item.settlementCycle}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-slate-900">{firm?.firmName || item.firmId}</p>
                            <p className="text-[11px] text-slate-500">
                              {acct ? `${acct.accountName} (····${acct.accountMask})` : item.settlementAccountId}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-slate-900">{item.clearingVenue}</p>
                            <p className="text-[11px] text-slate-500">{item.custodyModel}</p>
                          </td>
                          <td className="py-3 px-4 text-slate-700">
                            <p>{item.regulatoryControl}</p>
                            <p className="text-[11px] text-slate-500">
                              {item.mfaRequired ? 'TOTP MFA Required' : 'Standard Auth'}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            <p className="text-slate-900">{formatCompactCurrency(item.maxOrderNotional)}</p>
                            <p className="text-[11px] text-slate-500">{item.primaryRail}</p>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <button
                              type="button"
                              onClick={() => void handleCycleBrokerageStatus(item)}
                              title="Click to cycle status"
                              className={`cursor-pointer font-medium ${
                                item.status === 'active'
                                  ? 'text-emerald-700'
                                  : item.status === 'testing'
                                    ? 'text-amber-700'
                                    : 'text-red-700'
                              }`}
                            >
                              {item.status.toUpperCase()}
                            </button>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => openEditBrokerageModal(item)}
                                title="Edit brokerage architecture"
                                className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeleteBrokerageArch(item.id)}
                                title="Delete brokerage architecture"
                                className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded cursor-pointer"
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
      {/* TAB 4: RAIL ARCHITECTURE                                            */}
      {/* =================================================================== */}
      {subTab === 'rails' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Operational Rails</p>
              <p className="mt-2 text-2xl font-semibold text-emerald-700 font-mono tabular-nums">
                {railArchitectures.filter((r) => r.status === 'operational').length} /{' '}
                {railArchitectures.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Live payment &amp; clearing topology</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Degraded / Maintenance</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {railArchitectures.filter((r) => r.status !== 'operational').length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Failover-eligible routes</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Lowest Settlement Cost</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {railArchitectures.length > 0
                  ? `${Math.min(...railArchitectures.map((r) => r.feeBps)).toFixed(1)} bps`
                  : '0.0 bps'}
              </p>
              <p className="mt-1 text-xs text-slate-500">Optimal fee floor</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Highest Per-Tx Cap</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCompactCurrency(
                  Math.max(0, ...railArchitectures.map((r) => r.perTxCap)),
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">Institutional wire &amp; CNS ceiling</p>
            </div>
          </div>

          {/* Interactive Smart Rail Selector */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900 font-display">
                  Smart Payment &amp; Clearing Rail Selector
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Evaluate optimal rail selection, failover routing, basis-point cost, finality SLA, and MFA policy for any transfer notional.
                </p>
              </div>
              <Route className="w-4 h-4 text-slate-400" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Transfer Notional ($)
                </label>
                <input
                  type="number"
                  min="1"
                  value={selectorAmount}
                  onChange={(e) => setSelectorAmount(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Routing Objective
                </label>
                <select
                  value={selectorPriority}
                  onChange={(e) =>
                    setSelectorPriority(
                      e.target.value as
                        | 'lowest_fee'
                        | 'instant_finality'
                        | 'high_value_settlement'
                        | 'securities_clearing',
                    )
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="instant_finality">Instant Finality (24/7 Real-Time)</option>
                  <option value="lowest_fee">Lowest Basis-Point Cost (bps)</option>
                  <option value="high_value_settlement">Highest Per-Tx Capacity</option>
                  <option value="securities_clearing">Securities &amp; DVP Clearing</option>
                </select>
              </div>
            </div>

            {recommendedRailEvaluation.primary ? (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 lg:grid-cols-4 gap-4">
                <div>
                  <span className="text-[11px] font-mono text-slate-500">PRIMARY RAIL</span>
                  <p className="text-sm font-semibold text-slate-900 mt-1">
                    {recommendedRailEvaluation.primary.railCode} ·{' '}
                    {recommendedRailEvaluation.primary.railName}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {recommendedRailEvaluation.primary.protocolStandard}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] font-mono text-slate-500">FINALITY &amp; SLA</span>
                  <p className="text-sm font-semibold text-slate-900 mt-1">
                    {recommendedRailEvaluation.primary.settlementFinality}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    Latency: {recommendedRailEvaluation.primary.slaLatency} ·{' '}
                    {recommendedRailEvaluation.primary.cutoffWindow}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] font-mono text-slate-500">ESTIMATED RAIL FEE</span>
                  <p className="text-sm font-semibold text-slate-900 mt-1 font-mono tabular-nums">
                    {formatCurrency(
                      (selectorAmountNum * recommendedRailEvaluation.primary.feeBps) / 10000,
                    )}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                    {recommendedRailEvaluation.primary.feeBps.toFixed(1)} bps · Cap{' '}
                    {formatCompactCurrency(recommendedRailEvaluation.primary.perTxCap)}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] font-mono text-slate-500">
                    FAILOVER &amp; MFA GATE
                  </span>
                  <p className="text-sm font-semibold text-slate-900 mt-1 inline-flex items-center gap-1.5">
                    <span>{recommendedRailEvaluation.primary.railCode}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                    <span>{recommendedRailEvaluation.primary.failoverRailCode}</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 capitalize">
                    MFA: {recommendedRailEvaluation.primary.mfaPolicy.replace('_', ' ')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                No operational rail supports a single transfer of {formatCurrency(selectorAmountNum)}.
                Split into staged tranches or increase a rail&apos;s per-transaction cap below.
              </div>
            )}
          </div>

          {/* Rail Topology Directory Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={railSearch}
                  onChange={(e) => setRailSearch(e.target.value)}
                  placeholder="Search rail code, protocol, finality..."
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg w-60"
                />
                <select
                  value={railStatusFilter}
                  onChange={(e) => setRailStatusFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="ALL">All Operational States</option>
                  <option value="operational">Operational</option>
                  <option value="degraded">Degraded</option>
                  <option value="maintenance">Maintenance</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={exportRailCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>CSV</span>
                </button>
                <button
                  type="button"
                  onClick={exportRailJson}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>JSON</span>
                </button>
                <button
                  type="button"
                  onClick={openNewRailModal}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Rail Architecture</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-3 px-4">Rail &amp; Protocol</th>
                    <th className="py-3 px-4">Settlement Finality &amp; Window</th>
                    <th className="py-3 px-4">SLA &amp; Linked Account</th>
                    <th className="py-3 px-4 text-right">Per-Tx Cap &amp; Fee</th>
                    <th className="py-3 px-4">Failover &amp; MFA</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {filteredRailArchs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        No rail architectures match your filters.
                      </td>
                    </tr>
                  ) : (
                    filteredRailArchs.map((item) => {
                      const acct = accountMap.get(item.linkedAccountId);
                      return (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-900">
                              <span className="font-mono">{item.railCode}</span> · {item.railName}
                            </p>
                            <p className="text-[11px] text-slate-500">{item.protocolStandard}</p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-slate-900">{item.settlementFinality}</p>
                            <p className="text-[11px] text-slate-500">{item.cutoffWindow}</p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-mono text-slate-900">{item.slaLatency}</p>
                            <p className="text-[11px] text-slate-500">
                              {acct ? `${acct.accountName} (····${acct.accountMask})` : item.linkedAccountId}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            <p className="text-slate-900">{formatCompactCurrency(item.perTxCap)}</p>
                            <p className="text-[11px] text-slate-500">{item.feeBps.toFixed(1)} bps</p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-mono text-slate-900">
                              Failover: {item.failoverRailCode}
                            </p>
                            <p className="text-[11px] text-slate-500 capitalize">
                              {item.mfaPolicy.replace('_', ' ')}
                            </p>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <button
                              type="button"
                              onClick={() => void handleCycleRailStatus(item)}
                              title="Click to cycle operational state"
                              className={`cursor-pointer font-medium ${
                                item.status === 'operational'
                                  ? 'text-emerald-700'
                                  : item.status === 'degraded'
                                    ? 'text-amber-700'
                                    : 'text-slate-600'
                              }`}
                            >
                              {item.status.toUpperCase()}
                            </button>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => openEditRailModal(item)}
                                title="Edit rail architecture"
                                className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeleteRailArch(item.id)}
                                title="Delete rail architecture"
                                className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded cursor-pointer"
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
      {/* TAB 5: ACQUISITION ARCHITECTURE                                     */}
      {/* =================================================================== */}
      {subTab === 'acquisition' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Active Deal Pipelines</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {activeAcqPipelines.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                of {acquisitionArchitectures.length} total architectures
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Target Deal Valuation</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCompactCurrency(
                  activeAcqPipelines.reduce((sum, a) => sum + a.targetValuationUsd, 0),
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">Enterprise &amp; deed EV in pipeline</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Committed Escrow Capital</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {formatCompactCurrency(
                  activeAcqPipelines.reduce((sum, a) => sum + a.committedCapitalUsd, 0),
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                Holdback{' '}
                {formatCompactCurrency(
                  activeAcqPipelines.reduce(
                    (sum, a) => sum + (a.committedCapitalUsd * a.escrowHoldbackPct) / 100,
                    0,
                  ),
                )}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Purchases Treasury Liquidity</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                {designatedPurchasesAccount
                  ? formatCompactCurrency(designatedPurchasesAccount.balance)
                  : '$0.0'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {designatedPurchasesAccount
                  ? `${designatedPurchasesAccount.accountName} (····${designatedPurchasesAccount.accountMask})`
                  : 'No Purchases account assigned'}
              </p>
            </div>
          </div>

          {/* Designated Account for Purchases Control Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
                  <Wallet className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-slate-900 font-display">
                    Account for Purchases &amp; Acquisition Funding Treasury
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Designate the primary settlement bank account used to fund acquisition escrows,
                    M&amp;A buyouts, and capital calls across the Acquisition Workflow.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {openPipelinesNeedingPurchasesSync.length > 0 && designatedPurchasesAccount && (
                  <button
                    type="button"
                    disabled={applyingPurchasesBatch}
                    onClick={() => void handleApplyPurchasesToOpenPipelines()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                    <span>
                      {applyingPurchasesBatch
                        ? 'Routing...'
                        : `Route ${openPipelinesNeedingPurchasesSync.length} Open Pipeline(s)`}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setCreatePurchasesError(null);
                    setCreatePurchasesModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Purchases Account</span>
                </button>
              </div>
            </div>

            {purchasesFeedback && (
              <div
                className={`p-3 text-xs rounded-lg border ${
                  purchasesFeedback.type === 'success'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                {purchasesFeedback.message}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center p-4 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="lg:col-span-6 space-y-1">
                <p className="text-[11px] font-mono text-slate-500">
                  CURRENT ACCOUNT FOR PURCHASES
                </p>
                {designatedPurchasesAccount ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-slate-900">
                        {designatedPurchasesAccount.accountName}
                      </p>
                      <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-slate-900 text-white rounded">
                        PURCHASES ACCOUNT
                      </span>
                      <span className="text-xs font-mono text-slate-500">
                        {designatedPurchasesAccount.accountType.toUpperCase()} · ····
                        {designatedPurchasesAccount.accountMask}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 font-mono tabular-nums">
                      {designatedPurchasesAccount.institutionName} · Available{' '}
                      <span className="font-semibold text-slate-900">
                        {formatCurrency(
                          designatedPurchasesAccount.balance,
                          designatedPurchasesAccount.currency,
                        )}
                      </span>{' '}
                      · Routing {openPipelinesUsingPurchasesCount} active pipeline(s)
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-amber-700 font-medium">
                    No Purchases account is currently designated. Select an existing account or
                    create a dedicated Purchases account.
                  </p>
                )}
              </div>

              <div className="lg:col-span-6 flex flex-wrap items-center justify-end gap-2">
                <select
                  aria-label="Select Account for Purchases"
                  value={selectedPurchasesDraftId}
                  onChange={(e) => setPurchasesDraftId(e.target.value)}
                  className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white min-w-[240px] flex-1 sm:flex-initial"
                >
                  {accounts.map((acct) => (
                    <option key={acct.id} value={acct.id}>
                      {acct.accountName} (····{acct.accountMask}) ·{' '}
                      {formatCompactCurrency(acct.balance, acct.currency)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={
                    savingPurchasesAcct ||
                    !selectedPurchasesDraftId ||
                    selectedPurchasesDraftId === workspace?.purchasesAccountId
                  }
                  onClick={() => void handleSetPurchasesAccount()}
                  className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  {savingPurchasesAcct ? 'Updating...' : 'Set Purchases Account'}
                </button>
              </div>
            </div>
          </div>

          {/* Interactive Acquisition Deal-Flow & Liquidity Coverage Inspector */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900 font-display">
                  Acquisition Closing Topology &amp; Liquidity Coverage Inspector
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Execute multi-stage diligence gates, RFC-6238 TOTP MFA escrow funding from your
                  Purchases account, and permanent asset onboarding.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedAcqArch && (
                  <button
                    type="button"
                    onClick={() => openAcquisitionWorkflow(selectedAcqArch)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                  >
                    <PlayCircle className="w-3.5 h-3.5" />
                    <span>
                      {selectedAcqArch.stage === 'closed' || selectedAcqArch.stage === 'cancelled'
                        ? 'View Closing Audit'
                        : 'Execute Acquisition Workflow'}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openNewAcqModal()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Provision Pipeline</span>
                </button>
              </div>
            </div>

            {selectedAcqArch ? (
              (() => {
                const fundingAcct = accountMap.get(selectedAcqArch.fundingAccountId);
                const holdbackUsd =
                  (selectedAcqArch.committedCapitalUsd * selectedAcqArch.escrowHoldbackPct) / 100;
                const availableBalance = fundingAcct?.balance ?? 0;
                const liquidityCovered = availableBalance >= selectedAcqArch.committedCapitalUsd;
                const shortfall = Math.max(
                  0,
                  selectedAcqArch.committedCapitalUsd - availableBalance,
                );
                const activeStageStep = ACQUISITION_STAGE_INDEX[selectedAcqArch.stage];
                const meta = ACQUISITION_TYPE_META[selectedAcqArch.acquisitionType];
                const isPurchasesAcct =
                  !!designatedPurchasesAccount &&
                  selectedAcqArch.fundingAccountId === designatedPurchasesAccount.id;

                return (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <label
                          htmlFor="acq-inspector-select"
                          className="text-xs font-medium text-slate-700"
                        >
                          Inspect Pipeline:
                        </label>
                        <select
                          id="acq-inspector-select"
                          value={selectedAcqArch.id}
                          onChange={(e) => setSelectedAcqId(e.target.value)}
                          className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white font-medium text-slate-900"
                        >
                          {acquisitionArchitectures.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.architectureName} ({ACQUISITION_STAGE_LABELS[a.stage]})
                            </option>
                          ))}
                        </select>
                        {isPurchasesAcct && (
                          <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-slate-900 text-white rounded">
                            PURCHASES FUNDED
                          </span>
                        )}
                        {selectedAcqArch.escrowPaymentId && (
                          <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded">
                            ESCROW SETTLED
                          </span>
                        )}
                        {selectedAcqArch.onboardedAssetId && (
                          <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-slate-100 text-slate-800 border border-slate-200 rounded">
                            ASSET ONBOARDED
                          </span>
                        )}
                      </div>

                      <div className="text-xs font-mono tabular-nums">
                        {selectedAcqArch.stage === 'cancelled' ? (
                          <span className="inline-flex items-center gap-1.5 text-slate-600 font-medium">
                            <Lock className="w-3.5 h-3.5" />
                            <span>Deal Cancelled · Immutable Record</span>
                          </span>
                        ) : selectedAcqArch.stage === 'closed' ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                            <CheckCircle2 className="w-4 h-4" />
                            <span>
                              Closing Settled
                              {selectedAcqArch.escrowPaymentId
                                ? ` · Payment ${selectedAcqArch.escrowPaymentId.slice(0, 8)}`
                                : ''}
                            </span>
                          </span>
                        ) : liquidityCovered ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                            <CheckCircle2 className="w-4 h-4" />
                            <span>
                              100% Liquidity Covered ({formatCurrency(availableBalance)} in{' '}
                              {fundingAcct?.accountName || 'Funding Account'})
                            </span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-amber-700 font-medium">
                            <ShieldAlert className="w-4 h-4" />
                            <span>
                              Cash Shortfall {formatCurrency(shortfall)} vs.{' '}
                              {formatCurrency(availableBalance)} Available
                            </span>
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div>
                        <span className="text-[11px] font-mono text-slate-500">
                          TARGET COUNTERPARTY
                        </span>
                        <p className="text-sm font-semibold text-slate-900 mt-1">
                          {selectedAcqArch.targetCounterparty}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">{meta.label}</p>
                      </div>
                      <div>
                        <span className="text-[11px] font-mono text-slate-500">
                          STRUCTURE &amp; ESCROW AGENT
                        </span>
                        <p className="text-sm font-semibold text-slate-900 mt-1">
                          {selectedAcqArch.dealStructure}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Escrow: {selectedAcqArch.escrowAgent}
                        </p>
                      </div>
                      <div>
                        <span className="text-[11px] font-mono text-slate-500">
                          VALUATION &amp; COMMITMENT
                        </span>
                        <p className="text-sm font-semibold text-slate-900 mt-1 font-mono tabular-nums">
                          {formatCurrency(selectedAcqArch.committedCapitalUsd)} /{' '}
                          {formatCompactCurrency(selectedAcqArch.targetValuationUsd)} EV
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                          Holdback {selectedAcqArch.escrowHoldbackPct.toFixed(1)}% (
                          {formatCurrency(holdbackUsd)})
                        </p>
                      </div>
                      <div>
                        <span className="text-[11px] font-mono text-slate-500">
                          RAIL, HORIZON &amp; GATES
                        </span>
                        <p className="text-sm font-semibold text-slate-900 mt-1 font-mono">
                          {selectedAcqArch.settlementRail} · {selectedAcqArch.closingHorizon}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {selectedAcqArch.diligenceGateRequired ? 'Diligence Gate' : 'Fast-Track'}{' '}
                          ·{' '}
                          {selectedAcqArch.mfaSignoffRequired ? 'TOTP MFA Release' : 'Standard'}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 border border-slate-200 rounded-lg bg-white divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
                      {meta.stages.map((stageLabel, idx) => {
                        const completed =
                          selectedAcqArch.stage === 'closed' || idx < activeStageStep;
                        const current =
                          selectedAcqArch.stage !== 'cancelled' &&
                          selectedAcqArch.stage !== 'closed' &&
                          idx === activeStageStep;
                        return (
                          <div
                            key={stageLabel}
                            className={`p-3 ${current ? 'bg-slate-900 text-white' : ''}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`text-[11px] font-mono ${
                                  current
                                    ? 'text-slate-300'
                                    : completed
                                      ? 'text-emerald-700'
                                      : 'text-slate-400'
                                }`}
                              >
                                PHASE 0{idx + 1}
                              </span>
                              {completed && (
                                <CheckCircle2
                                  className={`w-3.5 h-3.5 ${
                                    current ? 'text-emerald-300' : 'text-emerald-600'
                                  }`}
                                />
                              )}
                            </div>
                            <p
                              className={`text-xs font-medium mt-1 ${
                                current ? 'text-white' : 'text-slate-900'
                              }`}
                            >
                              {stageLabel}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="p-6 bg-slate-50 border border-slate-200 rounded-lg text-center space-y-2">
                <p className="text-sm font-medium text-slate-900">
                  No acquisition architectures configured yet
                </p>
                <p className="text-xs text-slate-500">
                  Create an M&amp;A, commercial real estate deed, LP secondary, or treasury DVP
                  acquisition pipeline to enforce escrow holdbacks and closing liquidity checks.
                </p>
              </div>
            )}
          </div>

          {/* Acquisition Architecture Directory Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={acqSearch}
                  onChange={(e) => setAcqSearch(e.target.value)}
                  placeholder="Search pipeline, counterparty, escrow..."
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg w-60"
                />
                <select
                  value={acqTypeFilter}
                  onChange={(e) => setAcqTypeFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="ALL">All Acquisition Classes</option>
                  {ACQUISITION_TYPE_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {ACQUISITION_TYPE_META[key].label}
                    </option>
                  ))}
                </select>
                <select
                  value={acqStageFilter}
                  onChange={(e) => setAcqStageFilter(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="ALL">All Closing Stages</option>
                  {(Object.keys(ACQUISITION_STAGE_LABELS) as AcquisitionStage[]).map((st) => (
                    <option key={st} value={st}>
                      {ACQUISITION_STAGE_LABELS[st]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={exportAcqCsv}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>CSV</span>
                </button>
                <button
                  type="button"
                  onClick={exportAcqJson}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => openNewAcqModal()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Acquisition Pipeline</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-3 px-4">Pipeline &amp; Class</th>
                    <th className="py-3 px-4">Counterparty &amp; Escrow</th>
                    <th className="py-3 px-4">Funding Account &amp; Firm</th>
                    <th className="py-3 px-4 text-right">Target EV / Committed</th>
                    <th className="py-3 px-4">Rail &amp; Controls</th>
                    <th className="py-3 px-4">Stage &amp; Workflow</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {filteredAcqArchs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        No acquisition architectures match your filters.
                      </td>
                    </tr>
                  ) : (
                    filteredAcqArchs.map((item) => {
                      const acct = accountMap.get(item.fundingAccountId);
                      const firm = item.firmId ? firmMap.get(item.firmId) : null;
                      const isTerminal = item.stage === 'closed' || item.stage === 'cancelled';
                      const isPurchasesAcct =
                        !!designatedPurchasesAccount &&
                        item.fundingAccountId === designatedPurchasesAccount.id;
                      return (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-900">{item.architectureName}</p>
                            <p className="text-[11px] text-slate-500">
                              {ACQUISITION_TYPE_META[item.acquisitionType].label} ·{' '}
                              {item.closingHorizon}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="text-slate-900">{item.targetCounterparty}</p>
                            <p className="text-[11px] text-slate-500">
                              {item.escrowAgent} · {item.dealStructure}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="text-slate-900">
                                {acct
                                  ? `${acct.accountName} (····${acct.accountMask})`
                                  : item.fundingAccountId}
                              </p>
                              {isPurchasesAcct && (
                                <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-slate-900 text-white rounded">
                                  PURCHASES
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500">
                              {firm ? firm.firmName : 'Direct Treasury Escrow'}
                            </p>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            <p className="text-slate-900">
                              {formatCompactCurrency(item.committedCapitalUsd)} committed
                            </p>
                            <p className="text-[11px] text-slate-500">
                              EV {formatCompactCurrency(item.targetValuationUsd)} ·{' '}
                              {item.escrowHoldbackPct.toFixed(1)}% holdback
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-mono text-slate-900">{item.settlementRail}</p>
                            <p className="text-[11px] text-slate-500">
                              {item.diligenceGateRequired ? 'Diligence Gate' : 'No Gate'} ·{' '}
                              {item.mfaSignoffRequired ? 'MFA Sign-off' : 'Standard Auth'}
                            </p>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div className="flex flex-col items-start gap-1">
                              <span
                                className={`font-medium ${
                                  item.stage === 'closed'
                                    ? 'text-emerald-700'
                                    : item.stage === 'escrow_funded'
                                      ? 'text-blue-700'
                                      : item.stage === 'cancelled'
                                        ? 'text-slate-500'
                                        : 'text-amber-700'
                                }`}
                              >
                                {ACQUISITION_STAGE_LABELS[item.stage].toUpperCase()}
                              </span>
                              <button
                                type="button"
                                onClick={() => openAcquisitionWorkflow(item)}
                                className="inline-flex items-center gap-1 text-[11px] font-sans font-medium text-slate-800 hover:text-slate-950 underline cursor-pointer whitespace-nowrap"
                              >
                                <PlayCircle className="w-3 h-3" />
                                <span>
                                  {isTerminal ? 'Audit Summary' : 'Run Workflow'}
                                </span>
                              </button>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center justify-end gap-1.5">
                              {isTerminal ? (
                                <span
                                  title="Terminal acquisition records are locked"
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-slate-400 border border-slate-200 rounded"
                                >
                                  <Lock className="w-3 h-3" />
                                  <span>Locked</span>
                                </span>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => openEditAcqModal(item)}
                                    title="Edit acquisition pipeline"
                                    className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded cursor-pointer"
                                  >
                                    <Edit3 className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteAcqArch(item.id)}
                                    title="Delete acquisition pipeline"
                                    className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded cursor-pointer"
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
      {/* MODAL: CREATE / EDIT BANK TX ARCHITECTURE                           */}
      {/* =================================================================== */}
      {bankModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingBankArch ? 'Edit Bank Transaction Architecture' : 'Add Bank Transaction Architecture'}
              </h3>
              <button
                type="button"
                onClick={() => setBankModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveBankArch(e)} className="mt-4 space-y-4">
              {bankFormError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {bankFormError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Rule Name</label>
                  <input
                    type="text"
                    value={bankForm.ruleName}
                    onChange={(e) => setBankForm({ ...bankForm, ruleName: e.target.value })}
                    placeholder="e.g., Institutional Treasury Fedwire RTGS"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Linked Bank Account
                  </label>
                  <select
                    value={bankForm.accountId}
                    onChange={(e) => setBankForm({ ...bankForm, accountId: e.target.value })}
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
                    Flow Pattern
                  </label>
                  <select
                    value={bankForm.flowPattern}
                    onChange={(e) => {
                      const nextFlow = e.target.value as BankFlowPattern;
                      const meta = BANK_FLOW_META[nextFlow];
                      setBankForm({
                        ...bankForm,
                        flowPattern: nextFlow,
                        primaryRail: meta.defaultRail,
                        settlementWindow: meta.defaultWindow,
                      });
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {BANK_FLOW_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {BANK_FLOW_META[key].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Primary Rail</label>
                  <select
                    value={bankForm.primaryRail}
                    onChange={(e) =>
                      setBankForm({ ...bankForm, primaryRail: e.target.value as ArchRailCode })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {RAIL_CODES.map((rc) => (
                      <option key={rc} value={rc}>
                        {rc}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Settlement Window
                  </label>
                  <input
                    type="text"
                    value={bankForm.settlementWindow}
                    onChange={(e) => setBankForm({ ...bankForm, settlementWindow: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Single-Tx Limit ($)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    value={bankForm.singleTxLimit}
                    onChange={(e) => setBankForm({ ...bankForm, singleTxLimit: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Daily Aggregate Limit ($)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    value={bankForm.dailyLimit}
                    onChange={(e) => setBankForm({ ...bankForm, dailyLimit: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    TOTP MFA Threshold ($)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={bankForm.mfaThreshold}
                    onChange={(e) => setBankForm({ ...bankForm, mfaThreshold: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    AML Screening Level
                  </label>
                  <select
                    value={bankForm.amlScreeningLevel}
                    onChange={(e) =>
                      setBankForm({
                        ...bankForm,
                        amlScreeningLevel: e.target.value as AmlScreeningLevel,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="standard">Standard OFAC/BSA</option>
                    <option value="enhanced">Enhanced Velocity &amp; Sanctions</option>
                    <option value="institutional">Institutional Real-Time AML</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Status</label>
                  <select
                    value={bankForm.status}
                    onChange={(e) =>
                      setBankForm({ ...bankForm, status: e.target.value as BankArchStatus })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="draft">Draft</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap gap-5 pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bankForm.dualApprovalRequired}
                    onChange={(e) =>
                      setBankForm({ ...bankForm, dualApprovalRequired: e.target.checked })
                    }
                  />
                  <span>Require dual-control maker/checker approval</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bankForm.autoReconcile}
                    onChange={(e) => setBankForm({ ...bankForm, autoReconcile: e.target.checked })}
                  />
                  <span>Enable automated ledger reconciliation</span>
                </label>
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setBankModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBank}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingBank ? 'Saving...' : editingBankArch ? 'Save Rule' : 'Create Rule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: CREATE / EDIT BROKERAGE TX ARCHITECTURE                      */}
      {/* =================================================================== */}
      {brokerageModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingBrokerageArch
                  ? 'Edit Brokerage Transaction Architecture'
                  : 'Add Brokerage Transaction Architecture'}
              </h3>
              <button
                type="button"
                onClick={() => setBrokerageModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveBrokerageArch(e)} className="mt-4 space-y-4">
              {brokerageFormError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {brokerageFormError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Brokerage Transaction Class
                  </label>
                  <select
                    value={brokerageForm.txType}
                    onChange={(e) => {
                      const nextType = e.target.value as BrokerageTxType;
                      const meta = BROKERAGE_TX_META[nextType];
                      setBrokerageForm({
                        ...brokerageForm,
                        txType: nextType,
                        architectureName: editingBrokerageArch
                          ? brokerageForm.architectureName
                          : `${meta.label} Pipeline`,
                        clearingVenue: meta.defaultVenue,
                        settlementCycle: meta.defaultCycle,
                        custodyModel: meta.defaultCustody,
                        regulatoryControl: meta.defaultReg,
                        primaryRail: meta.defaultRail,
                      });
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {BROKERAGE_TYPE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {BROKERAGE_TX_META[key].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Architecture Name
                  </label>
                  <input
                    type="text"
                    value={brokerageForm.architectureName}
                    onChange={(e) =>
                      setBrokerageForm({ ...brokerageForm, architectureName: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Brokerage Firm
                  </label>
                  <select
                    value={brokerageForm.firmId}
                    onChange={(e) => setBrokerageForm({ ...brokerageForm, firmId: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                    required
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
                    Settlement Cash Account
                  </label>
                  <select
                    value={brokerageForm.settlementAccountId}
                    onChange={(e) =>
                      setBrokerageForm({ ...brokerageForm, settlementAccountId: e.target.value })
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
                    Clearing Venue
                  </label>
                  <input
                    type="text"
                    value={brokerageForm.clearingVenue}
                    onChange={(e) =>
                      setBrokerageForm({ ...brokerageForm, clearingVenue: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Settlement Cycle
                  </label>
                  <input
                    type="text"
                    value={brokerageForm.settlementCycle}
                    onChange={(e) =>
                      setBrokerageForm({ ...brokerageForm, settlementCycle: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Custody Model
                  </label>
                  <input
                    type="text"
                    value={brokerageForm.custodyModel}
                    onChange={(e) =>
                      setBrokerageForm({ ...brokerageForm, custodyModel: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Regulatory Control
                  </label>
                  <input
                    type="text"
                    value={brokerageForm.regulatoryControl}
                    onChange={(e) =>
                      setBrokerageForm({ ...brokerageForm, regulatoryControl: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Primary Clearing Rail
                  </label>
                  <select
                    value={brokerageForm.primaryRail}
                    onChange={(e) =>
                      setBrokerageForm({
                        ...brokerageForm,
                        primaryRail: e.target.value as ArchRailCode,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {RAIL_CODES.map((rc) => (
                      <option key={rc} value={rc}>
                        {rc}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Max Order / Trade Notional ($)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    value={brokerageForm.maxOrderNotional}
                    onChange={(e) =>
                      setBrokerageForm({ ...brokerageForm, maxOrderNotional: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Status</label>
                  <select
                    value={brokerageForm.status}
                    onChange={(e) =>
                      setBrokerageForm({
                        ...brokerageForm,
                        status: e.target.value as BrokerageArchStatus,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="active">Active</option>
                    <option value="testing">Testing</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>

                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={brokerageForm.mfaRequired}
                      onChange={(e) =>
                        setBrokerageForm({ ...brokerageForm, mfaRequired: e.target.checked })
                      }
                    />
                    <span>Enforce TOTP MFA sign-off</span>
                  </label>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setBrokerageModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBrokerage}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingBrokerage
                    ? 'Saving...'
                    : editingBrokerageArch
                      ? 'Save Architecture'
                      : 'Create Architecture'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: CREATE / EDIT RAIL ARCHITECTURE                              */}
      {/* =================================================================== */}
      {railModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingRailArch ? 'Edit Rail Architecture' : 'Add Rail Architecture'}
              </h3>
              <button
                type="button"
                onClick={() => setRailModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveRailArch(e)} className="mt-4 space-y-4">
              {railFormError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {railFormError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Rail Code</label>
                  <select
                    value={railForm.railCode}
                    onChange={(e) =>
                      setRailForm({ ...railForm, railCode: e.target.value as ArchRailCode })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {RAIL_CODES.map((rc) => (
                      <option key={rc} value={rc}>
                        {rc}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Linked Settlement Account
                  </label>
                  <select
                    value={railForm.linkedAccountId}
                    onChange={(e) => setRailForm({ ...railForm, linkedAccountId: e.target.value })}
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

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Rail Name</label>
                  <input
                    type="text"
                    value={railForm.railName}
                    onChange={(e) => setRailForm({ ...railForm, railName: e.target.value })}
                    placeholder="e.g., FedNow 24/7 Instant Rail"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Protocol Standard
                  </label>
                  <input
                    type="text"
                    value={railForm.protocolStandard}
                    onChange={(e) => setRailForm({ ...railForm, protocolStandard: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Settlement Finality
                  </label>
                  <input
                    type="text"
                    value={railForm.settlementFinality}
                    onChange={(e) =>
                      setRailForm({ ...railForm, settlementFinality: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Cutoff Window
                  </label>
                  <input
                    type="text"
                    value={railForm.cutoffWindow}
                    onChange={(e) => setRailForm({ ...railForm, cutoffWindow: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    SLA Latency
                  </label>
                  <input
                    type="text"
                    value={railForm.slaLatency}
                    onChange={(e) => setRailForm({ ...railForm, slaLatency: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Per-Tx Cap ($)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    value={railForm.perTxCap}
                    onChange={(e) => setRailForm({ ...railForm, perTxCap: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Fee (bps, 0–1000)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    step="0.1"
                    value={railForm.feeBps}
                    onChange={(e) => setRailForm({ ...railForm, feeBps: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Failover Rail
                  </label>
                  <select
                    value={railForm.failoverRailCode}
                    onChange={(e) =>
                      setRailForm({
                        ...railForm,
                        failoverRailCode: e.target.value as FailoverRailCode,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {FAILOVER_CODES.map((rc) => (
                      <option key={rc} value={rc}>
                        {rc}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">MFA Policy</label>
                  <select
                    value={railForm.mfaPolicy}
                    onChange={(e) =>
                      setRailForm({ ...railForm, mfaPolicy: e.target.value as RailMfaPolicy })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="always">Always Require MFA</option>
                    <option value="above_threshold">Above Policy Threshold</option>
                    <option value="dual_approval">Dual-Control Approval</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Operational Status
                  </label>
                  <select
                    value={railForm.status}
                    onChange={(e) =>
                      setRailForm({
                        ...railForm,
                        status: e.target.value as RailOperationalStatus,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="operational">Operational</option>
                    <option value="degraded">Degraded</option>
                    <option value="maintenance">Maintenance</option>
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setRailModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingRail}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingRail ? 'Saving...' : editingRailArch ? 'Save Rail' : 'Create Rail'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: CREATE / EDIT ACQUISITION ARCHITECTURE                       */}
      {/* =================================================================== */}
      {acqModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingAcqArch
                  ? 'Edit Acquisition Architecture'
                  : 'Add Acquisition Architecture'}
              </h3>
              <button
                type="button"
                onClick={() => setAcqModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveAcqArch(e)} className="mt-4 space-y-4">
              {acqFormError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {acqFormError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Acquisition Class
                  </label>
                  <select
                    value={acqForm.acquisitionType}
                    onChange={(e) => {
                      const nextType = e.target.value as AcquisitionType;
                      const meta = ACQUISITION_TYPE_META[nextType];
                      setAcqForm({
                        ...acqForm,
                        acquisitionType: nextType,
                        dealStructure: meta.defaultDealStructure,
                        escrowAgent: meta.defaultEscrowAgent,
                        closingHorizon: meta.defaultClosingHorizon,
                        settlementRail: meta.defaultRail,
                      });
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {ACQUISITION_TYPE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {ACQUISITION_TYPE_META[key].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Pipeline Architecture Name
                  </label>
                  <input
                    type="text"
                    value={acqForm.architectureName}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, architectureName: e.target.value })
                    }
                    placeholder="e.g., Northbridge Custody HoldCo Acquisition"
                    maxLength={140}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Target Counterparty / Seller
                  </label>
                  <input
                    type="text"
                    value={acqForm.targetCounterparty}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, targetCounterparty: e.target.value })
                    }
                    placeholder="e.g., Harborfront Industrial REIT"
                    maxLength={140}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Funding Cash Account
                  </label>
                  <select
                    value={acqForm.fundingAccountId}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, fundingAccountId: e.target.value })
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
                    Custody / Advisory Brokerage Firm (Optional)
                  </label>
                  <select
                    value={acqForm.firmId}
                    onChange={(e) => setAcqForm({ ...acqForm, firmId: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="">Direct Treasury / Bank Escrow</option>
                    {firms.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.firmName} (CRD {f.crdNumber})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Deal Structure
                  </label>
                  <input
                    type="text"
                    value={acqForm.dealStructure}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, dealStructure: e.target.value })
                    }
                    maxLength={100}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Escrow / Title Agent
                  </label>
                  <input
                    type="text"
                    value={acqForm.escrowAgent}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, escrowAgent: e.target.value })
                    }
                    maxLength={100}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Closing Horizon
                  </label>
                  <input
                    type="text"
                    value={acqForm.closingHorizon}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, closingHorizon: e.target.value })
                    }
                    maxLength={60}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Settlement Rail
                  </label>
                  <select
                    value={acqForm.settlementRail}
                    onChange={(e) =>
                      setAcqForm({
                        ...acqForm,
                        settlementRail: e.target.value as ArchRailCode,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    {RAIL_CODES.map((rc) => (
                      <option key={rc} value={rc}>
                        {rc}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Target Deal Valuation ($)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    value={acqForm.targetValuationUsd}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, targetValuationUsd: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Committed Capital ($)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    value={acqForm.committedCapitalUsd}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, committedCapitalUsd: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Escrow Holdback (%, 0–50)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="50"
                    step="0.5"
                    value={acqForm.escrowHoldbackPct}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, escrowHoldbackPct: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Closing Stage
                  </label>
                  <select
                    value={acqForm.stage}
                    onChange={(e) =>
                      setAcqForm({
                        ...acqForm,
                        stage: e.target.value as AcquisitionStage,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="pipeline">Pipeline</option>
                    <option value="diligence">Diligence</option>
                    {editingAcqArch && (
                      <>
                        <option value="escrow_funded">Escrow Funded</option>
                        <option value="closed">Closed (Terminal)</option>
                        <option value="cancelled">Cancelled (Terminal)</option>
                      </>
                    )}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap gap-5 pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acqForm.diligenceGateRequired}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, diligenceGateRequired: e.target.checked })
                    }
                  />
                  <span>Require AML &amp; legal diligence sign-off gate</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acqForm.mfaSignoffRequired}
                    onChange={(e) =>
                      setAcqForm({ ...acqForm, mfaSignoffRequired: e.target.checked })
                    }
                  />
                  <span>Require TOTP MFA escrow release</span>
                </label>
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setAcqModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAcq}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingAcq
                    ? 'Saving...'
                    : editingAcqArch
                      ? 'Save Pipeline'
                      : 'Create Pipeline'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: CREATE DEDICATED ACCOUNT FOR PURCHASES                       */}
      {/* =================================================================== */}
      {createPurchasesModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-slate-900" />
                <h3 className="text-base font-semibold text-slate-900 font-display">
                  Create Account for Purchases
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setCreatePurchasesModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleCreatePurchasesAccount(e)} className="mt-4 space-y-4">
              <p className="text-xs text-slate-600">
                Creates an institutional bank account classified as{' '}
                <span className="font-mono font-semibold text-slate-900">PURCHASES</span> and sets
                it as the default funding treasury for Acquisition Workflows.
              </p>

              {createPurchasesError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {createPurchasesError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Purchases Account Name
                </label>
                <input
                  type="text"
                  value={newPurchasesForm.accountName}
                  onChange={(e) =>
                    setNewPurchasesForm({ ...newPurchasesForm, accountName: e.target.value })
                  }
                  maxLength={100}
                  required
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Custodian / Banking Institution
                </label>
                <input
                  type="text"
                  value={newPurchasesForm.institutionName}
                  onChange={(e) =>
                    setNewPurchasesForm({ ...newPurchasesForm, institutionName: e.target.value })
                  }
                  maxLength={100}
                  required
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Last 4 Digits
                  </label>
                  <input
                    type="text"
                    value={newPurchasesForm.accountMask}
                    onChange={(e) =>
                      setNewPurchasesForm({
                        ...newPurchasesForm,
                        accountMask: e.target.value.replace(/\D/g, '').slice(0, 4),
                      })
                    }
                    pattern="[0-9]{4}"
                    required
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Opening Treasury ({workspace?.preferredCurrency || 'USD'})
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={newPurchasesForm.balance}
                    onChange={(e) =>
                      setNewPurchasesForm({ ...newPurchasesForm, balance: e.target.value })
                    }
                    required
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setCreatePurchasesModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingPurchasesAcct}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {creatingPurchasesAcct ? 'Provisioning...' : 'Create & Assign Purchases Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL: INTERACTIVE ACQUISITION EXECUTION WORKFLOW                   */}
      {/* =================================================================== */}
      {workflowTargetAcq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full p-6 max-h-[92vh] overflow-y-auto space-y-5">
            <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-200">
              <div>
                <p className="text-[11px] font-mono text-slate-500">
                  ACQUISITION EXECUTION WORKFLOW · {ACQUISITION_STAGE_LABELS[workflowTargetAcq.stage].toUpperCase()}
                </p>
                <h3 className="text-base font-semibold text-slate-900 font-display mt-0.5">
                  {workflowTargetAcq.architectureName}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Counterparty: {workflowTargetAcq.targetCounterparty} · Escrow:{' '}
                  {workflowTargetAcq.escrowAgent}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setWorkflowTargetId(null)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Workflow Step Stepper */}
            <div className="grid grid-cols-4 border border-slate-200 rounded-lg overflow-hidden divide-x divide-slate-200 text-xs">
              {(
                [
                  { id: 'pipeline', step: '01', label: 'Diligence Gate' },
                  { id: 'diligence', step: '02', label: 'Escrow & MFA Wire' },
                  { id: 'escrow_funded', step: '03', label: 'Close & Onboard' },
                  { id: 'closed', step: '04', label: 'Audit Finality' },
                ] as const
              ).map((s, idx) => {
                const stageOrder: AcquisitionStage[] = [
                  'pipeline',
                  'diligence',
                  'escrow_funded',
                  'closed',
                ];
                const currentIdx = stageOrder.indexOf(
                  workflowTargetAcq.stage === 'cancelled' ? 'pipeline' : workflowTargetAcq.stage,
                );
                const done =
                  workflowTargetAcq.stage === 'closed' ||
                  (workflowTargetAcq.stage !== 'cancelled' && idx < currentIdx);
                const active =
                  workflowTargetAcq.stage !== 'cancelled' &&
                  workflowTargetAcq.stage !== 'closed' &&
                  idx === currentIdx;

                return (
                  <div
                    key={s.id}
                    className={`p-3 ${
                      active ? 'bg-slate-900 text-white' : done ? 'bg-emerald-50' : 'bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`font-mono text-[11px] ${
                          active
                            ? 'text-slate-300'
                            : done
                              ? 'text-emerald-700'
                              : 'text-slate-400'
                        }`}
                      >
                        STEP {s.step}
                      </span>
                      {done && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                    </div>
                    <p
                      className={`font-medium mt-1 ${
                        active ? 'text-white' : done ? 'text-emerald-950' : 'text-slate-600'
                      }`}
                    >
                      {s.label}
                    </p>
                  </div>
                );
              })}
            </div>

            {workflowError && (
              <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {workflowError}
              </div>
            )}

            {/* STEP 1: DILIGENCE GATE */}
            {workflowTargetAcq.stage === 'pipeline' && (
              <div className="space-y-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Step 1: Verify Account for Purchases &amp; Complete Diligence Gate
                  </h4>
                  <p className="text-xs text-slate-600">
                    Confirm the settlement account funding{' '}
                    <span className="font-mono font-semibold text-slate-900">
                      {formatCurrency(workflowTargetAcq.committedCapitalUsd)}
                    </span>{' '}
                    and sign off on AML/OFAC &amp; VDR diligence before opening escrow funding.
                  </p>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Settlement Funding Account
                    </label>
                    <select
                      value={workflowFundingAccountId}
                      onChange={(e) => setWorkflowFundingAccountId(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.accountName} (····{a.accountMask})
                          {a.id === designatedPurchasesAccount?.id ? ' [Purchases Account]' : ''} —{' '}
                          {formatCurrency(a.balance, a.currency)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    disabled={workflowRunning}
                    onClick={() => void handleWorkflowCancelAcq()}
                    className="px-3.5 py-2 text-xs font-medium text-red-700 border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                  >
                    Cancel Acquisition
                  </button>
                  <button
                    type="button"
                    disabled={workflowRunning}
                    onClick={() => void handleWorkflowCompleteDiligence()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>
                      {workflowRunning
                        ? 'Completing Gate...'
                        : 'Approve Diligence Gate & Proceed to Escrow'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {/* STEP 2: ESCROW FUNDING + RFC-6238 TOTP MFA */}
            {workflowTargetAcq.stage === 'diligence' && (
              <form onSubmit={(e) => void handleWorkflowFundEscrow(e)} className="space-y-4">
                {(() => {
                  const chosenId = workflowFundingAccountId || workflowTargetAcq.fundingAccountId;
                  const chosenAcct = accountMap.get(chosenId);
                  const covered =
                    !!chosenAcct && chosenAcct.balance >= workflowTargetAcq.committedCapitalUsd;
                  return (
                    <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                      <h4 className="text-sm font-semibold text-slate-900">
                        Step 2: Fund Escrow via Account for Purchases (Atomic Debit &amp; Settlement)
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                        <div>
                          <label className="block font-medium text-slate-700 mb-1">
                            Source Purchases / Funding Account
                          </label>
                          <select
                            value={chosenId}
                            onChange={(e) => setWorkflowFundingAccountId(e.target.value)}
                            className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-white"
                          >
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.accountName} (····{a.accountMask})
                                {a.id === designatedPurchasesAccount?.id ? ' [Purchases]' : ''} —{' '}
                                {formatCurrency(a.balance, a.currency)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="p-2.5 bg-white border border-slate-200 rounded-lg">
                          <p className="text-[11px] font-mono text-slate-500">ESCROW COMMITMENT</p>
                          <p className="text-sm font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
                            {formatCurrency(workflowTargetAcq.committedCapitalUsd)}
                          </p>
                          <p
                            className={`text-[11px] font-mono mt-0.5 ${
                              covered ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {chosenAcct
                              ? covered
                                ? `Covered (${formatCurrency(chosenAcct.balance)} available)`
                                : `Shortfall ${formatCurrency(workflowTargetAcq.committedCapitalUsd - chosenAcct.balance)}`
                              : 'Select account'}
                          </p>
                        </div>
                      </div>

                      {workflowTargetAcq.mfaSignoffRequired && (
                        <div className="p-3 bg-white border border-slate-200 rounded-lg space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                              <KeyRound className="w-3.5 h-3.5" />
                              <span>RFC-6238 TOTP Escrow Release Token</span>
                            </div>
                            <span className="text-[11px] font-mono text-slate-500">
                              Expires in {workflowSecondsLeft}s
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded px-3 py-2">
                            <span className="text-base font-mono font-semibold tracking-widest text-slate-900">
                              {workflowLiveCode}
                            </span>
                            <button
                              type="button"
                              onClick={() => setWorkflowEnteredCode(workflowLiveCode)}
                              className="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 cursor-pointer"
                            >
                              Fill Token
                            </button>
                          </div>
                          <input
                            type="text"
                            value={workflowEnteredCode}
                            onChange={(e) => setWorkflowEnteredCode(e.target.value)}
                            placeholder="Enter 6-digit TOTP code"
                            maxLength={6}
                            required
                            className="w-full px-3 py-2 text-sm font-mono tracking-widest border border-slate-200 rounded-lg"
                          />
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    disabled={workflowRunning}
                    onClick={() => void handleWorkflowCancelAcq()}
                    className="px-3.5 py-2 text-xs font-medium text-red-700 border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                  >
                    Cancel Acquisition
                  </button>
                  <button
                    type="submit"
                    disabled={workflowRunning}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>
                      {workflowRunning
                        ? 'Settling Escrow...'
                        : 'Debit Purchases Account & Fund Escrow'}
                    </span>
                  </button>
                </div>
              </form>
            )}

            {/* STEP 3: FINAL CLOSING & ASSET ONBOARDING */}
            {workflowTargetAcq.stage === 'escrow_funded' && (
              <form onSubmit={(e) => void handleWorkflowFinalizeClosing(e)} className="space-y-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">
                      Step 3: Final Closing Release &amp; Asset Custody Onboarding
                    </h4>
                    {workflowTargetAcq.escrowPaymentId && (
                      <span className="text-[11px] font-mono text-emerald-700">
                        Escrow Ref: {workflowTargetAcq.escrowPaymentId.slice(0, 10)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600">
                    Escrow capital of{' '}
                    <span className="font-mono font-semibold text-slate-900">
                      {formatCurrency(workflowTargetAcq.committedCapitalUsd)}
                    </span>{' '}
                    is settled. Complete final closing release and optionally record the acquired
                    position directly into the Veridian Asset Registry.
                  </p>

                  <label className="flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={workflowOnboardAsset}
                      onChange={(e) => setWorkflowOnboardAsset(e.target.checked)}
                    />
                    <span>Onboard acquired asset into permanent Asset Registry upon closing</span>
                  </label>

                  {workflowOnboardAsset && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Acquired Asset Name
                        </label>
                        <input
                          type="text"
                          value={workflowAssetName}
                          onChange={(e) => setWorkflowAssetName(e.target.value)}
                          maxLength={140}
                          required
                          className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Ticker / Deed / CUSIP ID
                        </label>
                        <input
                          type="text"
                          value={workflowTicker}
                          onChange={(e) => setWorkflowTicker(e.target.value)}
                          maxLength={48}
                          required
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Units / Shares Quantity
                        </label>
                        <input
                          type="number"
                          min="0.0001"
                          step="any"
                          value={workflowQuantity}
                          onChange={(e) => setWorkflowQuantity(e.target.value)}
                          required
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg bg-white"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Custody Jurisdiction
                        </label>
                        <input
                          type="text"
                          value={workflowJurisdiction}
                          onChange={(e) => setWorkflowJurisdiction(e.target.value)}
                          maxLength={80}
                          required
                          className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    disabled={workflowRunning}
                    onClick={() => void handleWorkflowCancelAcq()}
                    className="px-3.5 py-2 text-xs font-medium text-red-700 border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                  >
                    Cancel Acquisition
                  </button>
                  <button
                    type="submit"
                    disabled={workflowRunning}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>
                      {workflowRunning
                        ? 'Finalizing Closing...'
                        : 'Close Acquisition & Onboard Asset'}
                    </span>
                  </button>
                </div>
              </form>
            )}

            {/* STEP 4: TERMINAL AUDIT SUMMARY (CLOSED / CANCELLED) */}
            {(workflowTargetAcq.stage === 'closed' || workflowTargetAcq.stage === 'cancelled') && (
              <div className="space-y-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900">
                      {workflowTargetAcq.stage === 'closed'
                        ? 'Acquisition Closed & Settled'
                        : 'Acquisition Pipeline Cancelled'}
                    </span>
                    <span className="font-mono text-slate-500">
                      {ACQUISITION_STAGE_LABELS[workflowTargetAcq.stage].toUpperCase()}
                    </span>
                  </div>
                  <p className="text-slate-600">
                    Funding Account:{' '}
                    <span className="font-medium text-slate-900">
                      {accountMap.get(workflowTargetAcq.fundingAccountId)?.accountName ||
                        workflowTargetAcq.fundingAccountId}
                    </span>
                  </p>
                  {workflowTargetAcq.escrowPaymentId && (
                    <p className="text-slate-600 font-mono">
                      Escrow Settlement ID: {workflowTargetAcq.escrowPaymentId}
                    </p>
                  )}
                  {workflowTargetAcq.onboardedAssetId && (
                    <p className="text-slate-600 font-mono">
                      Onboarded Asset ID: {workflowTargetAcq.onboardedAssetId}
                    </p>
                  )}
                </div>

                {onNavigateTab && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setWorkflowTargetId(null);
                        onNavigateTab('ledger');
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                    >
                      <span>View Ledger Debit</span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                    {workflowTargetAcq.escrowPaymentId && (
                      <button
                        type="button"
                        onClick={() => {
                          setWorkflowTargetId(null);
                          onNavigateTab('payments');
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                      >
                        <span>View Settled Escrow Wire</span>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {workflowTargetAcq.onboardedAssetId && (
                      <button
                        type="button"
                        onClick={() => {
                          setWorkflowTargetId(null);
                          onNavigateTab('assets');
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                      >
                        <span>View Onboarded Asset</span>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

                <div className="pt-2 border-t border-slate-200 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setWorkflowTargetId(null)}
                    className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                  >
                    Close Summary
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
