import type { RecurrenceCadence, TransactionDirection } from '../types/finance';

export interface StagedBatchRow {
  rowId: string;
  occurredAt: string;
  merchant: string;
  description: string;
  amount: number;
  direction: TransactionDirection;
  category: string;
  isRecurring: boolean;
  recurrenceCadence: RecurrenceCadence;
  confidence: 'high' | 'medium' | 'manual';
}

interface RulePattern {
  keywords: string[];
  category: string;
  isRecurring: boolean;
  cadence: RecurrenceCadence;
}

const MERCHANT_RULES: RulePattern[] = [
  {
    keywords: ['aws', 'amazon web services', 'cloudflare', 'google cloud', 'datadog', 'snowflake'],
    category: 'Cloud & Infrastructure',
    isRecurring: true,
    cadence: 'monthly',
  },
  {
    keywords: ['bloomberg', 'dtcc', 'nasdaq', 'refinitiv', 'nyse', 'factset', 'custody'],
    category: 'Market Data & Custody',
    isRecurring: true,
    cadence: 'monthly',
  },
  {
    keywords: ['adp', 'gusto', 'rippling', 'payroll', 'benefit'],
    category: 'Payroll & Benefits',
    isRecurring: true,
    cadence: 'monthly',
  },
  {
    keywords: ['wework', 'equinix', 'regus', 'conedison', 'verizon', 'lease', 'rent'],
    category: 'Office & Facilities',
    isRecurring: true,
    cadence: 'monthly',
  },
  {
    keywords: ['finra', 'sec filing', 'compliance', 'counsel', 'audit', 'legal'],
    category: 'Regulatory & Legal',
    isRecurring: true,
    cadence: 'quarterly',
  },
  {
    keywords: ['figma', 'linear', 'slack', 'notion', 'github', 'okta', '1password'],
    category: 'Software & SaaS',
    isRecurring: true,
    cadence: 'monthly',
  },
  {
    keywords: ['fedwire', 'clearing', 'settlement', 'ach fee', 'wire fee'],
    category: 'Settlement & Clearing',
    isRecurring: false,
    cadence: 'none',
  },
  {
    keywords: ['delta', 'united', 'marriott', 'uber', 'hilton', 'amex travel'],
    category: 'Travel & T&E',
    isRecurring: false,
    cadence: 'none',
  },
  {
    keywords: ['dividend', 'treasury yield', 'coupon', 'interest', 'client retainer', 'stripe payout'],
    category: 'Revenue & Dividends',
    isRecurring: true,
    cadence: 'monthly',
  },
];

export const SAMPLE_BATCH_CSV = `2026-11-16,Bloomberg Terminal,Monthly Institutional Data Seat,2150.00,debit
2026-11-15,Amazon Web Services,Production Cluster & KMS Billing,1480.40,debit
2026-11-14,DTCC Clearing Corp,DTC Participant Monthly Custody Fee,890.00,debit
2026-11-13,ADP Workforce Now,Bi-Weekly Executive Payroll Run,18420.00,debit
2026-11-12,Okta Identity Cloud,MFA Hardware Token & SSO License,420.00,debit
2026-11-11,FINRA CRD Filing,Annual Broker-Dealer Registration Renewal,1250.00,debit
2026-11-10,Equinix NY4 Facility,Colocation Rack Monthly Lease,3400.00,debit
2026-11-09,Delta Air Lines,Client Custody Review Flight,685.50,debit
2026-11-08,Treasury Yield Credit,US T-Bill Monthly Interest Distribution,4620.00,credit`;

export function parseAndClassifyBatch(rawCsv: string): StagedBatchRow[] {
  const lines = rawCsv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const rows: StagedBatchRow[] = [];

  lines.forEach((line, index) => {
    // Skip header row if detected
    if (index === 0 && line.toLowerCase().startsWith('date,')) {
      return;
    }

    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 4) return;

    const occurredAt = /^\d{4}-\d{2}-\d{2}/.test(parts[0])
      ? parts[0].slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const merchant = (parts[1] || 'Unrecognized Counterparty').slice(0, 120);
    const description = (parts[2] || 'Batch feed settlement entry').slice(0, 240);
    const parsedAmount = Math.abs(Number.parseFloat(parts[3].replace(/[^0-9.-]/g, '')));
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return;

    const rawDirection = (parts[4] || 'debit').toLowerCase();
    const direction: TransactionDirection = rawDirection === 'credit' ? 'credit' : 'debit';

    const haystack = `${merchant} ${description}`.toLowerCase();
    const matched = MERCHANT_RULES.find((rule) =>
      rule.keywords.some((kw) => haystack.includes(kw)),
    );

    const isAnnual = haystack.includes('annual');
    const isQuarterly = haystack.includes('quarterly');
    const inferredCadence: RecurrenceCadence = matched
      ? isAnnual
        ? 'annual'
        : isQuarterly
          ? 'quarterly'
          : matched.cadence
      : 'none';

    rows.push({
      rowId: `row_${index + 1}_${Date.now().toString(36)}`,
      occurredAt,
      merchant,
      description,
      amount: Math.round(parsedAmount * 100) / 100,
      direction,
      category: matched
        ? matched.category
        : direction === 'credit'
          ? 'Revenue & Dividends'
          : 'Software & SaaS',
      isRecurring: matched ? matched.isRecurring : false,
      recurrenceCadence: inferredCadence,
      confidence: matched ? 'high' : 'medium',
    });
  });

  return rows;
}
