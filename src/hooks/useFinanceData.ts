import { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  AccountRecoveryConfig,
  AcquisitionArchitecture,
  AssetIngestion,
  BankAccount,
  BankTxArchitecture,
  BatchJob,
  BrokerageAccount,
  BrokerageFirm,
  BrokerageTxArchitecture,
  Budget,
  CompanyAccount,
  DtcRegistration,
  FinancialReport,
  OnboardedAsset,
  Payment,
  PublicAccount,
  RailArchitecture,
  StagedAssetRecord,
  TaxDocument,
  Transaction,
  UserPrivateProfile,
  UserWorkspace,
} from '../types/finance';

export interface FinanceDataState {
  loading: boolean;
  workspace: UserWorkspace | null;
  privateProfile: UserPrivateProfile | null;
  recoveryConfig: AccountRecoveryConfig | null;
  accounts: BankAccount[];
  transactions: Transaction[];
  budgets: Budget[];
  batchJobs: BatchJob[];
  payments: Payment[];
  reports: FinancialReport[];
  dtcRegistrations: DtcRegistration[];
  brokerageFirms: BrokerageFirm[];
  brokerageAccounts: BrokerageAccount[];
  taxDocuments: TaxDocument[];
  assetIngestions: AssetIngestion[];
  stagedAssets: StagedAssetRecord[];
  assets: OnboardedAsset[];
  bankTxArchitectures: BankTxArchitecture[];
  brokerageTxArchitectures: BrokerageTxArchitecture[];
  railArchitectures: RailArchitecture[];
  acquisitionArchitectures: AcquisitionArchitecture[];
  companyAccounts: CompanyAccount[];
  publicAccounts: PublicAccount[];
}

