import { Menu, Plus, ShieldCheck } from 'lucide-react';
import type { WorkspaceTab } from './Sidebar';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onOpenMobileNav: () => void;
  onQuickLogTransaction: () => void;
  onQuickSettlePayment: () => void;
}

const TAB_TITLES: Record<WorkspaceTab, string> = {
  overview: 'Overview & Consolidated Financial Health',
  portfolio: 'Investment Portfolio & Linked Brokerages',
  ledger: 'Real-Time Bank Ledger',
  accounts: 'Public & Company Accounts',
  batch: 'Batch Transaction Categorizer',
  payments: 'Secure Payments & Financial Reports',
  assets: 'Asset Onboarding & Document Ingestion',
  dtc: 'DTC Account Registration & MFA',
  brokerage: 'Brokerage Compliance & Tax Filings',
  architecture: 'Recovery, Transaction, Acquisition & Rail Architecture',
  chat: 'Google Chat Collaboration',
};

export function TopBar({
  activeTab,
  onOpenMobileNav,
  onQuickLogTransaction,
  onQuickSettlePayment,
}: TopBarProps) {
  return (
    <header className="h-16 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-8 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          className="lg:hidden p-2 text-slate-600 hover:text-slate-900 rounded-lg border border-slate-200"
          aria-label="Open navigation menu"
        >
          <Menu className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 text-sm min-w-0 truncate">
          <span className="text-slate-500 whitespace-nowrap shrink-0">Workspace</span>
          <span className="text-slate-400 shrink-0" aria-hidden="true">
            /
          </span>
          <h1 className="font-semibold text-slate-900 truncate font-display">
            {TAB_TITLES[activeTab]}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onQuickLogTransaction}
          className="hidden sm:inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Log Transaction</span>
        </button>
        <button
          type="button"
          onClick={onQuickSettlePayment}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Settle Payment</span>
        </button>
      </div>
    </header>
  );
}
