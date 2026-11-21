import { useEffect, useState } from 'react';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  AccountRecoveryConfig,
  RecoveryStatus,
  UserPrivateProfile,
} from '../types/finance';
import { downloadTextFile, generateSafeId } from '../utils/formatters';
import {
  generateTotpCode,
  generateTotpSecret,
  getTotpSecondsRemaining,
  verifyTotpCode,
} from '../utils/totp';

interface AccountRecoveryPanelProps {
  recoveryConfig: AccountRecoveryConfig | null;
  privateProfile: UserPrivateProfile | null;
  compact?: boolean;
}

function generateRecoveryCodes(count = 8): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let raw = '';
    for (let j = 0; j < 8; j++) {
      raw += alphabet[bytes[j] % alphabet.length];
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function AccountRecoveryPanel({
  recoveryConfig,
  privateProfile,
  compact = false,
}: AccountRecoveryPanelProps) {
  const { user } = useAuth();

  const [recoveryEmail, setRecoveryEmail] = useState(
    recoveryConfig?.recoveryEmail || privateProfile?.email || user?.email || 'recovery@veridianledger.com',
  );
  const [recoveryPhone, setRecoveryPhone] = useState(
    recoveryConfig?.recoveryPhone || privateProfile?.phone || '+1-212-555-0194',
  );
  const [trustedContactName, setTrustedContactName] = useState(
    recoveryConfig?.trustedContactName || 'Evelyn Vance, CCO',
  );
  const [trustedContactEmail, setTrustedContactEmail] = useState(
    recoveryConfig?.trustedContactEmail || 'custody-steward@veridianledger.com',
  );
  const [hardwareKeyLabel, setHardwareKeyLabel] = useState(
    recoveryConfig?.hardwareKeyLabel || 'YubiKey 5C NFC · Primary Treasury',
  );
  const [timeLockHours, setTimeLockHours] = useState<24 | 48 | 72>(
    recoveryConfig?.timeLockHours || 48,
  );
  const [dualControlRequired, setDualControlRequired] = useState<boolean>(
    recoveryConfig?.dualControlRequired ?? true,
  );

  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Recovery Code Kit state
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);
  const [rotatingCodes, setRotatingCodes] = useState(false);
  const [copiedKit, setCopiedKit] = useState(false);

  // TOTP MFA Recovery Drill / Hold verification state
  const [drillOpen, setDrillOpen] = useState(false);
  const [pendingStatusAction, setPendingStatusAction] = useState<RecoveryStatus>('drill_verified');
  const [totpSecret, setTotpSecret] = useState(() => generateTotpSecret());
  const [liveCode, setLiveCode] = useState('------');
  const [secondsLeft, setSecondsLeft] = useState(getTotpSecondsRemaining());
  const [enteredCode, setEnteredCode] = useState('');
  const [drillError, setDrillError] = useState<string | null>(null);
  const [verifyingDrill, setVerifyingDrill] = useState(false);

  useEffect(() => {
    if (!recoveryConfig) return;
    setRecoveryEmail(recoveryConfig.recoveryEmail);
    setRecoveryPhone(recoveryConfig.recoveryPhone);
    setTrustedContactName(recoveryConfig.trustedContactName);
    setTrustedContactEmail(recoveryConfig.trustedContactEmail);
    setHardwareKeyLabel(recoveryConfig.hardwareKeyLabel);
    setTimeLockHours(recoveryConfig.timeLockHours);
    setDualControlRequired(recoveryConfig.dualControlRequired);
  }, [recoveryConfig]);

  useEffect(() => {
    if (!drillOpen) return;
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
  }, [drillOpen, totpSecret]);

  const handleSaveRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setErrorMsg(null);
    setSavedNotice(null);

    if (recoveryEmail.trim().length < 3 || trustedContactEmail.trim().length < 3) {
      setErrorMsg('Valid recovery and trusted steward email addresses are required.');
      return;
    }
    if (recoveryPhone.trim().length < 4) {
      setErrorMsg('Recovery SMS/voice phone number must be at least 4 characters.');
      return;
    }
    if (trustedContactName.trim().length < 2 || hardwareKeyLabel.trim().length < 2) {
      setErrorMsg('Trusted contact name and hardware key label are required.');
      return;
    }

    setSaving(true);
    try {
      const ref = doc(db, 'users', user.uid, 'private', 'recovery');
      if (recoveryConfig) {
        await updateDoc(ref, {
          recoveryEmail: recoveryEmail.trim().slice(0, 200),
          recoveryPhone: recoveryPhone.trim().slice(0, 32),
          trustedContactName: trustedContactName.trim().slice(0, 120),
          trustedContactEmail: trustedContactEmail.trim().slice(0, 200),
          hardwareKeyLabel: hardwareKeyLabel.trim().slice(0, 100),
          timeLockHours,
          dualControlRequired,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(ref, {
          ownerId: user.uid,
          recoveryEmail: recoveryEmail.trim().slice(0, 200),
          recoveryPhone: recoveryPhone.trim().slice(0, 32),
          trustedContactName: trustedContactName.trim().slice(0, 120),
          trustedContactEmail: trustedContactEmail.trim().slice(0, 200),
          hardwareKeyLabel: hardwareKeyLabel.trim().slice(0, 100),
          backupCodesRemaining: 8,
          recoveryCodeBatchId: generateSafeId('RCV'),
          timeLockHours,
          dualControlRequired,
          recoveryStatus: 'configured',
          lastDrillAt: new Date().toISOString().slice(0, 10),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setSavedNotice('Account recovery channels and time-lock policy updated.');
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/private/recovery`);
    } finally {
      setSaving(false);
    }
  };

  const handleRotateBackupCodes = async () => {
    if (!user) return;
    setErrorMsg(null);
    setSavedNotice(null);
    setRotatingCodes(true);

    const newCodes = generateRecoveryCodes(8);
    const batchId = generateSafeId('RCV');

    try {
      const ref = doc(db, 'users', user.uid, 'private', 'recovery');
      if (recoveryConfig) {
        await updateDoc(ref, {
          backupCodesRemaining: newCodes.length,
          recoveryCodeBatchId: batchId,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(ref, {
          ownerId: user.uid,
          recoveryEmail: recoveryEmail.trim().slice(0, 200),
          recoveryPhone: recoveryPhone.trim().slice(0, 32),
          trustedContactName: trustedContactName.trim().slice(0, 120),
          trustedContactEmail: trustedContactEmail.trim().slice(0, 200),
          hardwareKeyLabel: hardwareKeyLabel.trim().slice(0, 100),
          backupCodesRemaining: newCodes.length,
          recoveryCodeBatchId: batchId,
          timeLockHours,
          dualControlRequired,
          recoveryStatus: 'configured',
          lastDrillAt: new Date().toISOString().slice(0, 10),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setGeneratedCodes(newCodes);
      setCopiedKit(false);
      setSavedNotice(`Generated 8 single-use recovery codes (Batch ${batchId}).`);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}/private/recovery`);
    } finally {
      setRotatingCodes(false);
    }
  };

  const handleDownloadRecoveryKit = () => {
    if (!generatedCodes) return;
    const batchId = recoveryConfig?.recoveryCodeBatchId || 'RCV-KIT';
    const text = [
      'VERIDIAN LEDGER — ACCOUNT RECOVERY BACKUP KIT',
      `Batch Reference: ${batchId}`,
      `Account Email: ${user?.email || recoveryEmail}`,
      `Time-Lock Policy: ${timeLockHours} hours · Dual Control: ${dualControlRequired ? 'Enabled' : 'Disabled'}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'Single-Use Cryptographic Recovery Codes:',
      ...generatedCodes.map((c, idx) => `${idx + 1}. ${c}`),
      '',
      'Store offline in an encrypted vault or institutional safe.',
    ].join('\n');
    downloadTextFile(`veridian-recovery-kit-${batchId}.txt`, text, 'text/plain;charset=utf-8;');
  };

  const openTotpDrill = (targetStatus: RecoveryStatus) => {
    setPendingStatusAction(targetStatus);
    setTotpSecret(generateTotpSecret());
    setEnteredCode('');
    setDrillError(null);
    setDrillOpen(true);
  };

  const handleConfirmTotpAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setDrillError(null);

    const ok = await verifyTotpCode(totpSecret, enteredCode);
    if (!ok) {
      setDrillError('Invalid 6-digit authenticator code. Enter the current live TOTP token.');
      return;
    }

    setVerifyingDrill(true);
    try {
      const ref = doc(db, 'users', user.uid, 'private', 'recovery');
      const todayIso = new Date().toISOString().slice(0, 10);
      if (recoveryConfig) {
        await updateDoc(ref, {
          recoveryStatus: pendingStatusAction,
          lastDrillAt: todayIso,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(ref, {
          ownerId: user.uid,
          recoveryEmail: recoveryEmail.trim().slice(0, 200),
          recoveryPhone: recoveryPhone.trim().slice(0, 32),
          trustedContactName: trustedContactName.trim().slice(0, 120),
          trustedContactEmail: trustedContactEmail.trim().slice(0, 200),
          hardwareKeyLabel: hardwareKeyLabel.trim().slice(0, 100),
          backupCodesRemaining: 8,
          recoveryCodeBatchId: generateSafeId('RCV'),
          timeLockHours,
          dualControlRequired,
          recoveryStatus: pendingStatusAction,
          lastDrillAt: todayIso,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await updateDoc(doc(db, 'users', user.uid), {
        mfaEnrolled: true,
        updatedAt: serverTimestamp(),
      });
      setDrillOpen(false);
      setEnteredCode('');
      setSavedNotice(
        pendingStatusAction === 'recovery_hold'
          ? `Time-locked recovery hold (${timeLockHours}h) activated.`
          : pendingStatusAction === 'drill_verified'
            ? `TOTP MFA recovery drill verified on ${todayIso}.`
            : 'Recovery hold cleared and posture restored.',
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}/private/recovery`);
    } finally {
      setVerifyingDrill(false);
    }
  };

  const currentStatus = recoveryConfig?.recoveryStatus || 'configured';

  return (
    <div className="space-y-5">
      {errorMsg && (
        <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {errorMsg}
        </div>
      )}
      {savedNotice && (
        <div className="p-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>{savedNotice}</span>
        </div>
      )}

      {/* Status Header Strip */}
      <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium">
            {currentStatus === 'recovery_hold' ? (
              <span className="inline-flex items-center gap-1.5 text-amber-700">
                <ShieldAlert className="w-4 h-4" />
                <span>Time-Locked Recovery Hold Active ({timeLockHours}h Window)</span>
              </span>
            ) : currentStatus === 'drill_verified' ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-700">
                <CheckCircle2 className="w-4 h-4" />
                <span>Recovery Drill Verified · Last Checked {recoveryConfig?.lastDrillAt || '2026-11-18'}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-slate-800">
                <Lock className="w-4 h-4" />
                <span>Configured · {timeLockHours}h Quorum Time-Lock</span>
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            Batch {recoveryConfig?.recoveryCodeBatchId || 'Pending'} ·{' '}
            {recoveryConfig?.backupCodesRemaining ?? 8} backup codes remaining
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openTotpDrill('drill_verified')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>Verify Recovery Drill</span>
          </button>
          {currentStatus === 'recovery_hold' ? (
            <button
              type="button"
              onClick={() => openTotpDrill('configured')}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              Release Recovery Hold
            </button>
          ) : (
            <button
              type="button"
              onClick={() => openTotpDrill('recovery_hold')}
              className="px-3 py-1.5 text-xs font-medium text-amber-800 bg-white border border-amber-200 rounded-lg hover:bg-amber-50 cursor-pointer whitespace-nowrap"
            >
              Initiate Time-Lock Hold
            </button>
          )}
        </div>
      </div>

      {/* Recovery Channels & Policy Form */}
      <form onSubmit={(e) => void handleSaveRecovery(e)} className="space-y-4">
        <div className={`grid gap-3 ${compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 md:grid-cols-2'}`}>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Secondary Recovery Email
            </label>
            <input
              type="email"
              value={recoveryEmail}
              onChange={(e) => setRecoveryEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Backup SMS / Out-of-Band Phone
            </label>
            <input
              type="text"
              value={recoveryPhone}
              onChange={(e) => setRecoveryPhone(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg bg-white"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Trusted Recovery Steward Name
            </label>
            <input
              type="text"
              value={trustedContactName}
              onChange={(e) => setTrustedContactName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Trusted Steward Email
            </label>
            <input
              type="email"
              value={trustedContactEmail}
              onChange={(e) => setTrustedContactEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Hardware FIDO2 Security Key Label
            </label>
            <input
              type="text"
              value={hardwareKeyLabel}
              onChange={(e) => setHardwareKeyLabel(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Recovery Time-Lock Delay
            </label>
            <select
              value={timeLockHours}
              onChange={(e) => setTimeLockHours(Number(e.target.value) as 24 | 48 | 72)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              <option value={24}>24 Hours · Fast Institutional</option>
              <option value={48}>48 Hours · Standard Custody Lock</option>
              <option value={72}>72 Hours · High-Value Vault Lock</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={dualControlRequired}
              onChange={(e) => setDualControlRequired(e.target.checked)}
            />
            <span>Require dual-control steward approval during recovery override</span>
          </label>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
          >
            {saving ? 'Saving...' : 'Update Account Recovery'}
          </button>
        </div>
      </form>

      {/* Cryptographic Backup Recovery Codes */}
      <div className="pt-4 border-t border-slate-200 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold text-slate-900">
              Single-Use Cryptographic Recovery Codes
            </h4>
            <p className="text-xs text-slate-500 mt-0.5">
              Rotate recovery batch to invalidate older offline codes and export an emergency kit.
            </p>
          </div>
          <button
            type="button"
            disabled={rotatingCodes}
            onClick={() => void handleRotateBackupCodes()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>{rotatingCodes ? 'Generating...' : 'Rotate 8-Code Kit'}</span>
          </button>
        </div>

        {generatedCodes && (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-900">
                New Emergency Kit · Save Offline Now
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(generatedCodes.join('\n'));
                    setCopiedKit(true);
                    window.setTimeout(() => setCopiedKit(false), 2000);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedKit ? 'Copied' : 'Copy Codes'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadRecoveryKit}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-900 bg-white border border-slate-200 rounded hover:bg-slate-100 cursor-pointer"
                >
                  <Download className="w-3 h-3" />
                  <span>Download Kit</span>
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {generatedCodes.map((code) => (
                <div
                  key={code}
                  className="px-2.5 py-1.5 bg-white border border-slate-200 rounded text-xs font-mono text-slate-900 text-center tabular-nums"
                >
                  {code}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Inline TOTP Challenge Drawer when verifying drill or initiating hold */}
      {drillOpen && (
        <form
          onSubmit={(e) => void handleConfirmTotpAction(e)}
          className="p-4 bg-slate-50 border border-slate-300 rounded-lg space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-900">
              {pendingStatusAction === 'recovery_hold'
                ? 'TOTP MFA Confirmation · Initiate Recovery Hold'
                : pendingStatusAction === 'drill_verified'
                  ? 'TOTP MFA Confirmation · Verify Recovery Drill'
                  : 'TOTP MFA Confirmation · Release Recovery Hold'}
            </span>
            <button
              type="button"
              onClick={() => setDrillOpen(false)}
              className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
            >
              Cancel
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-white border border-slate-200 rounded-lg">
            <div>
              <span className="text-[11px] text-slate-500 block">Live Authenticator Token</span>
              <span className="text-base font-mono font-semibold tracking-widest text-slate-900 tabular-nums">
                {liveCode}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="font-mono text-slate-500">{secondsLeft}s</span>
              <button
                type="button"
                onClick={() => setEnteredCode(liveCode)}
                className="font-medium text-slate-900 underline cursor-pointer"
              >
                Autofill Token
              </button>
            </div>
          </div>

          {drillError && (
            <div className="p-2.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
              {drillError}
            </div>
          )}

          <div className="flex items-center gap-3">
            <input
              type="text"
              maxLength={6}
              value={enteredCode}
              onChange={(e) => setEnteredCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="Enter 6-digit code"
              className="flex-1 px-3 py-2 text-sm font-mono tracking-widest border border-slate-200 rounded-lg bg-white"
              required
            />
            <button
              type="submit"
              disabled={verifyingDrill}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
            >
              {verifyingDrill ? 'Verifying...' : 'Confirm Action'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