export function useFinanceData(): FinanceDataState {
  const { user, authReady } = useAuth();
  const [loading, setLoading] = useState(true);
  const [workspace, setWorkspace] = useState<UserWorkspace | null>(null);
  const [privateProfile, setPrivateProfile] = useState<UserPrivateProfile | null>(null);
  const [recoveryConfig, setRecoveryConfig] = useState<AccountRecoveryConfig | null>(null);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [reports, setReports] = useState<FinancialReport[]>([]);
  const [dtcRegistrations, setDtcRegistrations] = useState<DtcRegistration[]>([]);
  const [brokerageFirms, setBrokerageFirms] = useState<BrokerageFirm[]>([]);
  const [brokerageAccounts, setBrokerageAccounts] = useState<BrokerageAccount[]>([]);
  const [taxDocuments, setTaxDocuments] = useState<TaxDocument[]>([]);
  const [assetIngestions, setAssetIngestions] = useState<AssetIngestion[]>([]);
  const [stagedAssets, setStagedAssets] = useState<StagedAssetRecord[]>([]);
  const [assets, setAssets] = useState<OnboardedAsset[]>([]);
  const [bankTxArchitectures, setBankTxArchitectures] = useState<BankTxArchitecture[]>([]);
  const [brokerageTxArchitectures, setBrokerageTxArchitectures] = useState<BrokerageTxArchitecture[]>([]);
  const [railArchitectures, setRailArchitectures] = useState<RailArchitecture[]>([]);
  const [acquisitionArchitectures, setAcquisitionArchitectures] = useState<AcquisitionArchitecture[]>([]);
  const [companyAccounts, setCompanyAccounts] = useState<CompanyAccount[]>([]);
  const [publicAccounts, setPublicAccounts] = useState<PublicAccount[]>([]);

  useEffect(() => {
    if (!authReady || !user) {
      setWorkspace(null);
      setPrivateProfile(null);
      setRecoveryConfig(null);
      setAccounts([]);
      setTransactions([]);
      setBudgets([]);
      setBatchJobs([]);
      setPayments([]);
      setReports([]);
      setDtcRegistrations([]);
      setBrokerageFirms([]);
      setBrokerageAccounts([]);
      setTaxDocuments([]);
      setAssetIngestions([]);
      setStagedAssets([]);
      setAssets([]);
      setBankTxArchitectures([]);
      setBrokerageTxArchitectures([]);
      setRailArchitectures([]);
      setAcquisitionArchitectures([]);
      setCompanyAccounts([]);
      setPublicAccounts([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const uid = user.uid;
    let settledCount = 0;
    const markSettled = () => {
      settledCount += 1;
      if (settledCount >= 4) {
        setLoading(false);
      }
    };

    const ownedPublicMap = new Map<string, PublicAccount>();
    const directoryPublicMap = new Map<string, PublicAccount>();
    const syncPublicAccounts = () => {
      const merged = new Map<string, PublicAccount>([
        ...directoryPublicMap.entries(),
        ...ownedPublicMap.entries(),
      ]);
      const list = Array.from(merged.values());
      list.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
      setPublicAccounts(list);
    };

    const unsubscribers = [
      onSnapshot(
        doc(db, 'users', uid),
        (snap) => {
          setWorkspace(snap.exists() ? ({ id: snap.id, ...snap.data() } as UserWorkspace) : null);
        },
        (error) => handleFirestoreError(error, OperationType.GET, `users/${uid}`),
      ),
      onSnapshot(
        doc(db, 'users', uid, 'private', 'profile'),
        (snap) => {
          setPrivateProfile(
            snap.exists() ? ({ id: snap.id, ...snap.data() } as UserPrivateProfile) : null,
          );
        },
        (error) => handleFirestoreError(error, OperationType.GET, `users/${uid}/private/profile`),
      ),
      onSnapshot(
        doc(db, 'users', uid, 'private', 'recovery'),
        (snap) => {
          setRecoveryConfig(
            snap.exists() ? ({ id: snap.id, ...snap.data() } as AccountRecoveryConfig) : null,
          );
        },
        (error) => handleFirestoreError(error, OperationType.GET, `users/${uid}/private/recovery`),
      ),
      onSnapshot(
        query(collection(db, 'bank_accounts'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BankAccount);
          list.sort((a, b) => a.accountName.localeCompare(b.accountName));
          setAccounts(list);
          markSettled();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'bank_accounts'),
      ),
      onSnapshot(
        query(collection(db, 'transactions'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Transaction);
          list.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
          setTransactions(list);
          markSettled();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'transactions'),
      ),
      onSnapshot(
        query(collection(db, 'budgets'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Budget);
          list.sort((a, b) => a.category.localeCompare(b.category));
          setBudgets(list);
          markSettled();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'budgets'),
      ),
      onSnapshot(
        query(collection(db, 'batch_jobs'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BatchJob);
          list.sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
          setBatchJobs(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'batch_jobs'),
      ),
      onSnapshot(
        query(collection(db, 'payments'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Payment);
          list.sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
          setPayments(list);
          markSettled();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'payments'),
      ),
      onSnapshot(
        query(collection(db, 'financial_reports'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FinancialReport);
          list.sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
          setReports(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'financial_reports'),
      ),
      onSnapshot(
        query(collection(db, 'dtc_registrations'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as DtcRegistration);
          list.sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
          setDtcRegistrations(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'dtc_registrations'),
      ),
      onSnapshot(
        query(collection(db, 'brokerage_firms'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BrokerageFirm);
          list.sort((a, b) => a.firmName.localeCompare(b.firmName));
          setBrokerageFirms(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'brokerage_firms'),
      ),
      onSnapshot(
        query(collection(db, 'brokerage_accounts'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BrokerageAccount);
          list.sort((a, b) => a.accountName.localeCompare(b.accountName));
          setBrokerageAccounts(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'brokerage_accounts'),
      ),
      onSnapshot(
        query(collection(db, 'tax_documents'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as TaxDocument);
          list.sort((a, b) => b.taxYear - a.taxYear);
          setTaxDocuments(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'tax_documents'),
      ),
      onSnapshot(
        query(collection(db, 'asset_ingestions'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AssetIngestion);
          list.sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
          setAssetIngestions(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'asset_ingestions'),
      ),
      onSnapshot(
        query(collection(db, 'staged_assets'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as StagedAssetRecord);
          list.sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
          setStagedAssets(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'staged_assets'),
      ),
      onSnapshot(
        query(collection(db, 'assets'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as OnboardedAsset);
          list.sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
          setAssets(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'assets'),
      ),
      onSnapshot(
        query(collection(db, 'bank_tx_architectures'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BankTxArchitecture);
          list.sort((a, b) => a.ruleName.localeCompare(b.ruleName));
          setBankTxArchitectures(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'bank_tx_architectures'),
      ),
      onSnapshot(
        query(collection(db, 'brokerage_tx_architectures'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BrokerageTxArchitecture);
          list.sort((a, b) => a.architectureName.localeCompare(b.architectureName));
          setBrokerageTxArchitectures(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'brokerage_tx_architectures'),
      ),
      onSnapshot(
        query(collection(db, 'rail_architectures'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as RailArchitecture);
          list.sort((a, b) => a.railCode.localeCompare(b.railCode));
          setRailArchitectures(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'rail_architectures'),
      ),
      onSnapshot(
        query(collection(db, 'acquisition_architectures'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AcquisitionArchitecture);
          list.sort((a, b) => a.architectureName.localeCompare(b.architectureName));
          setAcquisitionArchitectures(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'acquisition_architectures'),
      ),
      onSnapshot(
        query(collection(db, 'company_accounts'), where('ownerId', '==', uid)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as CompanyAccount);
          list.sort((a, b) => a.companyName.localeCompare(b.companyName));
          setCompanyAccounts(list);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'company_accounts'),
      ),
      onSnapshot(
        query(collection(db, 'public_accounts'), where('ownerId', '==', uid)),
        (snap) => {
          ownedPublicMap.clear();
          snap.docs.forEach((d) => {
            ownedPublicMap.set(d.id, { id: d.id, ...d.data() } as PublicAccount);
          });
          syncPublicAccounts();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'public_accounts/owned'),
      ),
      onSnapshot(
        query(
          collection(db, 'public_accounts'),
          where('visibility', '==', 'public_directory'),
          where('status', '==', 'published'),
        ),
        (snap) => {
          directoryPublicMap.clear();
          snap.docs.forEach((d) => {
            directoryPublicMap.set(d.id, { id: d.id, ...d.data() } as PublicAccount);
          });
          syncPublicAccounts();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'public_accounts/directory'),
      ),
    ];

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [authReady, user]);

  return {
    loading,
    workspace,
    privateProfile,
    recoveryConfig,
    accounts,
    transactions,
    budgets,
    batchJobs,
    payments,
    reports,
    dtcRegistrations,
    brokerageFirms,
    brokerageAccounts,
    taxDocuments,
    assetIngestions,
    stagedAssets,
    assets,
    bankTxArchitectures,
    brokerageTxArchitectures,
    railArchitectures,
    acquisitionArchitectures,
    companyAccounts,
    publicAccounts,
  };
}
