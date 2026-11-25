import { useMemo, useState } from 'react';
import { ArchitectureRecoveryView } from './components/ArchitectureRecoveryView';
import { AssetOnboardingView } from './components/AssetOnboardingView';
import { BatchProcessorView } from './components/BatchProcessorView';
import { BrokerageComplianceView } from './components/BrokerageComplianceView';
import { DtcRegistrationView } from './components/DtcRegistrationView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GoogleChatView } from './components/GoogleChatView';
import { InvestmentPortfolioView } from './components/InvestmentPortfolioView';
import { LedgerView } from './components/LedgerView';
import { OverviewInsightsView } from './components/OverviewInsightsView';
import { PaymentsReportsView } from './components/PaymentsReportsView';
import { ProfileModal } from './components/ProfileModal';
import { PublicCompanyAccountsView } from './components/PublicCompanyAccountsView';
import { Sidebar, type WorkspaceTab } from './components/Sidebar';
import { SignInScreen } from './components/SignInScreen';
import { TopBar } from './components/TopBar';
import { AuthProvider, useAuth } from './context/AuthContext';
import { useFinanceData } from './hooks/useFinanceData';

function AuthenticatedWorkspace() {
  const { user, authReady, seeding } = useAuth();
  const data = useFinanceData();
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [txModalTrigger, setTxModalTrigger] = useState(0);
  const [paymentModalTrigger, setPaymentModalTrigger] = useState(0);
  const [archSubTabTrigger, setArchSubTabTrigger] = useState<{
    tab: 'recovery' | 'bank' | 'brokerage' | 'rails' | 'acquisition';
    nonce: number;
  }>({ tab: 'recovery', nonce: 0 });
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  const alertCount = useMemo(() => {
    const latestMonth = data.transactions[0]?.occurredAt?.slice(0, 7) || '2026-11';
    const spendMap = new Map<string, number>();
    data.transactions
      .filter((tx) => tx.direction === 'debit' && tx.occurredAt.startsWith(latestMonth))
      .forEach((tx) => {
        spendMap.set(tx.category, (spendMap.get(tx.category) || 0) + tx.amount);
      });
    return data.budgets.filter((b) => {
      if (!b.alertsEnabled || b.monthlyLimit <= 0) return false;
      const pct = ((spendMap.get(b.category) || 0) / b.monthlyLimit) * 100;
      return pct >= b.warningThresholdPct;
    }).length;
  }, [data.budgets, data.transactions]);

  const stagingReviewCount = useMemo(
    () =>
      data.stagedAssets.filter(
        (s) =>
          s.reviewStatus === 'pending_review' ||
          s.reviewStatus === 'flagged' ||
          s.reviewStatus === 'verified',
      ).length,
    [data.stagedAssets],
  );

  const activeAcquisitionCount = useMemo(
    () =>
      data.acquisitionArchitectures.filter(
        (a) => a.stage !== 'closed' && a.stage !== 'cancelled',
      ).length,
    [data.acquisitionArchitectures],
  );

  const activeBrokerageCount = useMemo(
    () => data.brokerageAccounts.filter((b) => b.status !== 'closed').length,
    [data.brokerageAccounts],
  );

  if (!authReady || seeding) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl px-8 py-6 text-sm text-slate-700">
          Synchronizing Veridian Ledger workspace...
        </div>
      </div>
    );
  }

  if (!user) {
    return <SignInScreen />;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        alertCount={alertCount}
        brokerageAccountCount={activeBrokerageCount}
        stagingReviewCount={stagingReviewCount}
        activeAcquisitionCount={activeAcquisitionCount}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        onOpenProfile={() => setProfileModalOpen(true)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          activeTab={activeTab}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onQuickLogTransaction={() => {
            setActiveTab('ledger');
            setTxModalTrigger((n) => n + 1);
          }}
          onQuickSettlePayment={() => {
            setActiveTab('payments');
            setPaymentModalTrigger((n) => n + 1);
          }}
        />

        <main className="flex-1 p-4 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewInsightsView
              loading={data.loading}
              workspace={data.workspace}
              accounts={data.accounts}
              brokerageAccounts={data.brokerageAccounts}
              transactions={data.transactions}
              budgets={data.budgets}
              assets={data.assets}
              acquisitionArchitectures={data.acquisitionArchitectures}
              onNavigateTab={(tab) => setActiveTab(tab)}
              onOpenAcquisitionWorkflow={() => {
                setArchSubTabTrigger((prev) => ({ tab: 'acquisition', nonce: prev.nonce + 1 }));
                setActiveTab('architecture');
              }}
            />
          )}
          {activeTab === 'portfolio' && (
            <InvestmentPortfolioView
              accounts={data.accounts}
              brokerageAccounts={data.brokerageAccounts}
              firms={data.brokerageFirms}
              assets={data.assets}
              onNavigateTab={(tab) => setActiveTab(tab)}
            />
          )}
          {activeTab === 'ledger' && (
            <LedgerView
              accounts={data.accounts}
              brokerageAccounts={data.brokerageAccounts}
              transactions={data.transactions}
              purchasesAccountId={data.workspace?.purchasesAccountId}
              openTxModalTrigger={txModalTrigger}
            />
          )}
          {activeTab === 'accounts' && (
            <PublicCompanyAccountsView
              accounts={data.accounts}
              companyAccounts={data.companyAccounts}
              publicAccounts={data.publicAccounts}
            />
          )}
          {activeTab === 'batch' && (
            <BatchProcessorView accounts={data.accounts} batchJobs={data.batchJobs} />
          )}
          {activeTab === 'payments' && (
            <PaymentsReportsView
              accounts={data.accounts}
              transactions={data.transactions}
              payments={data.payments}
              reports={data.reports}
              purchasesAccountId={data.workspace?.purchasesAccountId}
              openPaymentModalTrigger={paymentModalTrigger}
            />
          )}
          {activeTab === 'assets' && (
            <AssetOnboardingView
              accounts={data.accounts}
              firms={data.brokerageFirms}
              assets={data.assets}
              ingestions={data.assetIngestions}
              stagedAssets={data.stagedAssets}
            />
          )}
          {activeTab === 'dtc' && (
            <DtcRegistrationView registrations={data.dtcRegistrations} />
          )}
          {activeTab === 'brokerage' && (
            <BrokerageComplianceView
              accounts={data.accounts}
              firms={data.brokerageFirms}
              taxDocuments={data.taxDocuments}
            />
          )}
          {activeTab === 'architecture' && (
            <ArchitectureRecoveryView
              workspace={data.workspace}
              accounts={data.accounts}
              firms={data.brokerageFirms}
              recoveryConfig={data.recoveryConfig}
              privateProfile={data.privateProfile}
              bankTxArchitectures={data.bankTxArchitectures}
              brokerageTxArchitectures={data.brokerageTxArchitectures}
              railArchitectures={data.railArchitectures}
              acquisitionArchitectures={data.acquisitionArchitectures}
              subTabRequest={archSubTabTrigger}
              onNavigateTab={setActiveTab}
            />
          )}
          {activeTab === 'chat' && <GoogleChatView />}
        </main>
      </div>

      {profileModalOpen && (
        <ProfileModal
          workspace={data.workspace}
          privateProfile={data.privateProfile}
          recoveryConfig={data.recoveryConfig}
          accounts={data.accounts}
          onClose={() => setProfileModalOpen(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AuthenticatedWorkspace />
      </AuthProvider>
    </ErrorBoundary>
  );
}
