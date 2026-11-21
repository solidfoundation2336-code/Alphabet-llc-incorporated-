import type { Timestamp } from 'firebase/firestore';

export type CurrencyCode = 'USD' | 'EUR' | 'GBP';
export type BankAccountType = 'checking' | 'savings' | 'treasury' | 'settlement' | 'purchases' | 'company' | 'public';
export type BankAccountStatus = 'active' | 'frozen' | 'closed';
export type TransactionDirection = 'debit' | 'credit';
export type RecurrenceCadence = 'none' | 'weekly' | 'monthly' | 'quarterly' | 'annual';
export type TransactionStatus = 'posted' | 'pending' | 'flagged';
export type BatchSourceType = 'csv_import' | 'bank_feed' | 'manual_batch';
export type BatchStatus = 'staged' | 'committed';
export type PaymentRail = 'ACH' | 'WIRE' | 'FEDNOW' | 'INTERNAL';
export type PaymentStatus = 'pending_mfa' | 'settled' | 'cancelled';
export type ReportType = 'monthly_statement' | 'cash_flow' | 'tax_ledger' | 'audit_pack';
export type DtcAccountTier = 'individual_custody' | 'institutional_margin' | 'prime_cash';
export type MfaMethod = 'totp_authenticator' | 'hardware_key' | 'sms_otp';
export type DtcStatus = 'draft' | 'mfa_verified' | 'submitted' | 'approved';
export type ComplianceStatus = 'pending_review' | 'registered' | 'active';
export type TaxFormType = '1099-B' | '1099-DIV' | '1099-INT' | 'W-9' | 'W-8BEN' | 'Schedule-D';
export type TaxFilingStatus = 'draft' | 'ready' | 'filed';

export const TRANSACTION_CATEGORIES = [
  'Cloud & Infrastructure',
  'Market Data & Custody',
  'Payroll & Benefits',
  'Office & Facilities',
  'Regulatory & Legal',
  'Software & SaaS',
  'Settlement & Clearing',
  'Travel & T&E',
  'Revenue & Dividends',
] as const;

export const REGULATORY_FRAMEWORKS = [
  'FINRA Rule 4511 (Books & Records)',
  'SEC Rule 17a-4 (WORM Archival)',
  'SEC Rule 15c3-3 (Customer Protection)',
  'Form ADV / Form CRS Disclosure',
  'AML / CIP Compliance Program',
  'FATCA / CRS Tax Reporting',
  'Reg SHO Locate & Delivery',
  'CAT / Consolidated Audit Trail',
] as const;

export const FIELD_LIMITS = {
  ID_MAX: 128,
  NAME_MAX: 120,
  INSTITUTION_MAX: 100,
  DESC_MAX: 240,
  CATEGORY_MAX: 60,
  MEMO_MAX: 160,
  REGULATIONS_MAX: 10,
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  FOUR_DIGITS_PATTERN: /^[0-9]{4}$/,
  CRD_PATTERN: /^[0-9]{4,16}$/,
  DTC_PARTICIPANT_PATTERN: /^[0-9]{4,12}$/,
} as const;

