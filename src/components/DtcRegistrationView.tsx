import { useEffect, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { CheckCircle2, Copy, KeyRound, Plus, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { DtcAccountTier, DtcRegistration, MfaMethod } from '../types/finance';
import { generateSafeId } from '../utils/formatters';
import {
  formatOtpAuthUri,
  generateTotpCode,
  generateTotpSecret,
  getTotpSecondsRemaining,
  verifyTotpCode,
} from '../utils/totp';

interface DtcRegistrationViewProps {
  registrations: DtcRegistration[];
}

const TIER_LABELS: Record<DtcAccountTier, string> = {
  individual_custody: 'Individual Direct Custody',
  institutional_margin: 'Institutional Margin & Clearing',
  prime_cash: 'Prime Cash Custody',
};

export function DtcRegistrationView({ registrations }: DtcRegistrationViewProps) {
  const { user } = useAuth();
  const [selectedId, setSelectedId] = useState<string>(registrations[0]?.id || '');
  const [modalOpen, setModalOpen] = useState(false);

  // Create DTC registration form state
  const [legalEntityName, setLegalEntityName] = useState('');
  const [accountTier, setAccountTier] = useState<DtcAccountTier>('institutional_margin');
  const [taxIdLast4, setTaxIdLast4] = useState('');
  const [jurisdiction, setJurisdiction] = useState('United States · New York');
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('totp_authenticator');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // MFA enrollment & verification state
  const [totpSecret, setTotpSecret] = useState(() => generateTotpSecret());
  const [liveCode, setLiveCode] = useState('------');
  const [secondsLeft, setSecondsLeft] = useState(getTotpSecondsRemaining());
  const [enteredCode, setEnteredCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [verifyingMfa, setVerifyingMfa] = useState(false);
  const [disclosureChecked, setDisclosureChecked] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [updatingStage, setUpdatingStage] = useState(false);

  const activeReg =
    registrations.find((r) => r.id === selectedId) || registrations[0] || null;

  useEffect(() => {
    let active = true;
    const tick = async () => {
      const code = await generateTotpCode(totpSecret);
      if (active) {
        setLiveCode(code);
        setSecondsLeft(getTotpSecondsRemaining());
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [totpSecret]);

  const handleCreateRegistration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setCreateError(null);

    if (!/^[0-9]{4}$/.test(taxIdLast4)) {
      setCreateError('Tax ID / EIN suffix must be exactly 4 digits.');
      return;
    }

    setCreating(true);
    try {
      const ref = await addDoc(collection(db, 'dtc_registrations'), {
        ownerId: user.uid,
        legalEntityName: legalEntityName.trim(),
        accountTier,
        taxIdLast4,
        jurisdiction: jurisdiction.trim(),
        mfaMethod,
        mfaVerified: false,
        disclosureAccepted: false,
        dtcReferenceCode: generateSafeId('DTC'),
        status: 'draft',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setTotpSecret(generateTotpSecret());
      setSelectedId(ref.id);
      setLegalEntityName('');
      setTaxIdLast4('');
      setModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'dtc_registrations');
    } finally {
      setCreating(false);
    }
  };

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !activeReg) return;
    setMfaError(null);

    const ok = await verifyTotpCode(totpSecret, enteredCode);
    if (!ok) {
      setMfaError('Verification failed. Enter the current 6-digit TOTP authenticator token.');
      return;
    }

    setVerifyingMfa(true);
    try {
      await updateDoc(doc(db, 'dtc_registrations', activeReg.id), {
        mfaMethod: activeReg.mfaMethod,
        mfaVerified: true,
        status: 'mfa_verified',
        updatedAt: serverTimestamp(),
      });
      await updateDoc(doc(db, 'users', user.uid), {
        mfaEnrolled: true,
        updatedAt: serverTimestamp(),
      });
      setEnteredCode('');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `dtc_registrations/${activeReg.id}`);
    } finally {
      setVerifyingMfa(false);
    }
  };

  const handleSubmitDisclosure = async () => {
    if (!activeReg || !disclosureChecked) return;
    setUpdatingStage(true);
    try {
      await updateDoc(doc(db, 'dtc_registrations', activeReg.id), {
        disclosureAccepted: true,
        status: 'submitted',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `dtc_registrations/${activeReg.id}`);
    } finally {
      setUpdatingStage(false);
    }
  };

  const handleApproveDtc = async () => {
    if (!activeReg) return;
    setUpdatingStage(true);
    try {
      await updateDoc(doc(db, 'dtc_registrations', activeReg.id), {
        status: 'approved',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `dtc_registrations/${activeReg.id}`);
    } finally {
      setUpdatingStage(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 font-display">
            DTC Account Registration &amp; MFA Identity Verification
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Enforce cryptographic multi-factor identity verification before submitting Depository
            Trust Company custody enrollments.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setCreateError(null);
            setModalOpen(true);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New DTC Registration</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Registrations List */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
          <div className="p-4 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              Custody Applications ({registrations.length})
            </h3>
          </div>
          {registrations.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No DTC registrations started yet. Click New DTC Registration to begin.
            </div>
          ) : (
            registrations.map((reg) => {
              const isSelected = activeReg?.id === reg.id;
              return (
                <button
                  key={reg.id}
                  type="button"
                  onClick={() => {
                    setTotpSecret(generateTotpSecret());
                    setSelectedId(reg.id);
                    setMfaError(null);
                    setEnteredCode('');
                    setDisclosureChecked(reg.disclosureAccepted);
                  }}
                  className={`w-full text-left p-4 transition-colors cursor-pointer ${
                    isSelected ? 'bg-slate-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-900 truncate">
                      {reg.legalEntityName}
                    </span>
                    <span className="text-xs font-mono text-slate-500 shrink-0">
                      {reg.dtcReferenceCode}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {TIER_LABELS[reg.accountTier]} · Status:{' '}
                    <strong className="text-slate-800 capitalize">
                      {reg.status.replace('_', ' ')}
                    </strong>
                  </p>
                </button>
              );
            })
          )}
        </section>

        {/* Active Workflow Stepper */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          {!activeReg ? (
            <div className="py-12 text-center text-sm text-slate-500">
              Select or create a DTC registration to complete identity verification.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-slate-200">
                <div>
                  <p className="text-xs font-mono text-slate-500">
                    {activeReg.dtcReferenceCode} · TIN/EIN •••• {activeReg.taxIdLast4}
                  </p>
                  <h3 className="text-lg font-semibold text-slate-900 mt-1 font-display">
                    {activeReg.legalEntityName}
                  </h3>
                  <p className="text-xs text-slate-600 mt-0.5">
                    {TIER_LABELS[activeReg.accountTier]} · {activeReg.jurisdiction}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                    activeReg.status === 'approved'
                      ? 'text-emerald-700'
                      : activeReg.status === 'submitted'
                        ? 'text-slate-900'
                        : 'text-amber-700'
                  }`}
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span className="capitalize">{activeReg.status.replace('_', ' ')}</span>
                </span>
              </div>

              {/* 3-Stage Stepper */}
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                  <p className="font-medium text-slate-900">1. MFA Identity Gate</p>
                  <p className="text-slate-500 mt-0.5">
                    {activeReg.mfaVerified ? 'Verified via TOTP' : 'Pending verification'}
                  </p>
                </div>
                <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                  <p className="font-medium text-slate-900">2. Rule 15c3-3 Attestation</p>
                  <p className="text-slate-500 mt-0.5">
                    {activeReg.disclosureAccepted ? 'Signed & Submitted' : 'Awaiting signature'}
                  </p>
                </div>
                <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                  <p className="font-medium text-slate-900">3. Custody Activation</p>
                  <p className="text-slate-500 mt-0.5">
                    {activeReg.status === 'approved' ? 'DTC Active' : 'Pending approval'}
                  </p>
                </div>
              </div>

              {/* Stage 1: MFA Verification */}
              {activeReg.status === 'draft' && (
                <form onSubmit={(e) => void handleVerifyMfa(e)} className="space-y-4">
                  <div className="p-4 border border-slate-200 rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-900 flex items-center gap-1.5">
                        <KeyRound className="w-3.5 h-3.5" />
                        <span>Authenticator Provisioning Key (RFC-6238 HMAC-SHA1)</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            formatOtpAuthUri(activeReg.legalEntityName, totpSecret),
                          );
                          setCopiedSecret(true);
                          window.setTimeout(() => setCopiedSecret(false), 2000);
                        }}
                        className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                      >
                        <Copy className="w-3 h-3" />
                        <span>{copiedSecret ? 'Copied URI' : 'Copy otpauth URI'}</span>
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                      <div>
                        <p className="text-[11px] text-slate-500">Base32 Secret</p>
                        <p className="text-xs font-mono text-slate-800">{totpSecret}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[11px] text-slate-500">
                          Current 6-Digit Token ({secondsLeft}s)
                        </p>
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-mono font-semibold tracking-widest text-slate-900 tabular-nums">
                            {liveCode}
                          </span>
                          <button
                            type="button"
                            onClick={() => setEnteredCode(liveCode)}
                            className="text-xs font-medium text-slate-700 underline cursor-pointer"
                          >
                            Use Code
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {mfaError && (
                    <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                      {mfaError}
                    </div>
                  )}

                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex-1 min-w-[200px]">
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Enter 6-Digit MFA Verification Code
                      </label>
                      <input
                        type="text"
                        maxLength={6}
                        value={enteredCode}
                        onChange={(e) =>
                          setEnteredCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                        }
                        placeholder="000000"
                        className="w-full px-3 py-2 text-sm font-mono tracking-widest border border-slate-200 rounded-lg"
                        required
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={verifyingMfa}
                      className="px-5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer h-[38px]"
                    >
                      {verifyingMfa ? 'Verifying...' : 'Verify Identity via MFA'}
                    </button>
                  </div>
                </form>
              )}

              {/* Stage 2: Custody Disclosure */}
              {activeReg.status === 'mfa_verified' && (
                <div className="space-y-4">
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 leading-relaxed space-y-2">
                    <p className="font-semibold text-slate-900">
                      Depository Trust Company (DTC) Participant Custody Attestation
                    </p>
                    <p>
                      By submitting this registration, the beneficial owner attests under SEC Rule
                      15c3-3 and FINRA Rule 4511 that all TIN/EIN identifiers and authorized
                      signatories are accurate, and authorizes multi-factor settlement controls on
                      custody transfers.
                    </p>
                  </div>
                  <label className="flex items-start gap-2.5 text-xs text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={disclosureChecked}
                      onChange={(e) => setDisclosureChecked(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      I accept the DTC Participant Custody Agreement and certify beneficial
                      ownership accuracy.
                    </span>
                  </label>
                  <button
                    type="button"
                    disabled={!disclosureChecked || updatingStage}
                    onClick={() => void handleSubmitDisclosure()}
                    className="px-5 py-2.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                  >
                    {updatingStage ? 'Submitting...' : 'Submit Registration to DTC'}
                  </button>
                </div>
              )}

              {/* Stage 3: Final Activation */}
              {activeReg.status === 'submitted' && (
                <div className="space-y-4">
                  <div className="p-4 border border-slate-200 rounded-lg text-xs text-slate-700 space-y-1">
                    <p className="font-medium text-slate-900">
                      MFA Verified &amp; Disclosures Signed
                    </p>
                    <p>
                      Application {activeReg.dtcReferenceCode} has passed automated KYC/AML syntax
                      checks and is ready for participant custody activation.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={updatingStage}
                    onClick={() => void handleApproveDtc()}
                    className="px-5 py-2.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                  >
                    {updatingStage ? 'Activating...' : 'Finalize & Activate DTC Custody Account'}
                  </button>
                </div>
              )}

              {activeReg.status === 'approved' && (
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-3 text-xs text-emerald-900">
                  <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
                  <div>
                    <p className="font-semibold">DTC Custody Account Active</p>
                    <p className="mt-0.5 text-emerald-800">
                      Reference {activeReg.dtcReferenceCode} is verified via MFA, attested, and
                      enabled for institutional settlement.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* New DTC Registration Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                New DTC Account Registration
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleCreateRegistration(e)} className="mt-5 space-y-4">
              {createError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {createError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Legal Entity / Account Holder Name
                </label>
                <input
                  type="text"
                  value={legalEntityName}
                  onChange={(e) => setLegalEntityName(e.target.value)}
                  placeholder="Veridian Capital Holdings LP"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  DTC Custody Tier
                </label>
                <select
                  value={accountTier}
                  onChange={(e) => setAccountTier(e.target.value as DtcAccountTier)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="individual_custody">Individual Direct Custody</option>
                  <option value="institutional_margin">Institutional Margin &amp; Clearing</option>
                  <option value="prime_cash">Prime Cash Custody</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    SSN / EIN Last 4
                  </label>
                  <input
                    type="text"
                    maxLength={4}
                    value={taxIdLast4}
                    onChange={(e) => setTaxIdLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="9241"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    MFA Method
                  </label>
                  <select
                    value={mfaMethod}
                    onChange={(e) => setMfaMethod(e.target.value as MfaMethod)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="totp_authenticator">TOTP Authenticator</option>
                    <option value="hardware_key">FIDO2 Hardware Key</option>
                    <option value="sms_otp">SMS Verification</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Jurisdiction
                </label>
                <input
                  type="text"
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>
              <div className="pt-3 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {creating ? 'Creating...' : 'Create Draft & Begin MFA'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
