import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { generateSafeId } from './formatters';

export async function ensureUserWorkspaceSeeded(user: User): Promise<void> {
  const uid = user.uid;

  try {
    const userRef = doc(db, 'users', uid);
    const recoveryRef = doc(db, 'users', uid, 'private', 'recovery');
    const [
      userSnap,
      recoverySnap,
      existingAccounts,
      existingAssets,
      existingBankArch,
      existingBrokerageArch,
      existingRailArch,
      existingAcquisitionArch,
      existingCompanyAccounts,
      existingPublicAccounts,
      existingStagedAssets,
      existingBrokerageAccounts,
    ] = await Promise.all([
      getDoc(userRef),
      getDoc(recoveryRef),
      getDocs(query(collection(db, 'bank_accounts'), where('ownerId', '==', uid), limit(6))),
      getDocs(query(collection(db, 'assets'), where('ownerId', '==', uid), limit(1))),
      getDocs(query(collection(db, 'bank_tx_architectures'), where('ownerId', '==', uid), limit(1))),
      getDocs(query(collection(db, 'brokerage_tx_architectures'), where('ownerId', '==', uid), limit(1))),
      getDocs(query(collection(db, 'rail_architectures'), where('ownerId', '==', uid), limit(1))),
      getDocs(query(collection(db, 'acquisition_architectures'), where('ownerId', '==', uid), limit(1))),
      getDocs(query(collection(db, 'company_accounts'), where('ownerId', '==', uid), limit(1))),
      getDocs(query(collection(db, 'public_accounts'), where('ownerId', '==', uid), limit(1))),
      getDocs(query(collection(db, 'staged_assets'), where('ownerId', '==', uid), limit(1))),
      getDocs(query(collection(db, 'brokerage_accounts'), where('ownerId', '==', uid), limit(1))),
    ]);

    const existingPurchasesAcc = existingAccounts.docs.find(
      (d) => d.data()?.accountType === 'purchases',
    );
    const hasPurchasesAccountConfigured = Boolean(userSnap.data()?.purchasesAccountId);

    if (
      userSnap.exists() &&
      hasPurchasesAccountConfigured &&
      recoverySnap.exists() &&
      !existingAccounts.empty &&
      !existingAssets.empty &&
      !existingBankArch.empty &&
      !existingBrokerageArch.empty &&
      !existingRailArch.empty &&
      !existingAcquisitionArch.empty &&
      !existingCompanyAccounts.empty &&
      !existingPublicAccounts.empty &&
      !existingStagedAssets.empty &&
      !existingBrokerageAccounts.empty
    ) {
      return;
    }

    const batch = writeBatch(db);
    let primaryOperatingId = existingAccounts.docs[0]?.id || '';
    let primaryTreasuryId = existingAccounts.docs[1]?.id || existingAccounts.docs[0]?.id || '';
    let primarySettlementId = existingAccounts.docs[2]?.id || existingAccounts.docs[0]?.id || '';
    let primaryPurchasesId =
      existingPurchasesAcc?.id ||
      (userSnap.data()?.purchasesAccountId as string | undefined) ||
      primaryTreasuryId;
    let primaryFirmId = '';

    let primaryBrokerageId = existingBrokerageAccounts.docs[0]?.id || '';

    if (
      !existingAccounts.empty &&
      (existingAssets.empty ||
        existingBrokerageArch.empty ||
        existingAcquisitionArch.empty ||
        existingStagedAssets.empty ||
        existingBrokerageAccounts.empty)
    ) {
      const existingFirms = await getDocs(
        query(collection(db, 'brokerage_firms'), where('ownerId', '==', uid), limit(1)),
      );
      if (!existingFirms.empty) {
        primaryFirmId = existingFirms.docs[0].id;
      } else {
        const fallbackFirmRef = doc(collection(db, 'brokerage_firms'));
        batch.set(fallbackFirmRef, {
          ownerId: uid,
          firmName: 'Meridian Clearing & Custody LLC',
          crdNumber: '284910',
          secFileNumber: '8-69412',
          dtcParticipantNumber: '0492',
          clearingHouse: 'DTCC / NSCC National Clearing',
          complianceOfficer: 'Evelyn Vance, CCO',
          finraDistrict: 'District 10 · New York',
          complianceStatus: 'active',
          regulations: [
            'FINRA Rule 4511 (Books & Records)',
            'SEC Rule 17a-4 (WORM Archival)',
            'SEC Rule 15c3-3 (Customer Protection)',
            'FATCA / CRS Tax Reporting',
          ],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        primaryFirmId = fallbackFirmRef.id;
      }
    }

    if (!userSnap.exists()) {
      batch.set(userRef, {
        ownerId: uid,
        displayName: (user.displayName || 'Treasury Account Holder').slice(0, 120),
        mfaEnrolled: false,
        preferredCurrency: 'USD',
        purchasesAccountId: primaryPurchasesId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const privateRef = doc(db, 'users', uid, 'private', 'profile');
      batch.set(privateRef, {
        ownerId: uid,
        email: (user.email || 'user@veridianledger.com').slice(0, 200),
        phone: '+1-212-555-0194',
        legalAddress: '100 Liberty Plaza, Suite 1400, New York, NY 10006',
        taxIdLast4: '4829',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (!hasPurchasesAccountConfigured && primaryPurchasesId) {
      batch.update(userRef, {
        purchasesAccountId: primaryPurchasesId,
        updatedAt: serverTimestamp(),
      });
    }

    if (!recoverySnap.exists()) {
      batch.set(recoveryRef, {
        ownerId: uid,
        recoveryEmail: (user.email || 'recovery@veridianledger.com').slice(0, 200),
        recoveryPhone: '+1-212-555-0194',
        trustedContactName: 'Evelyn Vance, CCO',
        trustedContactEmail: 'custody-steward@veridianledger.com',
        hardwareKeyLabel: 'YubiKey 5C NFC · Primary Treasury',
        backupCodesRemaining: 8,
        recoveryCodeBatchId: generateSafeId('RCV'),
        timeLockHours: 48,
        dualControlRequired: true,
        recoveryStatus: 'configured',
        lastDrillAt: '2026-11-18',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (existingAccounts.empty) {
      const accOperating = doc(collection(db, 'bank_accounts'));
      const accTreasury = doc(collection(db, 'bank_accounts'));
      const accSettlement = doc(collection(db, 'bank_accounts'));
      const accPurchases = doc(collection(db, 'bank_accounts'));

      batch.set(accOperating, {
        ownerId: uid,
        accountName: 'Primary Operating Checking',
        institutionName: 'JPMorgan Chase Bank',
        accountType: 'checking',
        accountMask: '4418',
        currency: 'USD',
        balance: 148920.45,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(accTreasury, {
        ownerId: uid,
        accountName: 'Treasury Reserve Sweep',
        institutionName: 'BNY Mellon Custody',
        accountType: 'treasury',
        accountMask: '9024',
        currency: 'USD',
        balance: 612400.0,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(accSettlement, {
        ownerId: uid,
        accountName: 'DTC Clearing Cash Account',
        institutionName: 'Citibank Institutional',
        accountType: 'settlement',
        accountMask: '7731',
        currency: 'USD',
        balance: 84250.0,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(accPurchases, {
        ownerId: uid,
        accountName: 'Corporate Purchases & Acquisitions',
        institutionName: 'BNY Mellon Institutional Purchases',
        accountType: 'purchases',
        accountMask: '6204',
        currency: 'USD',
        balance: 1450000.0,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      primaryPurchasesId = accPurchases.id;

      const starterTransactions = [
        {
          accountId: accOperating.id,
          merchant: 'Amazon Web Services',
          description: 'Production cloud compute & encrypted storage',
          amount: 2840.5,
          direction: 'debit',
          category: 'Cloud & Infrastructure',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-11-17',
        },
        {
          accountId: accOperating.id,
          merchant: 'Cloudflare Enterprise',
          description: 'Zero-trust edge firewall & DNS routing',
          amount: 1450.0,
          direction: 'debit',
          category: 'Cloud & Infrastructure',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-11-14',
        },
        {
          accountId: accSettlement.id,
          merchant: 'Bloomberg Terminal',
          description: 'Institutional market feed & analytics seat',
          amount: 2450.0,
          direction: 'debit',
          category: 'Market Data & Custody',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-11-12',
        },
        {
          accountId: accSettlement.id,
          merchant: 'DTCC Participant Clearing',
          description: 'Monthly DTC custody & settlement assessment',
          amount: 1850.0,
          direction: 'debit',
          category: 'Market Data & Custody',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-11-10',
        },
        {
          accountId: accOperating.id,
          merchant: 'ADP Payroll Services',
          description: 'Mid-month salaried operations payroll',
          amount: 28400.0,
          direction: 'debit',
          category: 'Payroll & Benefits',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-11-08',
        },
        {
          accountId: accOperating.id,
          merchant: 'Equinix NY4 Facility',
          description: 'Primary trading & settlement rack lease',
          amount: 3400.0,
          direction: 'debit',
          category: 'Office & Facilities',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-11-05',
        },
        {
          accountId: accOperating.id,
          merchant: 'Delta Corporate Travel',
          description: 'FINRA compliance audit site visit airfare',
          amount: 1620.8,
          direction: 'debit',
          category: 'Travel & T&E',
          isRecurring: false,
          recurrenceCadence: 'none',
          status: 'posted',
          occurredAt: '2026-11-04',
        },
        {
          accountId: accTreasury.id,
          merchant: 'US Treasury Coupon',
          description: 'T-Bill maturity & quarterly dividend sweep',
          amount: 46800.0,
          direction: 'credit',
          category: 'Revenue & Dividends',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-11-02',
        },
        {
          accountId: accOperating.id,
          merchant: 'Vanguard Advisory Inflow',
          description: 'Client custody management fee settlement',
          amount: 32500.0,
          direction: 'credit',
          category: 'Revenue & Dividends',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-10-24',
        },
        {
          accountId: accOperating.id,
          merchant: 'Amazon Web Services',
          description: 'October production cloud compute',
          amount: 2710.0,
          direction: 'debit',
          category: 'Cloud & Infrastructure',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-10-17',
        },
        {
          accountId: accOperating.id,
          merchant: 'ADP Payroll Services',
          description: 'October salaried operations payroll',
          amount: 28100.0,
          direction: 'debit',
          category: 'Payroll & Benefits',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-10-08',
        },
        {
          accountId: accTreasury.id,
          merchant: 'Institutional Custody Fee',
          description: 'September client retainer inflow',
          amount: 58400.0,
          direction: 'credit',
          category: 'Revenue & Dividends',
          isRecurring: true,
          recurrenceCadence: 'monthly',
          status: 'posted',
          occurredAt: '2026-09-21',
        },
      ];

      for (const tx of starterTransactions) {
        const txRef = doc(collection(db, 'transactions'));
        batch.set(txRef, {
          ownerId: uid,
          accountId: tx.accountId,
          merchant: tx.merchant,
          description: tx.description,
          amount: tx.amount,
          direction: tx.direction,
          category: tx.category,
          isRecurring: tx.isRecurring,
          recurrenceCadence: tx.recurrenceCadence,
          batchId: '',
          status: tx.status,
          occurredAt: tx.occurredAt,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const starterBudgets = [
        {
          category: 'Cloud & Infrastructure',
          monthlyLimit: 4000,
          warningThresholdPct: 80,
          criticalThresholdPct: 100,
        },
        {
          category: 'Market Data & Custody',
          monthlyLimit: 4500,
          warningThresholdPct: 80,
          criticalThresholdPct: 95,
        },
        {
          category: 'Payroll & Benefits',
          monthlyLimit: 32000,
          warningThresholdPct: 85,
          criticalThresholdPct: 98,
        },
        {
          category: 'Office & Facilities',
          monthlyLimit: 5000,
          warningThresholdPct: 80,
          criticalThresholdPct: 100,
        },
        {
          category: 'Travel & T&E',
          monthlyLimit: 1500,
          warningThresholdPct: 75,
          criticalThresholdPct: 95,
        },
      ];

      for (const b of starterBudgets) {
        const budgetRef = doc(collection(db, 'budgets'));
        batch.set(budgetRef, {
          ownerId: uid,
          category: b.category,
          monthlyLimit: b.monthlyLimit,
          warningThresholdPct: b.warningThresholdPct,
          criticalThresholdPct: b.criticalThresholdPct,
          alertsEnabled: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const dtcRef = doc(collection(db, 'dtc_registrations'));
      batch.set(dtcRef, {
        ownerId: uid,
        legalEntityName: 'Veridian Institutional Custody Partners',
        accountTier: 'institutional_margin',
        taxIdLast4: '4829',
        jurisdiction: 'United States · Delaware',
        mfaMethod: 'totp_authenticator',
        mfaVerified: false,
        disclosureAccepted: false,
        dtcReferenceCode: generateSafeId('DTC'),
        status: 'draft',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const firmRef = doc(collection(db, 'brokerage_firms'));
      batch.set(firmRef, {
        ownerId: uid,
        firmName: 'Meridian Clearing & Custody LLC',
        crdNumber: '284910',
        secFileNumber: '8-69412',
        dtcParticipantNumber: '0492',
        clearingHouse: 'DTCC / NSCC National Clearing',
        complianceOfficer: 'Evelyn Vance, CCO',
        finraDistrict: 'District 10 · New York',
        complianceStatus: 'active',
        regulations: [
          'FINRA Rule 4511 (Books & Records)',
          'SEC Rule 17a-4 (WORM Archival)',
          'SEC Rule 15c3-3 (Customer Protection)',
          'FATCA / CRS Tax Reporting',
        ],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const taxDocRef1 = doc(collection(db, 'tax_documents'));
      batch.set(taxDocRef1, {
        ownerId: uid,
        firmId: firmRef.id,
        accountId: accTreasury.id,
        formType: '1099-B',
        taxYear: 2026,
        filingStatus: 'ready',
        grossProceeds: 142850.0,
        withheldTax: 18420.0,
        referenceCode: generateSafeId('TAX'),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const taxDocRef2 = doc(collection(db, 'tax_documents'));
      batch.set(taxDocRef2, {
        ownerId: uid,
        firmId: firmRef.id,
        accountId: accSettlement.id,
        formType: 'W-9',
        taxYear: 2026,
        filingStatus: 'filed',
        grossProceeds: 0,
        withheldTax: 0,
        referenceCode: generateSafeId('TAX'),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const reportRef = doc(collection(db, 'financial_reports'));
      batch.set(reportRef, {
        ownerId: uid,
        accountId: accOperating.id,
        reportTitle: 'October 2026 Operating Cash Flow Statement',
        reportPeriod: '2026-10',
        reportType: 'monthly_statement',
        totalInflow: 32500.0,
        totalOutflow: 30810.0,
        netCashFlow: 1690.0,
        transactionCount: 3,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      primaryOperatingId = accOperating.id;
      primaryTreasuryId = accTreasury.id;
      primarySettlementId = accSettlement.id;
      primaryFirmId = firmRef.id;
    }

    if (existingBrokerageAccounts.empty) {
      const brkPrimeRef = doc(collection(db, 'brokerage_accounts'));
      const brkIraRef = doc(collection(db, 'brokerage_accounts'));

      batch.set(brkPrimeRef, {
        ownerId: uid,
        firmId: primaryFirmId,
        linkedBankAccountId: primaryTreasuryId || primaryOperatingId,
        accountName: 'Meridian Institutional Prime Brokerage',
        brokerInstitution: 'Meridian Clearing & Custody LLC',
        accountType: 'institutional_prime',
        accountMask: '8840',
        connectionMode: 'api_sync',
        apiProvider: 'custody_fix_gateway',
        syncStatus: 'synced',
        lastSyncedAt: '2026-11-18T16:00:00Z',
        currency: 'USD',
        cashBalance: 142500.0,
        marginDebt: 0,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(brkIraRef, {
        ownerId: uid,
        firmId: '',
        linkedBankAccountId: primaryOperatingId,
        accountName: 'Executive Long-Horizon Equity Brokerage',
        brokerInstitution: 'Charles Schwab Institutional',
        accountType: 'individual_taxable',
        accountMask: '3109',
        connectionMode: 'manual',
        apiProvider: 'manual_ledger',
        syncStatus: 'manual_only',
        lastSyncedAt: '2026-11-18T12:30:00Z',
        currency: 'USD',
        cashBalance: 38400.0,
        marginDebt: 0,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      primaryBrokerageId = brkPrimeRef.id;
    }

    if (existingAssets.empty) {
      const ingestionRef = doc(collection(db, 'asset_ingestions'));
      batch.set(ingestionRef, {
        ownerId: uid,
        fileName: 'meridian-q4-custody-schedule.csv',
        mimeType: 'text/csv',
        fileSizeBytes: 2480,
        documentCategory: 'holdings_csv',
        extractionEngine: 'csv_parser',
        extractedCount: 3,
        totalExtractedValue: 1384500.0,
        status: 'committed',
        summaryNotes:
          'Initial custody schedule covering public treasury ETF, private credit LP, and commercial real estate deed.',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const starterAssets = [
        {
          accountId: primaryTreasuryId,
          firmId: primaryFirmId,
          assetName: 'iShares 7-10 Year Treasury Bond ETF',
          tickerOrIdentifier: 'IEF',
          assetCategoryGroup: 'public_securities',
          assetClass: 'etf_fund',
          quantity: 2400,
          unitCostBasis: 94.25,
          totalMarketValue: 229200.0,
          currency: 'USD',
          valuationDate: '2026-11-18',
          jurisdiction: 'United States · Delaware',
          regulatoryClassification: 'Investment Company Act 1940',
        },
        {
          accountId: primaryTreasuryId,
          firmId: primaryFirmId,
          assetName: 'Veridian Private Credit Fund IV LP',
          tickerOrIdentifier: 'VPC-IV-LP',
          assetCategoryGroup: 'alternatives',
          assetClass: 'private_equity',
          quantity: 1,
          unitCostBasis: 350000.0,
          totalMarketValue: 390300.0,
          currency: 'USD',
          valuationDate: '2026-11-15',
          jurisdiction: 'United States · Delaware',
          regulatoryClassification: 'SEC Reg D 506(c) Accredited',
        },
        {
          accountId: primarySettlementId,
          firmId: primaryFirmId,
          assetName: '240 Madison Ave Suite 900 Commercial Deed',
          tickerOrIdentifier: 'NYC-BL0866-S900',
          assetCategoryGroup: 'real_estate',
          assetClass: 'commercial_real_estate',
          quantity: 1,
          unitCostBasis: 715000.0,
          totalMarketValue: 765000.0,
          currency: 'USD',
          valuationDate: '2026-11-10',
          jurisdiction: 'United States · New York',
          regulatoryClassification: 'Deed / ALTA Title Custody',
        },
      ];

      for (const ast of starterAssets) {
        const assetRef = doc(collection(db, 'assets'));
        batch.set(assetRef, {
          ownerId: uid,
          ingestionId: ingestionRef.id,
          accountId: ast.accountId,
          firmId: ast.firmId,
          brokerageAccountId: primaryBrokerageId,
          assetName: ast.assetName,
          tickerOrIdentifier: ast.tickerOrIdentifier,
          assetCategoryGroup: ast.assetCategoryGroup,
          assetClass: ast.assetClass,
          quantity: ast.quantity,
          unitCostBasis: ast.unitCostBasis,
          totalMarketValue: ast.totalMarketValue,
          currency: ast.currency,
          valuationDate: ast.valuationDate,
          jurisdiction: ast.jurisdiction,
          regulatoryClassification: ast.regulatoryClassification,
          mfaVerified: false,
          custodyStatus: 'pending_verification',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    if (existingStagedAssets.empty) {
      const stagedIngestionRef = doc(collection(db, 'asset_ingestions'));
      batch.set(stagedIngestionRef, {
        ownerId: uid,
        fileName: 'q4-custody-statement-extract.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 184320,
        documentCategory: 'brokerage_statement',
        extractionEngine: 'gemini_multimodal',
        extractedCount: 3,
        totalExtractedValue: 1323500.0,
        status: 'staged',
        summaryNotes:
          'Gemini multimodal extraction queued 3 holdings awaiting field accuracy verification.',
        rawDocumentText: [
          'MERIDIAN CLEARING & CUSTODY LLC · INSTITUTIONAL STATEMENT SCHEDULE',
          'Statement Period: Q4 2026 (As of 2026-11-18) · Participant: DTC #0492',
          'Account Reference: Treasury Reserve Sweep (•••• 9024) & DTC Clearing Cash (•••• 7731)',
          '------------------------------------------------------------------------',
          'POS-01 | EQUITY  | AAPL            | Apple Inc. Common Stock               | Qty: 1,200   | Cost: $198.50     | Mkt Val: $271,200.00 USD | State: CA',
          'POS-02 | FIXED   | US912828YV6     | US Treasury 2-Year Note (4.125%)      | Qty: 250     | Cost: $992.00     | Mkt Val: $249,800.00 USD | CUSIP: US912828YV6',
          'POS-03 | DEED-RE | BOS-PARCEL-4412 | 180 Harbor Logistics Industrial Deed  | Qty: 1       | Cost: $765,000.00 | Mkt Val: $802,500.00 USD | Registry: Suffolk MA',
          '------------------------------------------------------------------------',
          'TOTAL SCHEDULED HOLDINGS VALUATION: $1,323,500.00 USD',
        ].join('\n'),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const starterStagedRows = [
        {
          assetName: 'Apple Inc. Common Stock',
          tickerOrIdentifier: 'AAPL',
          assetCategoryGroup: 'public_securities',
          assetClass: 'public_equity',
          quantity: 1200,
          unitCostBasis: 198.5,
          totalMarketValue: 271200.0,
          currency: 'USD',
          valuationDate: '2026-11-18',
          jurisdiction: 'United States · California',
          regulatoryClassification: 'SEC Reg NMS / DTC Eligible',
          accountId: primaryTreasuryId,
          firmId: primaryFirmId,
          confidenceNote: 'OCR table match · Verify closing price valuation against statement page 2',
          sourceExcerpt:
            'POS-01 | EQUITY | AAPL | Apple Inc. Common Stock | Qty: 1,200 | Cost: $198.50 | Mkt Val: $271,200.00 USD',
        },
        {
          assetName: 'US Treasury 2-Year Note (4.125%)',
          tickerOrIdentifier: 'US912828YV6',
          assetCategoryGroup: 'public_securities',
          assetClass: 'fixed_income',
          quantity: 250,
          unitCostBasis: 992.0,
          totalMarketValue: 249800.0,
          currency: 'USD',
          valuationDate: '2026-11-18',
          jurisdiction: 'United States · Federal',
          regulatoryClassification: 'TRACE / MSRB Fixed Income',
          accountId: primaryTreasuryId,
          firmId: primaryFirmId,
          confidenceNote: 'CUSIP parsed from fixed-income schedule · Confirm par quantity and accrued value',
          sourceExcerpt:
            'POS-02 | FIXED | US912828YV6 | US Treasury 2-Year Note (4.125%) | Qty: 250 | Cost: $992.00 | Mkt Val: $249,800.00 USD',
        },
        {
          assetName: '180 Harbor Logistics Industrial Deed',
          tickerOrIdentifier: 'BOS-PARCEL-4412',
          assetCategoryGroup: 'real_estate',
          assetClass: 'commercial_real_estate',
          quantity: 1,
          unitCostBasis: 765000.0,
          totalMarketValue: 802500.0,
          currency: 'USD',
          valuationDate: '2026-11-14',
          jurisdiction: 'United States · Massachusetts',
          regulatoryClassification: 'Deed / ALTA Title Custody',
          accountId: primarySettlementId,
          firmId: primaryFirmId,
          confidenceNote: 'Extracted from closing appraisal summary · Verify parcel ID and appraised value',
          sourceExcerpt:
            'POS-03 | DEED-RE | BOS-PARCEL-4412 | 180 Harbor Logistics Industrial Deed | Qty: 1 | Cost: $765,000.00 | Mkt Val: $802,500.00 USD',
        },
      ];

      for (const item of starterStagedRows) {
        const stagedRef = doc(collection(db, 'staged_assets'));
        batch.set(stagedRef, {
          ownerId: uid,
          ingestionId: stagedIngestionRef.id,
          fileName: 'q4-custody-statement-extract.pdf',
          extractionEngine: 'gemini_multimodal',
          assetName: item.assetName,
          tickerOrIdentifier: item.tickerOrIdentifier,
          assetCategoryGroup: item.assetCategoryGroup,
          assetClass: item.assetClass,
          quantity: item.quantity,
          unitCostBasis: item.unitCostBasis,
          totalMarketValue: item.totalMarketValue,
          currency: item.currency,
          valuationDate: item.valuationDate,
          jurisdiction: item.jurisdiction,
          regulatoryClassification: item.regulatoryClassification,
          accountId: item.accountId,
          firmId: item.firmId,
          confidenceNote: item.confidenceNote,
          sourceExcerpt: item.sourceExcerpt,
          nameVerified: false,
          identifierVerified: false,
          valuationVerified: false,
          reviewStatus: 'pending_review',
          reviewerNotes: '',
          committedAssetId: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    if (existingBankArch.empty && primaryOperatingId) {
      const bankStarterRules = [
        {
          accountId: primaryOperatingId,
          ruleName: 'Operating Vendor NACHA ACH Origination',
          flowPattern: 'ach_origination',
          primaryRail: 'ACH',
          settlementWindow: 'Same-Day / T+1 Batch',
          singleTxLimit: 250000,
          dailyLimit: 1000000,
          mfaThreshold: 10000,
          dualApprovalRequired: false,
          autoReconcile: true,
          amlScreeningLevel: 'enhanced',
          status: 'active',
        },
        {
          accountId: primaryTreasuryId || primaryOperatingId,
          ruleName: 'Institutional Treasury Fedwire RTGS Dispatch',
          flowPattern: 'fedwire_rtgs',
          primaryRail: 'WIRE',
          settlementWindow: 'Real-Time Gross (Cut-off 18:00 ET)',
          singleTxLimit: 25000000,
          dailyLimit: 100000000,
          mfaThreshold: 0,
          dualApprovalRequired: true,
          autoReconcile: true,
          amlScreeningLevel: 'institutional',
          status: 'active',
        },
        {
          accountId: primarySettlementId || primaryOperatingId,
          ruleName: '24/7 Clearing Margin FedNow Instant Push',
          flowPattern: 'fednow_instant',
          primaryRail: 'FEDNOW',
          settlementWindow: '24/7/365 Instant (<10s)',
          singleTxLimit: 500000,
          dailyLimit: 2500000,
          mfaThreshold: 5000,
          dualApprovalRequired: false,
          autoReconcile: true,
          amlScreeningLevel: 'enhanced',
          status: 'active',
        },
      ];

      for (const rule of bankStarterRules) {
        const ref = doc(collection(db, 'bank_tx_architectures'));
        batch.set(ref, {
          ownerId: uid,
          ...rule,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    if (existingBrokerageArch.empty && primaryFirmId && primarySettlementId) {
      const brokerageStarterArch = [
        {
          architectureName: 'US Equities & ETF Smart Order + NSCC CNS Clearing',
          txType: 'equity_order_execution',
          clearingVenue: 'NSCC CNS / Lit Exchange & ATS',
          settlementCycle: 'T+1 Settlement',
          custodyModel: 'DTC Book-Entry Segregated',
          regulatoryControl: 'SEC Reg NMS · Rule 15c3-3',
          primaryRail: 'DTC_CNS',
          maxOrderNotional: 10000000,
          mfaRequired: false,
          status: 'active',
        },
        {
          architectureName: 'US Treasury & Corporate Bond FICC DVP/RVP',
          txType: 'fixed_income_dvp',
          clearingVenue: 'FICC GSD / Fedwire Securities',
          settlementCycle: 'T+0 / T+1 DVP',
          custodyModel: 'Institutional DVP/RVP',
          regulatoryControl: 'TRACE Reporting · MSRB',
          primaryRail: 'WIRE',
          maxOrderNotional: 50000000,
          mfaRequired: true,
          status: 'active',
        },
        {
          architectureName: 'Listed Equity & Index Options OCC Novation',
          txType: 'options_derivatives',
          clearingVenue: 'OCC Clearing Corp',
          settlementCycle: 'T+1 Premium & Exercise',
          custodyModel: 'OCC Segregated Margin',
          regulatoryControl: 'FINRA Rule 2360 · OCC Margin',
          primaryRail: 'DTC_CNS',
          maxOrderNotional: 5000000,
          mfaRequired: false,
          status: 'active',
        },
        {
          architectureName: 'Portfolio Margin & Reg T Collateral Sweep',
          txType: 'margin_financing',
          clearingVenue: 'Prime Brokerage Margin Engine',
          settlementCycle: 'Intraday Mark-to-Market',
          custodyModel: 'Hypothecated Margin Account',
          regulatoryControl: 'Fed Reg T · FINRA Rule 4210',
          primaryRail: 'INTERNAL',
          maxOrderNotional: 25000000,
          mfaRequired: true,
          status: 'active',
        },
        {
          architectureName: 'ACATS & Direct DTC Participant Custody Transfer',
          txType: 'acats_transfer',
          clearingVenue: 'NSCC ACATS & DTC Deliver',
          settlementCycle: '1–3 Business Days',
          custodyModel: 'Direct DTC Participant',
          regulatoryControl: 'FINRA Rule 11870 · TOTP MFA',
          primaryRail: 'DTC_CNS',
          maxOrderNotional: 50000000,
          mfaRequired: true,
          status: 'active',
        },
        {
          architectureName: 'Institutional Stock Loan & Reg SHO Locate',
          txType: 'securities_lending',
          clearingVenue: 'DTC Stock Loan / Bilateral Repo',
          settlementCycle: 'Same-Day Locate · T+0 Cash',
          custodyModel: '102% Cash Collateral Pledge',
          regulatoryControl: 'SEC Reg SHO Rule 203(b)',
          primaryRail: 'WIRE',
          maxOrderNotional: 15000000,
          mfaRequired: true,
          status: 'active',
        },
        {
          architectureName: 'DTC Corporate Actions, Coupons & Dividend Entitlement',
          txType: 'dividend_corp_action',
          clearingVenue: 'DTC Reorganization / Paying Agent',
          settlementCycle: 'Payable Date Cash Sweep',
          custodyModel: 'Beneficial Owner Entitlement',
          regulatoryControl: 'IRS 1099-DIV / 1042-S Tax',
          primaryRail: 'ACH',
          maxOrderNotional: 10000000,
          mfaRequired: false,
          status: 'active',
        },
        {
          architectureName: 'Private Credit & Real Estate Reg D Subscription Wire',
          txType: 'private_alt_subscription',
          clearingVenue: 'Fund Admin / Transfer Agent',
          settlementCycle: 'Capital Call T+2 Wire',
          custodyModel: 'Uncertificated LP Book-Entry',
          regulatoryControl: 'SEC Reg D 506(c) · K-1',
          primaryRail: 'WIRE',
          maxOrderNotional: 25000000,
          mfaRequired: true,
          status: 'active',
        },
      ];

      for (const arch of brokerageStarterArch) {
        const ref = doc(collection(db, 'brokerage_tx_architectures'));
        batch.set(ref, {
          ownerId: uid,
          firmId: primaryFirmId,
          settlementAccountId: primarySettlementId,
          ...arch,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    if (existingRailArch.empty && primaryOperatingId) {
      const starterRails = [
        {
          linkedAccountId: primaryOperatingId,
          railCode: 'ACH',
          railName: 'NACHA FedACH & Same-Day ACH',
          protocolStandard: 'NACHA CCD / CTX Batch',
          settlementFinality: 'Batch Netting (Same-Day / T+1)',
          cutoffWindow: '10:30 · 14:45 · 17:00 ET',
          slaLatency: '2–18 Hours',
          perTxCap: 1000000,
          feeBps: 0.5,
          failoverRailCode: 'FEDNOW',
          mfaPolicy: 'above_threshold',
          status: 'operational',
        },
        {
          linkedAccountId: primaryTreasuryId || primaryOperatingId,
          railCode: 'WIRE',
          railName: 'Fedwire Funds RTGS Service',
          protocolStandard: 'ISO 20022 pacs.008 / FAIM',
          settlementFinality: 'Irrevocable RTGS Finality',
          cutoffWindow: '09:00–18:00 ET Business Days',
          slaLatency: '< 45 Seconds',
          perTxCap: 100000000,
          feeBps: 1.5,
          failoverRailCode: 'SWIFT',
          mfaPolicy: 'always',
          status: 'operational',
        },
        {
          linkedAccountId: primarySettlementId || primaryOperatingId,
          railCode: 'FEDNOW',
          railName: 'FedNow & TCH RTP Instant Credit',
          protocolStandard: 'ISO 20022 Instant Credit Push',
          settlementFinality: 'Instant Irrevocable (<10s)',
          cutoffWindow: '24/7/365 Continuous',
          slaLatency: '< 5 Seconds',
          perTxCap: 500000,
          feeBps: 0.8,
          failoverRailCode: 'WIRE',
          mfaPolicy: 'above_threshold',
          status: 'operational',
        },
        {
          linkedAccountId: primaryTreasuryId || primaryOperatingId,
          railCode: 'SWIFT',
          railName: 'SWIFT gpi Cross-Border Correspondent',
          protocolStandard: 'ISO 20022 CBPR+ / UETR',
          settlementFinality: 'Correspondent Nostro T+1',
          cutoffWindow: 'Global FX Windows (UTC)',
          slaLatency: '15 Min – 24 Hours',
          perTxCap: 50000000,
          feeBps: 4.0,
          failoverRailCode: 'WIRE',
          mfaPolicy: 'dual_approval',
          status: 'operational',
        },
        {
          linkedAccountId: primarySettlementId || primaryOperatingId,
          railCode: 'DTC_CNS',
          railName: 'DTCC / NSCC / DTC Custody Settlement',
          protocolStandard: 'ISO 15022 / DTCC FIX',
          settlementFinality: 'DVP/RVP End-of-Day Net Finality',
          cutoffWindow: 'DTC SPO Cut-off 15:30 ET',
          slaLatency: 'T+1 Cycle',
          perTxCap: 250000000,
          feeBps: 0.25,
          failoverRailCode: 'WIRE',
          mfaPolicy: 'dual_approval',
          status: 'operational',
        },
        {
          linkedAccountId: primaryOperatingId,
          railCode: 'INTERNAL',
          railName: 'Veridian Internal Double-Entry Book Rail',
          protocolStandard: 'Atomic Firestore Batch Ledger',
          settlementFinality: 'Atomic Intra-Ledger Finality',
          cutoffWindow: '24/7/365 Immediate',
          slaLatency: '< 500 ms',
          perTxCap: 100000000,
          feeBps: 0,
          failoverRailCode: 'NONE',
          mfaPolicy: 'above_threshold',
          status: 'operational',
        },
      ];

      for (const rail of starterRails) {
        const ref = doc(collection(db, 'rail_architectures'));
        batch.set(ref, {
          ownerId: uid,
          ...rail,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    if (existingAcquisitionArch.empty && (primaryPurchasesId || primaryTreasuryId || primaryOperatingId)) {
      const defaultAcqFundId = primaryPurchasesId || primaryTreasuryId || primaryOperatingId;
      const starterAcquisitions = [
        {
          fundingAccountId: defaultAcqFundId,
          firmId: primaryFirmId,
          architectureName: 'Northbridge Custody HoldCo Acquisition',
          acquisitionType: 'strategic_ma_buyout',
          targetCounterparty: 'Northbridge Custody Partners LLC',
          dealStructure: 'SPV Cash Merger · SPA + Holdback Escrow',
          escrowAgent: 'BNY Mellon Institutional Escrow',
          closingHorizon: 'T+15 Business Days',
          settlementRail: 'WIRE',
          targetValuationUsd: 2500000,
          committedCapitalUsd: 550000,
          escrowHoldbackPct: 10,
          diligenceGateRequired: true,
          mfaSignoffRequired: true,
          stage: 'diligence',
          diligenceCompleted: false,
          escrowPaymentId: '',
          onboardedAssetId: '',
        },
        {
          fundingAccountId: defaultAcqFundId,
          firmId: '',
          architectureName: 'Suffolk Logistics ALTA Deed Acquisition',
          acquisitionType: 'real_estate_deed_escrow',
          targetCounterparty: 'Harborfront Industrial REIT',
          dealStructure: 'Fee Simple Deed + ALTA Title Custody',
          escrowAgent: 'First American Institutional Title',
          closingHorizon: 'T+10 Business Days',
          settlementRail: 'WIRE',
          targetValuationUsd: 840000,
          committedCapitalUsd: 420000,
          escrowHoldbackPct: 5,
          diligenceGateRequired: true,
          mfaSignoffRequired: true,
          stage: 'pipeline',
          diligenceCompleted: false,
          escrowPaymentId: '',
          onboardedAssetId: '',
        },
        {
          fundingAccountId: defaultAcqFundId || primarySettlementId,
          firmId: primaryFirmId,
          architectureName: 'US Treasury Ladder DVP Secondary Roll-Up',
          acquisitionType: 'treasury_portfolio_rollup',
          targetCounterparty: 'FICC Institutional Dealer Desk',
          dealStructure: 'FICC DVP Sovereign & Ladder Sweep',
          escrowAgent: 'Fedwire Securities / BNY Custody',
          closingHorizon: 'Same-Day T+0 / T+1',
          settlementRail: 'WIRE',
          targetValuationUsd: 350000,
          committedCapitalUsd: 350000,
          escrowHoldbackPct: 0,
          diligenceGateRequired: true,
          mfaSignoffRequired: true,
          stage: 'diligence',
          diligenceCompleted: true,
          escrowPaymentId: '',
          onboardedAssetId: '',
        },
      ];

      for (const acq of starterAcquisitions) {
        const ref = doc(collection(db, 'acquisition_architectures'));
        batch.set(ref, {
          ownerId: uid,
          ...acq,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    if (existingCompanyAccounts.empty && primaryOperatingId) {
      const starterCompanyAccounts = [
        {
          linkedAccountId: primaryOperatingId,
          companyName: 'Veridian Capital Holdings LLC',
          entityType: 'holding_co',
          einLast4: '8421',
          jurisdiction: 'United States · Delaware',
          industrySector: 'Institutional Asset Management',
          authorizedSignersCount: 4,
          creditFacilityLimit: 5000000,
          operatingBalance: 148920.45,
          dualApprovalRequired: true,
          status: 'active',
        },
        {
          linkedAccountId: primaryTreasuryId || primaryOperatingId,
          companyName: 'Meridian Clearing Operations Corp',
          entityType: 'c_corp',
          einLast4: '3190',
          jurisdiction: 'United States · New York',
          industrySector: 'Broker-Dealer & Custody Clearing',
          authorizedSignersCount: 3,
          creditFacilityLimit: 15000000,
          operatingBalance: 612400.0,
          dualApprovalRequired: true,
          status: 'active',
        },
      ];

      for (const co of starterCompanyAccounts) {
        const ref = doc(collection(db, 'company_accounts'));
        batch.set(ref, {
          ownerId: uid,
          ...co,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    if (existingPublicAccounts.empty && primaryTreasuryId) {
      const starterPublicAccounts = [
        {
          linkedAccountId: primaryTreasuryId,
          publicHandle: 'veridian.treasury',
          displayTitle: 'Veridian Public Treasury Reserve',
          issuerType: 'public_corporation',
          publicTickerOrLei: 'VRDN · 5493008V6X9L2M1K0P82',
          disclosedReserveUsd: 612400.0,
          transparencyStandard: 'SEC Form 10-Q · Real-Time Attestation',
          visibility: 'public_directory',
          allowInboundTransfers: true,
          status: 'published',
        },
        {
          linkedAccountId: primarySettlementId || primaryTreasuryId,
          publicHandle: 'meridian.clearing.pool',
          displayTitle: 'Meridian Public Settlement Liquidity Pool',
          issuerType: 'open_ledger',
          publicTickerOrLei: 'MRDN · DTCC-0492',
          disclosedReserveUsd: 84250.0,
          transparencyStandard: 'FINRA Rule 4511 · Daily Proof of Reserve',
          visibility: 'public_directory',
          allowInboundTransfers: true,
          status: 'published',
        },
      ];

      for (const pub of starterPublicAccounts) {
        const ref = doc(collection(db, 'public_accounts'));
        batch.set(ref, {
          ownerId: uid,
          ...pub,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'workspace_seed');
  }
}