export interface UserWorkspace {
  id: string;
  ownerId: string;
  displayName: string;
  mfaEnrolled: boolean;
  preferredCurrency: CurrencyCode;
  purchasesAccountId?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface UserPrivateProfile {
  id: string;
  ownerId: string;
  email: string;
  phone: string;
  legalAddress: string;
  taxIdLast4: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface BankAccount {
  id: string;
  ownerId: string;
  accountName: string;
  institutionName: string;
  accountType: BankAccountType;
  accountMask: string;
  currency: CurrencyCode;
  balance: number;
  status: BankAccountStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Transaction {
  id: string;
  ownerId: string;
  accountId: string;
  merchant: string;
  description: string;
  amount: number;
  direction: TransactionDirection;
  category: string;
  isRecurring: boolean;
  recurrenceCadence: RecurrenceCadence;
  batchId: string;
  status: TransactionStatus;
  occurredAt: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Budget {
  id: string;
  ownerId: string;
  category: string;
  monthlyLimit: number;
  warningThresholdPct: number;
  criticalThresholdPct: number;
  alertsEnabled: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface BatchJob {
  id: string;
  ownerId: string;
  batchName: string;
  sourceType: BatchSourceType;
  totalItems: number;
  categorizedCount: number;
  recurringDetectedCount: number;
  totalVolume: number;
  status: BatchStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Payment {
  id: string;
  ownerId: string;
  sourceAccountId: string;
  recipientName: string;
  recipientRoutingMask: string;
  paymentRail: PaymentRail;
  amount: number;
  memo: string;
  mfaVerified: boolean;
  idempotencyKey: string;
  status: PaymentStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface FinancialReport {
  id: string;
  ownerId: string;
  accountId: string;
  reportTitle: string;
  reportPeriod: string;
  reportType: ReportType;
  totalInflow: number;
  totalOutflow: number;
  netCashFlow: number;
  transactionCount: number;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DtcRegistration {
  id: string;
  ownerId: string;
  legalEntityName: string;
  accountTier: DtcAccountTier;
  taxIdLast4: string;
  jurisdiction: string;
  mfaMethod: MfaMethod;
  mfaVerified: boolean;
  disclosureAccepted: boolean;
  dtcReferenceCode: string;
  status: DtcStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface BrokerageFirm {
  id: string;
  ownerId: string;
  firmName: string;
  crdNumber: string;
  secFileNumber: string;
  dtcParticipantNumber: string;
  clearingHouse: string;
  complianceOfficer: string;
  finraDistrict: string;
  complianceStatus: ComplianceStatus;
  regulations: string[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface TaxDocument {
  id: string;
  ownerId: string;
  firmId: string;
  accountId: string;
  formType: TaxFormType;
  taxYear: number;
  filingStatus: TaxFilingStatus;
  grossProceeds: number;
  withheldTax: number;
  referenceCode: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type AssetCategoryGroup = 'public_securities' | 'alternatives' | 'real_estate';

export type AssetClass =
  | 'public_equity'
  | 'etf_fund'
  | 'fixed_income'
  | 'private_equity'
  | 'venture_fund'
  | 'commodity'
  | 'commercial_real_estate'
  | 'residential_real_estate'
  | 'reit';

export type AssetCustodyStatus = 'pending_verification' | 'custodied' | 'archived';

export type DocumentCategory =
  | 'brokerage_statement'
  | 'closing_disclosure'
  | 'subscription_agreement'
  | 'holdings_csv'
  | 'holdings_json'
  | 'other_document';

export type ExtractionEngine = 'gemini_multimodal' | 'csv_parser' | 'json_parser' | 'manual';

export type IngestionStatus = 'staged' | 'committed' | 'rejected';

export const ASSET_CLASS_META: Record<
  AssetClass,
  { label: string; group: AssetCategoryGroup; groupLabel: string; defaultRegClass: string }
> = {
  public_equity: {
    label: 'Public Equity',
    group: 'public_securities',
    groupLabel: 'Public Securities',
    defaultRegClass: 'SEC Reg NMS / DTC Eligible',
  },
  etf_fund: {
    label: 'ETF / Mutual Fund',
    group: 'public_securities',
    groupLabel: 'Public Securities',
    defaultRegClass: 'Investment Company Act 1940',
  },
  fixed_income: {
    label: 'Fixed Income / Bond',
    group: 'public_securities',
    groupLabel: 'Public Securities',
    defaultRegClass: 'TRACE / MSRB Fixed Income',
  },
  private_equity: {
    label: 'Private Equity',
    group: 'alternatives',
    groupLabel: 'Alternatives',
    defaultRegClass: 'SEC Reg D 506(c) Accredited',
  },
  venture_fund: {
    label: 'Venture Capital Fund',
    group: 'alternatives',
    groupLabel: 'Alternatives',
    defaultRegClass: 'Form D / Schedule K-1 Partnership',
  },
  commodity: {
    label: 'Commodity / Bullion',
    group: 'alternatives',
    groupLabel: 'Alternatives',
    defaultRegClass: 'CFTC / Allocated Custody',
  },
  commercial_real_estate: {
    label: 'Commercial Real Estate',
    group: 'real_estate',
    groupLabel: 'Real Estate',
    defaultRegClass: 'Deed / ALTA Title Custody',
  },
  residential_real_estate: {
    label: 'Residential Real Estate',
    group: 'real_estate',
    groupLabel: 'Real Estate',
    defaultRegClass: 'TRID Closing Disclosure / Deed',
  },
  reit: {
    label: 'REIT Holding',
    group: 'real_estate',
    groupLabel: 'Real Estate',
    defaultRegClass: 'SEC Form 1099-DIV / REIT',
  },
};

export interface AssetIngestion {
  id: string;
  ownerId: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  documentCategory: DocumentCategory;
  extractionEngine: ExtractionEngine;
  extractedCount: number;
  totalExtractedValue: number;
  status: IngestionStatus;
  summaryNotes: string;
  rawDocumentText?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type StagedAssetReviewStatus =
  | 'pending_review'
  | 'verified'
  | 'flagged'
  | 'committed'
  | 'rejected';

export interface StagedAssetRecord {
  id: string;
  ownerId: string;
  ingestionId: string;
  fileName: string;
  extractionEngine: ExtractionEngine;
  assetName: string;
  tickerOrIdentifier: string;
  assetCategoryGroup: AssetCategoryGroup;
  assetClass: AssetClass;
  quantity: number;
  unitCostBasis: number;
  totalMarketValue: number;
  currency: CurrencyCode;
  valuationDate: string;
  jurisdiction: string;
  regulatoryClassification: string;
  accountId: string;
  firmId: string;
  confidenceNote: string;
  sourceExcerpt?: string;
  nameVerified: boolean;
  identifierVerified: boolean;
  valuationVerified: boolean;
  reviewStatus: StagedAssetReviewStatus;
  reviewerNotes: string;
  committedAssetId: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface OnboardedAsset {
  id: string;
  ownerId: string;
  ingestionId: string;
  accountId: string;
  firmId: string;
  brokerageAccountId?: string;
  assetName: string;
  tickerOrIdentifier: string;
  assetCategoryGroup: AssetCategoryGroup;
  assetClass: AssetClass;
  quantity: number;
  unitCostBasis: number;
  totalMarketValue: number;
  currency: CurrencyCode;
  valuationDate: string;
  jurisdiction: string;
  regulatoryClassification: string;
  mfaVerified: boolean;
  custodyStatus: AssetCustodyStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type BrokerageAccountType =
  | 'individual_taxable'
  | 'ira_retirement'
  | 'roth_ira'
  | 'institutional_prime'
  | 'trust_custody'
  | 'joint_brokerage';

export type BrokerageConnectionMode = 'manual' | 'api_sync';

export type BrokerageApiProvider =
  | 'manual_ledger'
  | 'direct_api_feed'
  | 'custody_fix_gateway'
  | 'statement_sync';

export type BrokerageSyncStatus = 'manual_only' | 'synced' | 'sync_pending' | 'reauth_required';

export type BrokerageAccountStatus = 'active' | 'syncing' | 'needs_reauth' | 'closed';

export const BROKERAGE_ACCOUNT_TYPE_META: Record<
  BrokerageAccountType,
  { label: string; taxTreatment: string }
> = {
  individual_taxable: { label: 'Individual Taxable', taxTreatment: 'Form 1099-B / 1099-DIV' },
  ira_retirement: { label: 'Traditional IRA', taxTreatment: 'Tax-Deferred · Form 5498' },
  roth_ira: { label: 'Roth IRA', taxTreatment: 'Tax-Exempt Growth · Form 5498' },
  institutional_prime: { label: 'Institutional Prime', taxTreatment: 'Reg T / Portfolio Margin' },
  trust_custody: { label: 'Trust & Fiduciary Custody', taxTreatment: 'Form 1041 / Grantor Trust' },
  joint_brokerage: { label: 'Joint WROS Brokerage', taxTreatment: 'Joint 1099-B Consolidated' },
};

export interface BrokerageAccount {
  id: string;
  ownerId: string;
  firmId: string;
  linkedBankAccountId: string;
  accountName: string;
  brokerInstitution: string;
  accountType: BrokerageAccountType;
  accountMask: string;
  connectionMode: BrokerageConnectionMode;
  apiProvider: BrokerageApiProvider;
  syncStatus: BrokerageSyncStatus;
  lastSyncedAt: string;
  currency: CurrencyCode;
  cashBalance: number;
  marginDebt: number;
  status: BrokerageAccountStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type RecoveryStatus = 'configured' | 'drill_verified' | 'recovery_hold';

export interface AccountRecoveryConfig {
  id: string;
  ownerId: string;
  recoveryEmail: string;
  recoveryPhone: string;
  trustedContactName: string;
  trustedContactEmail: string;
  hardwareKeyLabel: string;
  backupCodesRemaining: number;
  recoveryCodeBatchId: string;
  timeLockHours: 24 | 48 | 72;
  dualControlRequired: boolean;
  recoveryStatus: RecoveryStatus;
  lastDrillAt: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type ArchRailCode = 'ACH' | 'WIRE' | 'FEDNOW' | 'SWIFT' | 'DTC_CNS' | 'INTERNAL';
export type FailoverRailCode = ArchRailCode | 'NONE';

export type BankFlowPattern =
  | 'ach_origination'
  | 'fedwire_rtgs'
  | 'fednow_instant'
  | 'internal_book_transfer'
  | 'treasury_sweep'
  | 'card_clearing';

export type AmlScreeningLevel = 'standard' | 'enhanced' | 'institutional';
export type BankArchStatus = 'active' | 'paused' | 'draft';

export const BANK_FLOW_META: Record<
  BankFlowPattern,
  {
    label: string;
    defaultRail: ArchRailCode;
    defaultWindow: string;
    stages: string[];
  }
> = {
  ach_origination: {
    label: 'NACHA ACH Origination',
    defaultRail: 'ACH',
    defaultWindow: 'Same-Day / T+1 Batch',
    stages: ['Entry Capture', 'OFAC & Velocity Check', 'NACHA File Batching', 'FedACH Netting', 'Ledger Reconciliation'],
  },
  fedwire_rtgs: {
    label: 'Fedwire RTGS Wire',
    defaultRail: 'WIRE',
    defaultWindow: 'Real-Time Gross (Cut-off 18:00 ET)',
    stages: ['Wire Initiation & TOTP MFA', 'Dual-Control & Sanctions', 'ISO 20022 pacs.008 Dispatch', 'Fedwire Irrevocable Finality', 'GL Debit Posting'],
  },
  fednow_instant: {
    label: 'FedNow / RTP Instant Push',
    defaultRail: 'FEDNOW',
    defaultWindow: '24/7/365 Instant (<10s)',
    stages: ['Instant Credit Request', 'Fraud & Balance Lock', 'ISO 20022 Instant Rail', 'Receiver Confirmation', 'Atomic Balance Update'],
  },
  internal_book_transfer: {
    label: 'Internal Book Transfer',
    defaultRail: 'INTERNAL',
    defaultWindow: 'Atomic Intra-Ledger (<1s)',
    stages: ['Source/Dest Account Check', 'Policy & Threshold Gate', 'Double-Entry Ledger Swap', 'Instant Audit Receipt'],
  },
  treasury_sweep: {
    label: 'Automated Treasury Sweep',
    defaultRail: 'WIRE',
    defaultWindow: 'End-of-Day 17:00 ET Sweep',
    stages: ['Target Peg Evaluation', 'Surplus Cash Calculation', 'Reserve Sweep Dispatch', 'Custody Ledger Sync'],
  },
  card_clearing: {
    label: 'Corporate Card & POS Clearing',
    defaultRail: 'ACH',
    defaultWindow: 'Auth Real-Time · Settle T+1',
    stages: ['Authorization Hold', 'MCC & Budget Alert Check', 'Network Clearing Batch', 'Posted Ledger Settlement'],
  },
};

export interface BankTxArchitecture {
  id: string;
  ownerId: string;
  accountId: string;
  ruleName: string;
  flowPattern: BankFlowPattern;
  primaryRail: ArchRailCode;
  settlementWindow: string;
  singleTxLimit: number;
  dailyLimit: number;
  mfaThreshold: number;
  dualApprovalRequired: boolean;
  autoReconcile: boolean;
  amlScreeningLevel: AmlScreeningLevel;
  status: BankArchStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type BrokerageTxType =
  | 'equity_order_execution'
  | 'fixed_income_dvp'
  | 'options_derivatives'
  | 'margin_financing'
  | 'acats_transfer'
  | 'securities_lending'
  | 'dividend_corp_action'
  | 'private_alt_subscription';

export type BrokerageArchStatus = 'active' | 'testing' | 'suspended';

export const BROKERAGE_TX_META: Record<
  BrokerageTxType,
  {
    label: string;
    defaultVenue: string;
    defaultCycle: string;
    defaultCustody: string;
    defaultReg: string;
    defaultRail: ArchRailCode;
    stages: string[];
  }
> = {
  equity_order_execution: {
    label: 'Equities & ETF Execution',
    defaultVenue: 'NSCC CNS / Lit Exchange & ATS',
    defaultCycle: 'T+1 Settlement',
    defaultCustody: 'DTC Book-Entry Segregated',
    defaultReg: 'SEC Reg NMS · Rule 15c3-3',
    defaultRail: 'DTC_CNS',
    stages: ['OMS Order Capture', 'Pre-Trade Risk & Buying Power', 'Smart Order Routing', 'NSCC Continuous Net Settlement', 'DTC Share & Cash Finality'],
  },
  fixed_income_dvp: {
    label: 'Fixed Income & Treasury DVP/RVP',
    defaultVenue: 'FICC GSD / Fedwire Securities',
    defaultCycle: 'T+0 / T+1 DVP',
    defaultCustody: 'Institutional DVP/RVP',
    defaultReg: 'TRACE Reporting · MSRB',
    defaultRail: 'WIRE',
    stages: ['Dealer RFQ & Yield Lock', 'FINRA TRACE Print', 'FICC Trade Match', 'Fedwire Securities DVP Swap', 'Accrued Interest Reconciliation'],
  },
  options_derivatives: {
    label: 'Listed Options & Derivatives',
    defaultVenue: 'OCC Clearing Corp',
    defaultCycle: 'T+1 Premium & Exercise',
    defaultCustody: 'OCC Segregated Margin',
    defaultReg: 'FINRA Rule 2360 · OCC Margin',
    defaultRail: 'DTC_CNS',
    stages: ['Multi-Leg Strategy Check', 'OCC TIMS Margin Check', 'Exchange Fill Allocation', 'OCC Novation & Netting', 'Assignment / Cash Settle'],
  },
  margin_financing: {
    label: 'Margin Financing & Collateral',
    defaultVenue: 'Prime Brokerage Margin Engine',
    defaultCycle: 'Intraday Mark-to-Market',
    defaultCustody: 'Hypothecated Margin Account',
    defaultReg: 'Fed Reg T · FINRA Rule 4210',
    defaultRail: 'INTERNAL',
    stages: ['Collateral Valuation', 'Reg T 50% / 4210 Haircut', 'Excess Liquidity Check', 'Intraday Margin Sweep', 'Interest Accrual Posting'],
  },
  acats_transfer: {
    label: 'ACATS / DTC Custody Transfer',
    defaultVenue: 'NSCC ACATS & DTC Deliver',
    defaultCycle: '1–3 Business Days',
    defaultCustody: 'Direct DTC Participant',
    defaultReg: 'FINRA Rule 11870 · TOTP MFA',
    defaultRail: 'DTC_CNS',
    stages: ['TOTP MFA Owner Sign-off', 'NSCC ACATS TIF Validation', 'Contra-Broker Asset Freeze', 'Cost Basis & Lot Sync', 'DTC Book-Entry Receipt'],
  },
  securities_lending: {
    label: 'Securities Lending & Reg SHO Locate',
    defaultVenue: 'DTC Stock Loan / Bilateral Repo',
    defaultCycle: 'Same-Day Locate · T+0 Cash',
    defaultCustody: '102% Cash Collateral Pledge',
    defaultReg: 'SEC Reg SHO Rule 203(b)',
    defaultRail: 'WIRE',
    stages: ['Inventory Availability Scan', 'Reg SHO Locate ID Issuance', 'Collateral Wire Pledge', 'Daily Rebate Mark-to-Market', 'Recall / Return Settlement'],
  },
  dividend_corp_action: {
    label: 'Dividends & Corporate Actions',
    defaultVenue: 'DTC Reorganization / Paying Agent',
    defaultCycle: 'Payable Date Cash Sweep',
    defaultCustody: 'Beneficial Owner Entitlement',
    defaultReg: 'IRS 1099-DIV / 1042-S Tax',
    defaultRail: 'ACH',
    stages: ['Ex-Date Position Snapshot', 'Voluntary Election / Proxy', 'Tax Withholding Calculation', 'Cash / Share Distribution', 'Tax Ledger 1099 Posting'],
  },
  private_alt_subscription: {
    label: 'Private & Alternative Subscriptions',
    defaultVenue: 'Fund Admin / Transfer Agent',
    defaultCycle: 'Capital Call T+2 Wire',
    defaultCustody: 'Uncertificated LP Book-Entry',
    defaultReg: 'SEC Reg D 506(c) · K-1',
    defaultRail: 'WIRE',
    stages: ['Accredited Investor Gate', 'Subscription Doc & AML', 'TOTP MFA Capital Call Wire', 'GP Cap Table Confirmation', 'Asset Registry Onboarding'],
  },
};

export interface BrokerageTxArchitecture {
  id: string;
  ownerId: string;
  firmId: string;
  settlementAccountId: string;
  architectureName: string;
  txType: BrokerageTxType;
  clearingVenue: string;
  settlementCycle: string;
  custodyModel: string;
  regulatoryControl: string;
  primaryRail: ArchRailCode;
  maxOrderNotional: number;
  mfaRequired: boolean;
  status: BrokerageArchStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type RailMfaPolicy = 'always' | 'above_threshold' | 'dual_approval';
export type RailOperationalStatus = 'operational' | 'degraded' | 'maintenance';

export interface RailArchitecture {
  id: string;
  ownerId: string;
  linkedAccountId: string;
  railCode: ArchRailCode;
  railName: string;
  protocolStandard: string;
  settlementFinality: string;
  cutoffWindow: string;
  slaLatency: string;
  perTxCap: number;
  feeBps: number;
  failoverRailCode: FailoverRailCode;
  mfaPolicy: RailMfaPolicy;
  status: RailOperationalStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type CompanyEntityType = 'c_corp' | 's_corp' | 'llc' | 'lp_fund' | 'holding_co';
export type CompanyAccountStatus = 'active' | 'audit_hold' | 'dissolved';

export const COMPANY_ENTITY_META: Record<CompanyEntityType, { label: string; taxForm: string }> = {
  c_corp: { label: 'C-Corporation', taxForm: 'IRS Form 1120' },
  s_corp: { label: 'S-Corporation', taxForm: 'IRS Form 1120-S' },
  llc: { label: 'Limited Liability Co. (LLC)', taxForm: 'IRS Form 1065 / W-9' },
  lp_fund: { label: 'Limited Partnership Fund (LP)', taxForm: 'Schedule K-1' },
  holding_co: { label: 'Treasury Holding Company', taxForm: 'Consolidated 1120' },
};

export interface CompanyAccount {
  id: string;
  ownerId: string;
  linkedAccountId: string;
  companyName: string;
  entityType: CompanyEntityType;
  einLast4: string;
  jurisdiction: string;
  industrySector: string;
  authorizedSignersCount: number;
  creditFacilityLimit: number;
  operatingBalance: number;
  dualApprovalRequired: boolean;
  status: CompanyAccountStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type PublicIssuerType =
  | 'public_corporation'
  | 'municipal_treasury'
  | 'public_fund'
  | 'open_ledger';
export type PublicAccountVisibility = 'public_directory' | 'unlisted';
export type PublicAccountStatus = 'published' | 'draft' | 'archived';

export const PUBLIC_ISSUER_META: Record<PublicIssuerType, { label: string; badge: string }> = {
  public_corporation: { label: 'Public Corporation', badge: 'SEC EDGAR / 10-K' },
  municipal_treasury: { label: 'Municipal Treasury', badge: 'MSRB / EMMA' },
  public_fund: { label: 'Public Mutual / ETF Pool', badge: '1940 Act N-PORT' },
  open_ledger: { label: 'Open Treasury Ledger', badge: 'Real-Time Attestation' },
};

export interface PublicAccount {
  id: string;
  ownerId: string;
  linkedAccountId: string;
  publicHandle: string;
  displayTitle: string;
  issuerType: PublicIssuerType;
  publicTickerOrLei: string;
  disclosedReserveUsd: number;
  transparencyStandard: string;
  visibility: PublicAccountVisibility;
  allowInboundTransfers: boolean;
  status: PublicAccountStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type AcquisitionType =
  | 'strategic_ma_buyout'
  | 'real_estate_deed_escrow'
  | 'private_credit_secondary'
  | 'public_tender_pipe'
  | 'treasury_portfolio_rollup';

export type AcquisitionStage = 'pipeline' | 'diligence' | 'escrow_funded' | 'closed' | 'cancelled';

export const ACQUISITION_TYPE_META: Record<
  AcquisitionType,
  {
    label: string;
    defaultDealStructure: string;
    defaultEscrowAgent: string;
    defaultClosingHorizon: string;
    defaultRail: ArchRailCode;
    stages: string[];
  }
> = {
  strategic_ma_buyout: {
    label: 'Strategic M&A & HoldCo Buyout',
    defaultDealStructure: 'SPV Cash Merger · SPA + Holdback Escrow',
    defaultEscrowAgent: 'BNY Mellon Institutional Escrow',
    defaultClosingHorizon: 'T+15 Business Days',
    defaultRail: 'WIRE',
    stages: [
      'LOI & Cap Table Lock',
      'VDR & Antitrust / AML Gate',
      'SPA Holdback Escrow Funding',
      'Dual-Control MFA Closing Sign-off',
      'Fedwire Closing & Entity Onboarding',
    ],
  },
  real_estate_deed_escrow: {
    label: 'Commercial Real Estate Deed & ALTA Escrow',
    defaultDealStructure: 'Fee Simple Deed + ALTA Title Custody',
    defaultEscrowAgent: 'First American Institutional Title',
    defaultClosingHorizon: 'T+10 Business Days',
    defaultRail: 'WIRE',
    stages: [
      'PSA Execution & Earnest Wire',
      'ALTA Title & Lien Clearance',
      'Closing Disclosure Reconciliation',
      'TOTP MFA Settlement Release',
      'County Deed Recording & Asset Ledger',
    ],
  },
  private_credit_secondary: {
    label: 'Private Credit & LP Secondary Acquisition',
    defaultDealStructure: 'LP Interest Assignment & Transfer Deed',
    defaultEscrowAgent: 'Wilmington Trust Custody',
    defaultClosingHorizon: 'Quarter-End NAV Window',
    defaultRail: 'WIRE',
    stages: [
      'NAV Bid & Confidentiality Gate',
      'GP Transfer Consent & KYC',
      'Capital Call Escrow Reserve',
      'Transfer Agent Assignment Execution',
      'LP Cap Table Update & Custody',
    ],
  },
  public_tender_pipe: {
    label: 'Public Tender / PIPE Block Acquisition',
    defaultDealStructure: 'DTC DVP Block Purchase / Reg D PIPE',
    defaultEscrowAgent: 'DTCC / Meridian Clearing Custody',
    defaultClosingHorizon: 'T+1 / T+2 DVP Cycle',
    defaultRail: 'DTC_CNS',
    stages: [
      'SEC 13D/G & Reg SHO Pre-Clearance',
      'Clearing Firm Buying Power Lock',
      'DTC DVP Settlement Allocation',
      'Compliance Officer & MFA Release',
      'Book-Entry Share Receipt',
    ],
  },
  treasury_portfolio_rollup: {
    label: 'Treasury & Fixed Income Portfolio Roll-Up',
    defaultDealStructure: 'FICC DVP Sovereign & Ladder Sweep',
    defaultEscrowAgent: 'Fedwire Securities / BNY Custody',
    defaultClosingHorizon: 'Same-Day T+0 / T+1',
    defaultRail: 'WIRE',
    stages: [
      'Duration & Yield Curve Target',
      'Dealer RFQ & TRACE Print Check',
      'Treasury Liquidity Sweep Check',
      'Fedwire DVP Cash-for-CUSIP Swap',
      'Custody & Coupon Schedule Sync',
    ],
  },
};

export const ACQUISITION_ASSET_CLASS_MAP: Record<
  AcquisitionType,
  { group: AssetCategoryGroup; assetClass: AssetClass; regulatoryClassification: string }
> = {
  strategic_ma_buyout: {
    group: 'alternatives',
    assetClass: 'private_equity',
    regulatoryClassification: 'SEC Reg D 506(c) / SPV Equity Deed',
  },
  real_estate_deed_escrow: {
    group: 'real_estate',
    assetClass: 'commercial_real_estate',
    regulatoryClassification: 'Deed / ALTA Title Custody',
  },
  private_credit_secondary: {
    group: 'alternatives',
    assetClass: 'private_equity',
    regulatoryClassification: 'LP Transfer Assignment / Schedule K-1',
  },
  public_tender_pipe: {
    group: 'public_securities',
    assetClass: 'public_equity',
    regulatoryClassification: 'SEC Reg NMS / DTC Book-Entry',
  },
  treasury_portfolio_rollup: {
    group: 'public_securities',
    assetClass: 'fixed_income',
    regulatoryClassification: 'FICC / Fedwire Sovereign Custody',
  },
};

export interface AcquisitionArchitecture {
  id: string;
  ownerId: string;
  fundingAccountId: string;
  firmId: string;
  architectureName: string;
  acquisitionType: AcquisitionType;
  targetCounterparty: string;
  dealStructure: string;
  escrowAgent: string;
  closingHorizon: string;
  settlementRail: ArchRailCode;
  targetValuationUsd: number;
  committedCapitalUsd: number;
  escrowHoldbackPct: number;
  diligenceGateRequired: boolean;
  mfaSignoffRequired: boolean;
  stage: AcquisitionStage;
  diligenceCompleted?: boolean;
  escrowPaymentId?: string;
  onboardedAssetId?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

