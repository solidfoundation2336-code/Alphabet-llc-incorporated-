import {
  ASSET_CLASS_META,
  type AssetCategoryGroup,
  type AssetClass,
  type CurrencyCode,
  type DocumentCategory,
  type ExtractionEngine,
} from '../types/finance';

export interface StagedAssetCandidate {
  tempId: string;
  included: boolean;
  assetName: string;
  tickerOrIdentifier: string;
  assetClass: AssetClass;
  assetCategoryGroup: AssetCategoryGroup;
  quantity: number;
  unitCostBasis: number;
  totalMarketValue: number;
  currency: CurrencyCode;
  valuationDate: string;
  jurisdiction: string;
  regulatoryClassification: string;
  accountId: string;
  firmId: string;
  confidenceNote: string;
  sourceExcerpt: string;
}

export interface DocumentExtractionResult {
  documentCategory: DocumentCategory;
  extractionEngine: ExtractionEngine;
  summaryNotes: string;
  rawDocumentText: string;
  assets: StagedAssetCandidate[];
}

export const SAMPLE_ASSETS_CSV = `assetName,tickerOrIdentifier,assetClass,quantity,unitCostBasis,totalMarketValue,currency,valuationDate,jurisdiction,regulatoryClassification
Vanguard S&P 500 ETF,VOO,etf_fund,420,442.50,214200.00,USD,2026-11-18,United States · Delaware,Investment Company Act 1940
US Treasury 10Y Note (4.25%),US912828ZT0,fixed_income,150,985.00,148650.00,USD,2026-11-18,United States · Federal,TRACE / MSRB Fixed Income
Sequoia Growth Fund IX LP,SEQ-PE-IX,private_equity,1,250000.00,287500.00,USD,2026-11-15,United States · Cayman LP,SEC Reg D 506(c) Accredited
Hudson Yards Suite 14B Commercial,NYC-BL1077-L14,commercial_real_estate,1,920000.00,985000.00,USD,2026-11-10,United States · New York,Deed / ALTA Title Custody`;

export const SAMPLE_STATEMENT_JSON = JSON.stringify(
  {
    statementPeriod: '2026-11',
    documentCategory: 'brokerage_statement',
    summaryNotes: 'Institutional multi-asset custody schedule exported from custodian ledger.',
    holdings: [
      {
        assetName: 'Microsoft Corporation Common',
        tickerOrIdentifier: 'MSFT',
        assetClass: 'public_equity',
        quantity: 650,
        unitCostBasis: 368.4,
        totalMarketValue: 278200.0,
        currency: 'USD',
        valuationDate: '2026-11-18',
        jurisdiction: 'United States · Washington',
        regulatoryClassification: 'SEC Reg NMS / DTC Eligible',
      },
      {
        assetName: 'Allocated London Good Delivery Gold',
        tickerOrIdentifier: 'XAU-LGD-402',
        assetClass: 'commodity',
        quantity: 45,
        unitCostBasis: 2380.0,
        totalMarketValue: 118350.0,
        currency: 'USD',
        valuationDate: '2026-11-18',
        jurisdiction: 'United Kingdom · London',
        regulatoryClassification: 'LBMA Allocated Bullion Vault',
      },
      {
        assetName: 'Prologis Industrial REIT',
        tickerOrIdentifier: 'PLD',
        assetClass: 'reit',
        quantity: 900,
        unitCostBasis: 118.2,
        totalMarketValue: 112500.0,
        currency: 'USD',
        valuationDate: '2026-11-18',
        jurisdiction: 'United States · Maryland',
        regulatoryClassification: 'SEC Form 1099-DIV / REIT',
      },
    ],
  },
  null,
  2,
);

const VALID_ASSET_CLASSES = Object.keys(ASSET_CLASS_META) as AssetClass[];

