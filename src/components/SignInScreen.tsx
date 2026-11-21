import { ShieldCheck, ArrowRight, LockKeyhole, Building2, Activity, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function SignInScreen() {
  const { signInWithGoogle, authError } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between">
      <header className="h-16 border-b border-slate-200 bg-white px-6 lg:px-12 flex items-center justify-between gap-8">
        <span className="text-lg font-semibold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display">
          Veridian Ledger
        </span>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Sign In with Google
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="max-w-5xl w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-8 lg:p-10 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500 mb-3">
                Treasury Operations · DTC Custody · Regulatory Compliance
              </p>
              <h1 className="text-3xl lg:text-4xl font-semibold tracking-tight text-slate-900 leading-tight mb-4 font-display [text-wrap:balance]">
                Real-time bank ledger, custody registration, and audit-grade reporting.
              </h1>
              <p className="text-base text-slate-600 leading-relaxed mb-8">
                Monitor live cash positions, enforce personalized category budget thresholds, run
                batch recurring expense categorization, settle MFA-verified payments, and manage
                DTC custody and brokerage regulatory filings from a unified workspace.
              </p>

              {authError && (
                <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                  {authError}
                </div>
              )}

              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                className="inline-flex items-center gap-3 px-6 py-3 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
              >
                <span>Authenticate with Google Workspace</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-10 pt-6 border-t border-slate-100 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500">
              <span>Zero-Trust Owner Isolation</span>
              <span aria-hidden="true">·</span>
              <span>RFC-6238 TOTP MFA</span>
              <span aria-hidden="true">·</span>
              <span>FINRA 4511 &amp; SEC 17a-4 Ready</span>
            </div>
          </section>

          <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-8 flex flex-col justify-between space-y-6">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 mb-5 font-display">
                Workspace Capabilities
              </h2>
              <div className="space-y-5">
                <div className="flex items-start gap-3">
                  <Activity className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      Real-Time Spending &amp; Budget Alerts
                    </p>
                    <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                      Live bank ledger streams with monthly cash-flow analytics and automated
                      threshold alerts.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <FileSpreadsheet className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      Batch Recurring Categorization
                    </p>
                    <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                      Ingest CSV or bank-feed batches, detect recurring cadences, and commit
                      atomically.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <LockKeyhole className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      DTC MFA Registration &amp; Payments
                    </p>
                    <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                      Multi-factor TOTP verification for outgoing payment settlements and DTC custody
                      onboarding.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <Building2 className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      Brokerage Compliance &amp; Tax Docs
                    </p>
                    <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                      Register FINRA/SEC brokerage firms and generate 1099-B, W-9, and Schedule-D
                      filings.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
              <span>Verified Google identity required for ledger access</span>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
