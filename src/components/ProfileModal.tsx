import { useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { LockKeyhole, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  AccountRecoveryConfig,
  BankAccount,
  CurrencyCode,
  UserPrivateProfile,
  UserWorkspace,
} from '../types/finance';
import { AccountRecoveryPanel } from './AccountRecoveryPanel';

interface ProfileModalProps {
  workspace: UserWorkspace | null;
  privateProfile: UserPrivateProfile | null;
  recoveryConfig: AccountRecoveryConfig | null;
  accounts: BankAccount[];
  onClose: () => void;
}

export function ProfileModal({
  workspace,
  privateProfile,
  recoveryConfig,
  accounts,
  onClose,
}: ProfileModalProps) {
  const { user } = useAuth();
  const [modalTab, setModalTab] = useState<'profile' | 'recovery'>('profile');
  const [displayName, setDisplayName] = useState(
    workspace?.displayName || user?.displayName || 'Treasury Holder',
  );
  const [preferredCurrency, setPreferredCurrency] = useState<CurrencyCode>(
    workspace?.preferredCurrency || 'USD',
  );
  const [purchasesAccountId, setPurchasesAccountId] = useState(
    workspace?.purchasesAccountId || '',
  );
  const [phone, setPhone] = useState(privateProfile?.phone || '+1-212-555-0194');
  const [legalAddress, setLegalAddress] = useState(
    privateProfile?.legalAddress || '100 Liberty Plaza, Suite 1400, New York, NY 10006',
  );
  const [taxIdLast4, setTaxIdLast4] = useState(privateProfile?.taxIdLast4 || '4829');
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setErrorMsg(null);
    setSavedNotice(false);

    if (!/^[0-9]{4}$/.test(taxIdLast4)) {
      setErrorMsg('Tax ID / SSN last 4 must be exactly 4 digits.');
      return;
    }

    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        displayName: displayName.trim().slice(0, 120),
        mfaEnrolled: workspace?.mfaEnrolled ?? false,
        preferredCurrency,
        purchasesAccountId,
        updatedAt: serverTimestamp(),
      });

      await updateDoc(doc(db, 'users', user.uid, 'private', 'profile'), {
        email: privateProfile?.email || user.email || 'user@veridianledger.com',
        phone: phone.trim().slice(0, 32),
        legalAddress: legalAddress.trim().slice(0, 240),
        taxIdLast4,
        updatedAt: serverTimestamp(),
      });

      setSavedNotice(true);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}/private/profile`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <LockKeyhole className="w-4 h-4 text-slate-900" />
            <h3 className="text-base font-semibold text-slate-900 font-display">
              Account, PII Vault &amp; Recovery Controls
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 mt-4 border-b border-slate-200 pb-3">
          <button
            type="button"
            onClick={() => setModalTab('profile')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer whitespace-nowrap ${
              modalTab === 'profile'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            Profile &amp; Isolated PII
          </button>
          <button
            type="button"
            onClick={() => setModalTab('recovery')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer whitespace-nowrap ${
              modalTab === 'recovery'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            Account Recovery &amp; Quorum
          </button>
        </div>

        {modalTab === 'profile' ? (
          <form onSubmit={(e) => void handleSave(e)} className="mt-5 space-y-4">
            {errorMsg && (
              <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {errorMsg}
              </div>
            )}
            {savedNotice && (
              <div className="p-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>Workspace and private PII profile saved to Firestore.</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Workspace Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Base Currency
                </label>
                <select
                  value={preferredCurrency}
                  onChange={(e) => setPreferredCurrency(e.target.value as CurrencyCode)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  SSN / TIN Last 4
                </label>
                <input
                  type="text"
                  maxLength={4}
                  value={taxIdLast4}
                  onChange={(e) => setTaxIdLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Verified Contact Phone
              </label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Legal Registered Address
              </label>
              <input
                type="text"
                value={legalAddress}
                onChange={(e) => setLegalAddress(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Designated Account for Purchases
              </label>
              <select
                value={purchasesAccountId}
                onChange={(e) => setPurchasesAccountId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              >
                <option value="">Not Designated</option>
                {accounts
                  .filter((a) => a.status !== 'closed')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.accountName} (•••• {a.accountMask} · {a.accountType})
                    </option>
                  ))}
              </select>
            </div>

            <div className="pt-2 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                {saving ? 'Saving...' : 'Update Profile'}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-5">
            <AccountRecoveryPanel
              recoveryConfig={recoveryConfig}
              privateProfile={privateProfile}
              compact
            />
          </div>
        )}
      </div>
    </div>
  );
}