export function normalizeAssetClass(raw: unknown): AssetClass {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (VALID_ASSET_CLASSES.includes(value as AssetClass)) {
    return value as AssetClass;
  }
  if (value.includes('etf') || value.includes('mutual') || value.includes('index_fund')) {
    return 'etf_fund';
  }
  if (value.includes('bond') || value.includes('treasury') || value.includes('fixed') || value.includes('note')) {
    return 'fixed_income';
  }
  if (value.includes('private') || value.includes('buyout') || value.includes('lp')) {
    return 'private_equity';
  }
  if (value.includes('venture') || value.includes('vc') || value.includes('seed')) {
    return 'venture_fund';
  }
  if (value.includes('gold') || value.includes('silver') || value.includes('commodity') || value.includes('bullion')) {
    return 'commodity';
  }
  if (value.includes('commercial') || value.includes('office') || value.includes('warehouse')) {
    return 'commercial_real_estate';
  }
  if (value.includes('residential') || value.includes('home') || value.includes('condo') || value.includes('multifamily')) {
    return 'residential_real_estate';
  }
  if (value.includes('reit')) {
    return 'reit';
  }
  return 'public_equity';
}

export function normalizeCurrency(raw: unknown): CurrencyCode {
  const c = String(raw || 'USD').trim().toUpperCase();
  if (c === 'EUR' || c === 'GBP') return c;
  return 'USD';
}

