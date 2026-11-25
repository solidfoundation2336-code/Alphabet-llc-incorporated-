import { useState } from 'react';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Layers,
  ShieldCheck,
  KeyRound,
  Building2,
  FolderUp,
  Network,
  BriefcaseBusiness,
  TrendingUp,
  MessageSquare,
  LogOut,
  X,
  User as UserIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export type WorkspaceTab =
  | 'overview'
  | 'portfolio'
  | 'ledger'
  | 'accounts'
  | 'batch'
  | 'payments'
  | 'dtc'
  | 'brokerage'
  | 'assets'
  | 'architecture'
  | 'chat';

interface SidebarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  alertCount: number;
  brokerageAccountCount?: number;
  stagingReviewCount?: number;
  activeAcquisitionCount?: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpenProfile: () => void;
}

const NAV_ITEMS: { id: WorkspaceTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview & Insights', icon: LayoutDashboard },
  { id: 'portfolio', label: 'Investment Portfolio', icon: TrendingUp },
  { id: 'ledger', label: 'Real-Time Ledger', icon: ArrowLeftRight },
  { id: 'accounts', label: 'Public & Company', icon: BriefcaseBusiness },
  { id: 'batch', label: 'Batch Categorizer', icon: Layers },
  { id: 'payments', label: 'Payments & Reports', icon: ShieldCheck },
  { id: 'assets', label: 'Asset Onboarding', icon: FolderUp },
  { id: 'dtc', label: 'DTC MFA Custody', icon: KeyRound },
  { id: 'brokerage', label: 'Brokerage & Tax', icon: Building2 },
  { id: 'architecture', label: 'Architecture & Recovery', icon: Network },
  { id: 'chat', label: 'Google Chat', icon: MessageSquare },
];

const AVATAR_URL = '/src/assets/images/avatar_account_holder_1795069068157.jpg';

export function Sidebar({
  activeTab,
  onSelectTab,
  alertCount,
  brokerageAccountCount = 0,
  stagingReviewCount = 0,
  activeAcquisitionCount = 0,
  mobileOpen,
  onCloseMobile,
  onOpenProfile,
}: SidebarProps) {
  const { user, logout } = useAuth();
  const [imgFailed, setImgFailed] = useState(false);

  const navContent = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200 w-[260px]">
      <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between">
        <span className="text-base font-semibold tracking-tight text-slate-900 whitespace-nowrap font-display">
          Veridian Ledger
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
          aria-label="Close navigation"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 text-sm rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'bg-slate-900 text-white font-medium'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-normal'
              }`}
            >
              <span className="flex items-center gap-2.5 truncate">
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </span>
              {item.id === 'overview' && alertCount > 0 && (
                <span
                  className={`text-xs font-mono tabular-nums shrink-0 ${
                    isActive ? 'text-amber-300' : 'text-amber-700'
                  }`}
                >
                  {alertCount}
                </span>
              )}
              {item.id === 'portfolio' && brokerageAccountCount > 0 && (
                <span
                  className={`text-xs font-mono tabular-nums shrink-0 ${
                    isActive ? 'text-emerald-300' : 'text-slate-500'
                  }`}
                >
                  {brokerageAccountCount}
                </span>
              )}
              {item.id === 'assets' && stagingReviewCount > 0 && (
                <span
                  className={`text-xs font-mono tabular-nums shrink-0 ${
                    isActive ? 'text-amber-300' : 'text-amber-700'
                  }`}
                >
                  {stagingReviewCount}
                </span>
              )}
              {item.id === 'architecture' && activeAcquisitionCount > 0 && (
                <span
                  className={`text-xs font-mono tabular-nums shrink-0 ${
                    isActive ? 'text-emerald-300' : 'text-slate-500'
                  }`}
                >
                  {activeAcquisitionCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-200 space-y-2">
        <button
          type="button"
          onClick={onOpenProfile}
          className="w-full flex items-center gap-3 text-left p-1.5 -mx-1.5 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
        >
          {!imgFailed ? (
            <img
              src={user?.photoURL || AVATAR_URL}
              alt={user?.displayName || 'Account Holder'}
              referrerPolicy="no-referrer"
              onError={() => setImgFailed(true)}
              className="w-9 h-9 rounded-lg object-cover border border-slate-200 shrink-0"
            />
          ) : (
            <div className="w-9 h-9 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
              <UserIcon className="w-4 h-4 text-slate-600" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-900 truncate">
              {user?.displayName || 'Treasury Holder'}
            </p>
            <p className="text-xs text-slate-500 truncate">{user?.email || ''}</p>
          </div>
        </button>
        <button
          type="button"
          onClick={() => void logout()}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block shrink-0">{navContent}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-10">{navContent}</div>
        </div>
      )}
    </>
  );
}