export function normalizeDate(raw: unknown): string {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  return '2026-11-18';
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function makeTempId(idx: number): string {
  return `stg_${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
}

function toSafeCandidate(
  raw: Record<string, unknown>,
  idx: number,
  defaultAccountId: string,
  defaultFirmId: string,
  confidenceNote: string,
  sourceExcerpt: string,
): StagedAssetCandidate {
  const assetClass = normalizeAssetClass(raw.assetClass ?? raw.class ?? raw.type ?? raw.category);
  const meta = ASSET_CLASS_META[assetClass];
  const rawName = String(raw.assetName ?? raw.name ?? raw.security ?? raw.description ?? `Onboarded Asset ${idx + 1}`).trim();
  const rawId = String(raw.tickerOrIdentifier ?? raw.ticker ?? raw.symbol ?? raw.cusip ?? raw.parcelId ?? `AST-${idx + 101}`).trim();
  const parsedQty = Number.parseFloat(String(raw.quantity ?? raw.units ?? raw.shares ?? '1').replace(/[$,]/g, ''));
  const quantity = Number.isFinite(parsedQty) && parsedQty > 0 ? Math.round(parsedQty * 10000) / 10000 : 1;

  const parsedCost = Number.parseFloat(String(raw.unitCostBasis ?? raw.costBasis ?? raw.unitPrice ?? raw.price ?? '0').replace(/[$,]/g, ''));
  const parsedValue = Number.parseFloat(String(raw.totalMarketValue ?? raw.marketValue ?? raw.value ?? raw.amount ?? '0').replace(/[$,]/g, ''));

  const unitCostBasis = Number.isFinite(parsedCost) && parsedCost >= 0 ? Math.round(parsedCost * 100) / 100 : 0;
  const totalMarketValue =
    Number.isFinite(parsedValue) && parsedValue >= 0
      ? Math.round(parsedValue * 100) / 100
      : Math.round(quantity * unitCostBasis * 100) / 100;

  return {
    tempId: makeTempId(idx),
    included: true,
    assetName: rawName.slice(0, 140) || `Onboarded Asset ${idx + 1}`,
    tickerOrIdentifier: rawId.slice(0, 48) || `AST-${idx + 101}`,
    assetClass,
    assetCategoryGroup: meta.group,
    quantity,
    unitCostBasis,
    totalMarketValue,
    currency: normalizeCurrency(raw.currency),
    valuationDate: normalizeDate(raw.valuationDate ?? raw.date),
    jurisdiction: String(raw.jurisdiction ?? 'United States').trim().slice(0, 80) || 'United States',
    regulatoryClassification:
      String(raw.regulatoryClassification ?? meta.defaultRegClass).trim().slice(0, 80) || meta.defaultRegClass,
    accountId: defaultAccountId,
    firmId: defaultFirmId,
    confidenceNote,
    sourceExcerpt: sourceExcerpt.slice(0, 780),
  };
}

export function parseCsvAssets(
  csvText: string,
  defaultAccountId: string,
  defaultFirmId: string,
): DocumentExtractionResult {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new Error('CSV file must include a header row and at least one asset row.');
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const candidates: StagedAssetCandidate[] = [];

  for (let i = 1; i < lines.length && candidates.length < 200; i += 1) {
    const cols = splitCsvLine(lines[i]);
    if (cols.every((c) => !c)) continue;
    const rowObj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      rowObj[h] = cols[idx] ?? '';
    });

    const mapped: Record<string, unknown> = {
      assetName: rowObj.assetname || rowObj.name || rowObj.security || rowObj.holding || rowObj.property,
      tickerOrIdentifier:
        rowObj.tickeroridentifier || rowObj.ticker || rowObj.symbol || rowObj.cusip || rowObj.isin || rowObj.parcelid || rowObj.id,
      assetClass: rowObj.assetclass || rowObj.class || rowObj.type || rowObj.category,
      quantity: rowObj.quantity || rowObj.shares || rowObj.units || '1',
      unitCostBasis: rowObj.unitcostbasis || rowObj.costbasis || rowObj.unitprice || rowObj.price || '0',
      totalMarketValue: rowObj.totalmarketvalue || rowObj.marketvalue || rowObj.value || rowObj.amount || '0',
      currency: rowObj.currency || 'USD',
      valuationDate: rowObj.valuationdate || rowObj.date || '2026-11-18',
      jurisdiction: rowObj.jurisdiction || 'United States',
      regulatoryClassification: rowObj.regulatoryclassification || rowObj.regulation || '',
    };

    const rowExcerpt = `Row ${i} · ${lines[i]}`;
    candidates.push(
      toSafeCandidate(
        mapped,
        candidates.length,
        defaultAccountId,
        defaultFirmId,
        'Parsed from CSV schedule',
        rowExcerpt,
      ),
    );
  }

  if (candidates.length === 0) {
    throw new Error('No valid asset rows could be extracted from the CSV file.');
  }

  return {
    documentCategory: 'holdings_csv',
    extractionEngine: 'csv_parser',
    summaryNotes: `Structured CSV ingestion parsed ${candidates.length} asset holding${candidates.length === 1 ? '' : 's'}.`,
    rawDocumentText: csvText.trim().slice(0, 7800),
    assets: candidates,
  };
}

export function parseJsonAssets(
  jsonText: string,
  defaultAccountId: string,
  defaultFirmId: string,
): DocumentExtractionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Uploaded JSON file could not be parsed. Verify valid JSON syntax.');
  }

  const root = parsed as Record<string, unknown>;
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root?.holdings)
      ? root.holdings
      : Array.isArray(root?.assets)
        ? root.assets
        : Array.isArray(root?.positions)
          ? root.positions
          : null;

  if (!rawList || rawList.length === 0) {
    throw new Error('JSON must be an array or contain a non-empty holdings, assets, or positions array.');
  }

  const candidates = rawList
    .slice(0, 200)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item, idx) => {
      const plainExcerpt = Object.entries(item)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(' | ');
      return toSafeCandidate(
        item,
        idx,
        defaultAccountId,
        defaultFirmId,
        'Parsed from structured JSON feed',
        plainExcerpt,
      );
    });

  if (candidates.length === 0) {
    throw new Error('No valid asset objects found in the JSON document.');
  }

  const summaryNotes =
    typeof root?.summaryNotes === 'string' && root.summaryNotes.trim()
      ? root.summaryNotes.trim().slice(0, 400)
      : `Structured JSON ingestion parsed ${candidates.length} asset holding${candidates.length === 1 ? '' : 's'}.`;

  return {
    documentCategory: 'holdings_json',
    extractionEngine: 'json_parser',
    summaryNotes,
    rawDocumentText: jsonText.trim().slice(0, 7800),
    assets: candidates,
  };
}
