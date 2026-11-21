import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Code2,
  Columns2,
  Copy,
  Download,
  FileSearch,
  FileText,
  FolderUp,
  KeyRound,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  ASSET_CLASS_META,
  type AssetCategoryGroup,
  type AssetClass,
  type AssetIngestion,
  type BankAccount,
  type BrokerageFirm,
  type CurrencyCode,
  type DocumentCategory,
  type ExtractionEngine,
  type OnboardedAsset,
  type StagedAssetRecord,
  type StagedAssetReviewStatus,
} from '../types/finance';
import {
  normalizeAssetClass,
  normalizeCurrency,
  normalizeDate,
  parseCsvAssets,
  parseJsonAssets,
  SAMPLE_ASSETS_CSV,
  SAMPLE_STATEMENT_JSON,
  type StagedAssetCandidate,
} from '../utils/assetIngestionParser';
import { csvEscape, downloadTextFile, formatCurrency } from '../utils/formatters';
import {
  formatOtpAuthUri,
  generateTotpCode,
  generateTotpSecret,
  getTotpSecondsRemaining,
  verifyTotpCode,
} from '../utils/totp';

interface AssetOnboardingViewProps {
  accounts: BankAccount[];
  firms: BrokerageFirm[];
  assets: OnboardedAsset[];
  ingestions: AssetIngestion[];
  stagedAssets: StagedAssetRecord[];
}

type AssetViewSection = 'staging' | 'ledger' | 'audit';
type StagingRowFilter = 'all' | 'pending_review' | 'verified' | 'flagged';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
    reader.readAsText(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Unable to encode ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function engineLabel(engine: ExtractionEngine): string {
  if (engine === 'gemini_multimodal') return 'Gemini Multimodal AI';
  if (engine === 'csv_parser') return 'CSV Schedule Parser';
  if (engine === 'json_parser') return 'JSON Feed Parser';
  return 'Manual Entry';
}

export function AssetOnboardingView({
  accounts,
  firms,
  assets,
  ingestions,
  stagedAssets,
}: AssetOnboardingViewProps) {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Active workspace section
  const [activeSection, setActiveSection] = useState<AssetViewSection>('staging');
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');
  const [stagingFilter, setStagingFilter] = useState<StagingRowFilter>('all');
  const [stagingSearch, setStagingSearch] = useState('');

  // Ledger filters
  const [searchQuery, setSearchQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<'all' | AssetCategoryGroup>('all');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'pending_verification' | 'custodied' | 'archived'
  >('all');

  // Upload & Staging Queue state
  const [dragActive, setDragActive] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractionStatusText, setExtractionStatusText] = useState('');
  const [ingestionError, setIngestionError] = useState<string | null>(null);
  const [ingestionNotice, setIngestionNotice] = useState<string | null>(null);
  const [committingBatch, setCommittingBatch] = useState(false);
  const [updatingStagedId, setUpdatingStagedId] = useState<string | null>(null);

  // Local buffered inline edits for staged rows before blur-commit
  const [inlineDrafts, setInlineDrafts] = useState<
    Record<
      string,
      {
        assetName?: string;
        tickerOrIdentifier?: string;
        quantity?: string;
        totalMarketValue?: string;
      }
    >
  >({});

  // Dedicated Side-by-Side Staging Review Modal
  const [inspectTargetId, setInspectTargetId] = useState<string | null>(null);
  const [inspName, setInspName] = useState('');
  const [inspIdentifier, setInspIdentifier] = useState('');
  const [inspClass, setInspClass] = useState<AssetClass>('public_equity');
  const [inspQty, setInspQty] = useState('1');
  const [inspCostBasis, setInspCostBasis] = useState('0');
  const [inspMarketValue, setInspMarketValue] = useState('0');
  const [inspCurrency, setInspCurrency] = useState<CurrencyCode>('USD');
  const [inspDate, setInspDate] = useState('2026-11-18');
  const [inspJurisdiction, setInspJurisdiction] = useState('United States');
  const [inspRegClass, setInspRegClass] = useState('');
  const [inspAccountId, setInspAccountId] = useState('');
  const [inspFirmId, setInspFirmId] = useState('');
  const [inspNameVerified, setInspNameVerified] = useState(false);
  const [inspIdVerified, setInspIdVerified] = useState(false);
  const [inspValVerified, setInspValVerified] = useState(false);
  const [inspFlagged, setInspFlagged] = useState(false);
  const [inspNotes, setInspNotes] = useState('');
  const [inspError, setInspError] = useState<string | null>(null);
  const [inspFeedback, setInspFeedback] = useState<string | null>(null);
  const [savingInspect, setSavingInspect] = useState(false);
  const [copiedModalPayload, setCopiedModalPayload] = useState<'raw' | 'json' | null>(null);

  // Manual Onboard / Edit Asset modal
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<OnboardedAsset | null>(null);
  const [assetName, setAssetName] = useState('');
  const [tickerOrId, setTickerOrId] = useState('');
  const [assetClass, setAssetClass] = useState<AssetClass>('public_equity');
  const [quantity, setQuantity] = useState('100');
  const [unitCostBasis, setUnitCostBasis] = useState('125.00');
  const [totalMarketValue, setTotalMarketValue] = useState('13500.00');
  const [currency, setCurrency] = useState<CurrencyCode>('USD');
  const [valuationDate, setValuationDate] = useState('2026-11-18');
  const [jurisdiction, setJurisdiction] = useState('United States · Delaware');
  const [regClassification, setRegClassification] = useState(
    ASSET_CLASS_META.public_equity.defaultRegClass,
  );
  const [linkedAccountId, setLinkedAccountId] = useState(accounts[0]?.id || '');
  const [linkedFirmId, setLinkedFirmId] = useState(firms[0]?.id || '');
  const [savingAsset, setSavingAsset] = useState(false);
  const [assetFormError, setAssetFormError] = useState<string | null>(null);

  // Per-Action TOTP MFA Custody Verification modal
  const [mfaTargetAsset, setMfaTargetAsset] = useState<OnboardedAsset | null>(null);
  const [totpSecret, setTotpSecret] = useState(() => generateTotpSecret());
  const [liveCode, setLiveCode] = useState('------');
  const [secondsLeft, setSecondsLeft] = useState(getTotpSecondsRemaining());
  const [enteredMfaCode, setEnteredMfaCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [verifyingMfa, setVerifyingMfa] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  useEffect(() => {
    if (!mfaTargetAsset) return;
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
  }, [mfaTargetAsset, totpSecret]);

  const accountLookup = useMemo(() => {
    const map = new Map<string, BankAccount>();
    accounts.forEach((a) => map.set(a.id, a));
    return map;
  }, [accounts]);

  const firmLookup = useMemo(() => {
    const map = new Map<string, BrokerageFirm>();
    firms.forEach((f) => map.set(f.id, f));
    return map;
  }, [firms]);

  const activeAssets = useMemo(
    () => assets.filter((a) => a.custodyStatus !== 'archived'),
    [assets],
  );

  // Active Staging Review items (not yet committed or rejected)
  const openStagingRows = useMemo(
    () =>
      stagedAssets.filter(
        (s) =>
          s.reviewStatus === 'pending_review' ||
          s.reviewStatus === 'verified' ||
          s.reviewStatus === 'flagged',
      ),
    [stagedAssets],
  );

  const stagedBatches = useMemo(() => {
    const activeBatchIds = new Set(openStagingRows.map((r) => r.ingestionId));
    return ingestions.filter(
      (ing) => ing.status === 'staged' || activeBatchIds.has(ing.id),
    );
  }, [ingestions, openStagingRows]);

  useEffect(() => {
    if (stagedBatches.length === 0) {
      if (selectedBatchId) setSelectedBatchId('');
      return;
    }
    if (!selectedBatchId || !stagedBatches.some((b) => b.id === selectedBatchId)) {
      setSelectedBatchId(stagedBatches[0].id);
    }
  }, [stagedBatches, selectedBatchId]);

  const activeBatch = useMemo(
    () => stagedBatches.find((b) => b.id === selectedBatchId) || null,
    [stagedBatches, selectedBatchId],
  );

  const activeBatchRows = useMemo(
    () =>
      openStagingRows.filter((row) =>
        activeBatch ? row.ingestionId === activeBatch.id : false,
      ),
    [openStagingRows, activeBatch],
  );

  const activeBatchStats = useMemo(() => {
    let verifiedCount = 0;
    let pendingCount = 0;
    let flaggedCount = 0;
    let verifiedValue = 0;
    let totalValue = 0;

    activeBatchRows.forEach((r) => {
      totalValue += r.totalMarketValue;
      if (r.reviewStatus === 'verified') {
        verifiedCount += 1;
        verifiedValue += r.totalMarketValue;
      } else if (r.reviewStatus === 'flagged') {
        flaggedCount += 1;
      } else {
        pendingCount += 1;
      }
    });

    return {
      totalCount: activeBatchRows.length,
      verifiedCount,
      pendingCount,
      flaggedCount,
      verifiedValue,
      totalValue,
    };
  }, [activeBatchRows]);

  const filteredStagingRows = useMemo(() => {
    const q = stagingSearch.trim().toLowerCase();
    return activeBatchRows.filter((r) => {
      if (stagingFilter !== 'all' && r.reviewStatus !== stagingFilter) return false;
      if (q) {
        const hay = `${r.assetName} ${r.tickerOrIdentifier} ${r.confidenceNote} ${r.reviewerNotes} ${r.jurisdiction}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [activeBatchRows, stagingFilter, stagingSearch]);

  const summary = useMemo(() => {
    let totalValue = 0;
    let publicSecuritiesValue = 0;
    let alternativesAndRealEstateValue = 0;
    let custodiedCount = 0;
    let pendingMfaCount = 0;

    activeAssets.forEach((a) => {
      totalValue += a.totalMarketValue;
      if (a.assetCategoryGroup === 'public_securities') {
        publicSecuritiesValue += a.totalMarketValue;
      } else {
        alternativesAndRealEstateValue += a.totalMarketValue;
      }
      if (a.custodyStatus === 'custodied') custodiedCount += 1;
      if (a.custodyStatus === 'pending_verification') pendingMfaCount += 1;
    });

    const publicSharePct =
      totalValue > 0 ? Math.round((publicSecuritiesValue / totalValue) * 100) : 0;

    const stagedVerifiedReady = openStagingRows.filter(
      (r) => r.reviewStatus === 'verified',
    ).length;

    return {
      totalValue,
      publicSecuritiesValue,
      alternativesAndRealEstateValue,
      publicSharePct,
      custodiedCount,
      pendingMfaCount,
      stagedTotal: openStagingRows.length,
      stagedVerifiedReady,
      stagedBatchesCount: stagedBatches.length,
    };
  }, [activeAssets, openStagingRows, stagedBatches]);

  const filteredAssets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return assets.filter((a) => {
      if (groupFilter !== 'all' && a.assetCategoryGroup !== groupFilter) return false;
      if (statusFilter !== 'all' && a.custodyStatus !== statusFilter) return false;
      if (q) {
        const hay = `${a.assetName} ${a.tickerOrIdentifier} ${a.jurisdiction} ${a.regulatoryClassification}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [assets, groupFilter, statusFilter, searchQuery]);

  const inspectTarget = useMemo(
    () => (inspectTargetId ? openStagingRows.find((r) => r.id === inspectTargetId) || null : null),
    [openStagingRows, inspectTargetId],
  );

  const inspectBatch = useMemo(() => {
    if (!inspectTarget) return activeBatch;
    return ingestions.find((ing) => ing.id === inspectTarget.ingestionId) || activeBatch;
  }, [inspectTarget, ingestions, activeBatch]);

  const inspectBatchRows = useMemo(() => {
    if (!inspectTarget) return activeBatchRows;
    return openStagingRows.filter((r) => r.ingestionId === inspectTarget.ingestionId);
  }, [inspectTarget, openStagingRows, activeBatchRows]);

  const inspectBatchStats = useMemo(() => {
    const verifiedRows = inspectBatchRows.filter(
      (r) => r.reviewStatus === 'verified' && r.nameVerified && r.identifierVerified && r.valuationVerified,
    );
    return {
      totalCount: inspectBatchRows.length,
      verifiedCount: verifiedRows.length,
      verifiedValue: verifiedRows.reduce((sum, r) => sum + r.totalMarketValue, 0),
    };
  }, [inspectBatchRows]);

  // Persist newly extracted document + candidates directly to Firestore Staging Review queue
  const persistToStagingQueue = async (params: {
    fileName: string;
    mimeType: string;
    fileSizeBytes: number;
    documentCategory: DocumentCategory;
    extractionEngine: ExtractionEngine;
    summaryNotes: string;
    rawDocumentText?: string;
    candidates: StagedAssetCandidate[];
  }) => {
    if (!user) return;
    const batch = writeBatch(db);
    const ingestionRef = doc(collection(db, 'asset_ingestions'));
    const safeCandidates = params.candidates.slice(0, 200);
    const totalExtractedValue =
      Math.round(safeCandidates.reduce((sum, c) => sum + c.totalMarketValue, 0) * 100) / 100;
    const safeRawDocText = (params.rawDocumentText || '').trim().slice(0, 7800);

    batch.set(ingestionRef, {
      ownerId: user.uid,
      fileName: params.fileName.slice(0, 160),
      mimeType: params.mimeType.slice(0, 120),
      fileSizeBytes: Math.max(1, Math.round(params.fileSizeBytes)),
      documentCategory: params.documentCategory,
      extractionEngine: params.extractionEngine,
      extractedCount: safeCandidates.length,
      totalExtractedValue,
      status: 'staged',
      summaryNotes:
        (params.summaryNotes.trim() || `Queued ${safeCandidates.length} holdings for staging review.`).slice(0, 400),
      rawDocumentText: safeRawDocText,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    safeCandidates.forEach((item) => {
      const stagedRef = doc(collection(db, 'staged_assets'));
      const meta = ASSET_CLASS_META[item.assetClass];
      const safeName = item.assetName.trim().slice(0, 140);
      const safeId = item.tickerOrIdentifier.trim().slice(0, 48) || 'AST-PENDING';
      const safeJur = item.jurisdiction.trim().slice(0, 80);
      const safeReg = item.regulatoryClassification.trim().slice(0, 80);

      batch.set(stagedRef, {
        ownerId: user.uid,
        ingestionId: ingestionRef.id,
        fileName: params.fileName.slice(0, 160),
        extractionEngine: params.extractionEngine,
        assetName: safeName.length >= 2 ? safeName : 'Extracted Asset Holding',
        tickerOrIdentifier: safeId,
        assetCategoryGroup: meta.group,
        assetClass: item.assetClass,
        quantity: item.quantity > 0 ? Math.round(item.quantity * 10000) / 10000 : 1,
        unitCostBasis: Math.round(Math.max(0, item.unitCostBasis) * 100) / 100,
        totalMarketValue: Math.round(Math.max(0, item.totalMarketValue) * 100) / 100,
        currency: item.currency,
        valuationDate: normalizeDate(item.valuationDate),
        jurisdiction: safeJur.length >= 2 ? safeJur : 'United States',
        regulatoryClassification: safeReg.length >= 2 ? safeReg : meta.defaultRegClass,
        accountId: item.accountId || '',
        firmId: item.firmId || '',
        confidenceNote:
          (item.confidenceNote || `Extracted via ${engineLabel(params.extractionEngine)}`).slice(0, 200),
        sourceExcerpt: (item.sourceExcerpt || '').trim().slice(0, 780),
        nameVerified: false,
        identifierVerified: false,
        valuationVerified: false,
        reviewStatus: 'pending_review',
        reviewerNotes: '',
        committedAssetId: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'staged_assets');
    }
    setSelectedBatchId(ingestionRef.id);
    setActiveSection('staging');
    setStagingFilter('all');
    setIngestionNotice(
      `Queued ${safeCandidates.length} extracted item${safeCandidates.length === 1 ? '' : 's'} from ${params.fileName} into Staging Review.`,
    );
  };

  const processDocumentFile = async (file: File) => {
    setIngestionError(null);
    setIngestionNotice(null);
    if (file.size <= 0) {
      setIngestionError('Uploaded file is empty.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setIngestionError(`File exceeds the 8 MB upload cap (${formatBytes(file.size)}).`);
      return;
    }

    const lowerName = file.name.toLowerCase();
    const defaultAccountId = accounts[0]?.id || '';
    const defaultFirmId = firms[0]?.id || '';

    try {
      if (lowerName.endsWith('.csv') || file.type === 'text/csv') {
        setExtracting(true);
        setExtractionStatusText(`Parsing CSV schedule (${file.name}) into Staging Review...`);
        const text = await readFileAsText(file);
        const parsed = parseCsvAssets(text, defaultAccountId, defaultFirmId);
        await persistToStagingQueue({
          fileName: file.name,
          mimeType: file.type || 'text/csv',
          fileSizeBytes: file.size,
          documentCategory: parsed.documentCategory,
          extractionEngine: parsed.extractionEngine,
          summaryNotes: parsed.summaryNotes,
          rawDocumentText: parsed.rawDocumentText,
          candidates: parsed.assets,
        });
        return;
      }

      if (lowerName.endsWith('.json') || file.type === 'application/json') {
        setExtracting(true);
        setExtractionStatusText(`Parsing JSON custody feed (${file.name}) into Staging Review...`);
        const text = await readFileAsText(file);
        const parsed = parseJsonAssets(text, defaultAccountId, defaultFirmId);
        await persistToStagingQueue({
          fileName: file.name,
          mimeType: file.type || 'application/json',
          fileSizeBytes: file.size,
          documentCategory: parsed.documentCategory,
          extractionEngine: parsed.extractionEngine,
          summaryNotes: parsed.summaryNotes,
          rawDocumentText: parsed.rawDocumentText,
          candidates: parsed.assets,
        });
        return;
      }

      const isPdf = lowerName.endsWith('.pdf') || file.type === 'application/pdf';
      const isImage =
        file.type.startsWith('image/') ||
        /\.(png|jpe?g|webp)$/i.test(lowerName);
      const isText = lowerName.endsWith('.txt') || file.type === 'text/plain';

      if (!isPdf && !isImage && !isText) {
        setIngestionError(
          'Unsupported document format. Upload a PDF, PNG, JPEG, WEBP, CSV, JSON, or TXT statement.',
        );
        return;
      }

      setExtracting(true);
      setExtractionStatusText(
        `Extracting asset holdings from ${file.name} via Gemini AI multimodal ingestion...`,
      );

      const mimeType =
        file.type ||
        (isPdf
          ? 'application/pdf'
          : lowerName.endsWith('.png')
            ? 'image/png'
            : lowerName.endsWith('.webp')
              ? 'image/webp'
              : isText
                ? 'text/plain'
                : 'image/jpeg');

      const rawUploadedText = isText ? await readFileAsText(file) : '';
      const body = isText
        ? {
            fileName: file.name,
            mimeType,
            textContent: rawUploadedText,
          }
        : {
            fileName: file.name,
            mimeType,
            base64Data: await readFileAsBase64(file),
          };

      const res = await fetch('/api/assets/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const payload = (await res.json()) as {
        error?: string;
        documentCategory?: string;
        summaryNotes?: string;
        rawDocumentExcerpt?: string;
        assets?: Record<string, unknown>[];
      };

      if (!res.ok || !Array.isArray(payload.assets)) {
        throw new Error(payload.error || 'Gemini document extraction failed.');
      }

      const validCategories: DocumentCategory[] = [
        'brokerage_statement',
        'closing_disclosure',
        'subscription_agreement',
        'holdings_csv',
        'holdings_json',
        'other_document',
      ];
      const docCat = validCategories.includes(payload.documentCategory as DocumentCategory)
        ? (payload.documentCategory as DocumentCategory)
        : 'other_document';

      const mapped: StagedAssetCandidate[] = payload.assets.slice(0, 200).map((raw, idx) => {
        const cls = normalizeAssetClass(raw.assetClass);
        const meta = ASSET_CLASS_META[cls];
        const qty = Number(raw.quantity) > 0 ? Math.round(Number(raw.quantity) * 10000) / 10000 : 1;
        const cost = Number(raw.unitCostBasis) >= 0 ? Math.round(Number(raw.unitCostBasis) * 100) / 100 : 0;
        const mkt =
          Number(raw.totalMarketValue) >= 0
            ? Math.round(Number(raw.totalMarketValue) * 100) / 100
            : Math.round(qty * cost * 100) / 100;
        return {
          tempId: `gem_${Date.now().toString(36)}_${idx}`,
          included: true,
          assetName: String(raw.assetName || `Extracted Asset ${idx + 1}`).trim().slice(0, 140),
          tickerOrIdentifier: String(raw.tickerOrIdentifier || `AST-${idx + 1}`).trim().slice(0, 48),
          assetClass: cls,
          assetCategoryGroup: meta.group,
          quantity: qty,
          unitCostBasis: cost,
          totalMarketValue: mkt,
          currency: normalizeCurrency(raw.currency),
          valuationDate: normalizeDate(raw.valuationDate),
          jurisdiction: String(raw.jurisdiction || 'United States').trim().slice(0, 80) || 'United States',
          regulatoryClassification:
            String(raw.regulatoryClassification || meta.defaultRegClass).trim().slice(0, 80) ||
            meta.defaultRegClass,
          accountId: defaultAccountId,
          firmId: defaultFirmId,
          confidenceNote: String(raw.confidenceNote || 'Extracted via Gemini multimodal').slice(0, 200),
          sourceExcerpt: String(raw.rawTextSnippet || '').trim().slice(0, 780),
        };
      });

      await persistToStagingQueue({
        fileName: file.name,
        mimeType,
        fileSizeBytes: file.size,
        documentCategory: docCat,
        extractionEngine: 'gemini_multimodal',
        summaryNotes:
          payload.summaryNotes || `Extracted ${mapped.length} holdings via Gemini AI.`,
        rawDocumentText:
          payload.rawDocumentExcerpt || rawUploadedText || '',
        candidates: mapped,
      });
    } catch (error) {
      setIngestionError(
        error instanceof Error ? error.message : 'Unable to process uploaded document.',
      );
    } finally {
      setExtracting(false);
      setExtractionStatusText('');
    }
  };

  const handleLoadSampleCsv = async () => {
    setIngestionError(null);
    setIngestionNotice(null);
    setExtracting(true);
    setExtractionStatusText('Staging sample multi-asset CSV schedule...');
    try {
      const parsed = parseCsvAssets(SAMPLE_ASSETS_CSV, accounts[0]?.id || '', firms[0]?.id || '');
      await persistToStagingQueue({
        fileName: 'sample-multi-asset-schedule.csv',
        mimeType: 'text/csv',
        fileSizeBytes: SAMPLE_ASSETS_CSV.length,
        documentCategory: parsed.documentCategory,
        extractionEngine: parsed.extractionEngine,
        summaryNotes: parsed.summaryNotes,
        rawDocumentText: parsed.rawDocumentText,
        candidates: parsed.assets,
      });
    } catch (error) {
      setIngestionError(error instanceof Error ? error.message : 'Unable to stage sample CSV.');
    } finally {
      setExtracting(false);
      setExtractionStatusText('');
    }
  };

  const handleLoadSampleJson = async () => {
    setIngestionError(null);
    setIngestionNotice(null);
    setExtracting(true);
    setExtractionStatusText('Staging sample custody JSON feed...');
    try {
      const parsed = parseJsonAssets(
        SAMPLE_STATEMENT_JSON,
        accounts[0]?.id || '',
        firms[0]?.id || '',
      );
      await persistToStagingQueue({
        fileName: 'sample-custody-statement.json',
        mimeType: 'application/json',
        fileSizeBytes: SAMPLE_STATEMENT_JSON.length,
        documentCategory: parsed.documentCategory,
        extractionEngine: parsed.extractionEngine,
        summaryNotes: parsed.summaryNotes,
        rawDocumentText: parsed.rawDocumentText,
        candidates: parsed.assets,
      });
    } catch (error) {
      setIngestionError(error instanceof Error ? error.message : 'Unable to stage sample JSON.');
    } finally {
      setExtracting(false);
      setExtractionStatusText('');
    }
  };

  const computeNextReviewStatus = (
    currentStatus: StagedAssetReviewStatus,
    nameVerified: boolean,
    identifierVerified: boolean,
    valuationVerified: boolean,
  ): StagedAssetReviewStatus => {
    if (currentStatus === 'flagged') return 'flagged';
    if (nameVerified && identifierVerified && valuationVerified) return 'verified';
    return 'pending_review';
  };

  const updateStagedRecord = async (
    row: StagedAssetRecord,
    patch: Partial<{
      assetName: string;
      tickerOrIdentifier: string;
      assetClass: AssetClass;
      quantity: number;
      unitCostBasis: number;
      totalMarketValue: number;
      currency: CurrencyCode;
      valuationDate: string;
      jurisdiction: string;
      regulatoryClassification: string;
      accountId: string;
      firmId: string;
      nameVerified: boolean;
      identifierVerified: boolean;
      valuationVerified: boolean;
      reviewStatus: StagedAssetReviewStatus;
      reviewerNotes: string;
    }>,
  ) => {
    setIngestionError(null);
    const nextName = (patch.assetName ?? row.assetName).trim().slice(0, 140);
    const nextId = (patch.tickerOrIdentifier ?? row.tickerOrIdentifier).trim().slice(0, 48);
    const nextQty = patch.quantity ?? row.quantity;
    const nextCost = patch.unitCostBasis ?? row.unitCostBasis;
    const nextVal = patch.totalMarketValue ?? row.totalMarketValue;
    const nextClass = patch.assetClass ?? row.assetClass;
    const nextGroup = ASSET_CLASS_META[nextClass].group;
    const nextJur = (patch.jurisdiction ?? row.jurisdiction).trim().slice(0, 80);
    const nextReg = (patch.regulatoryClassification ?? row.regulatoryClassification)
      .trim()
      .slice(0, 80);

    if (nextName.length < 2) {
      setIngestionError('Asset name must be at least 2 characters.');
      return;
    }
    if (nextId.length < 1) {
      setIngestionError('Ticker or identifier cannot be empty.');
      return;
    }
    if (!Number.isFinite(nextQty) || nextQty <= 0) {
      setIngestionError(`Quantity for ${nextName} must be greater than zero.`);
      return;
    }
    if (!Number.isFinite(nextCost) || nextCost < 0 || !Number.isFinite(nextVal) || nextVal < 0) {
      setIngestionError(`Cost basis and market value for ${nextName} must be non-negative.`);
      return;
    }

    const nextNameVer = patch.nameVerified ?? row.nameVerified;
    const nextIdVer = patch.identifierVerified ?? row.identifierVerified;
    const nextValVer = patch.valuationVerified ?? row.valuationVerified;
    const nextStatus =
      patch.reviewStatus ??
      computeNextReviewStatus(row.reviewStatus, nextNameVer, nextIdVer, nextValVer);

    const safeStatus: StagedAssetReviewStatus =
      nextStatus === 'verified' && !(nextNameVer && nextIdVer && nextValVer)
        ? 'pending_review'
        : nextStatus;

    setUpdatingStagedId(row.id);
    try {
      await updateDoc(doc(db, 'staged_assets', row.id), {
        assetName: nextName,
        tickerOrIdentifier: nextId,
        assetCategoryGroup: nextGroup,
        assetClass: nextClass,
        quantity: Math.round(nextQty * 10000) / 10000,
        unitCostBasis: Math.round(nextCost * 100) / 100,
        totalMarketValue: Math.round(nextVal * 100) / 100,
        currency: patch.currency ?? row.currency,
        valuationDate: normalizeDate(patch.valuationDate ?? row.valuationDate),
        jurisdiction: nextJur.length >= 2 ? nextJur : 'United States',
        regulatoryClassification:
          nextReg.length >= 2 ? nextReg : ASSET_CLASS_META[nextClass].defaultRegClass,
        accountId: patch.accountId ?? row.accountId,
        firmId: patch.firmId ?? row.firmId,
        nameVerified: nextNameVer,
        identifierVerified: nextIdVer,
        valuationVerified: nextValVer,
        reviewStatus: safeStatus,
        reviewerNotes: (patch.reviewerNotes ?? row.reviewerNotes).slice(0, 240),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `staged_assets/${row.id}`);
    } finally {
      setUpdatingStagedId(null);
    }
  };

  const commitInlineDraft = async (row: StagedAssetRecord) => {
    const draft = inlineDrafts[row.id];
    if (!draft) return;

    const nextName = (draft.assetName ?? row.assetName).trim();
    const nextTicker = (draft.tickerOrIdentifier ?? row.tickerOrIdentifier).trim();
    const nextQty =
      draft.quantity !== undefined ? Number.parseFloat(draft.quantity) : row.quantity;
    const nextVal =
      draft.totalMarketValue !== undefined
        ? Number.parseFloat(draft.totalMarketValue)
        : row.totalMarketValue;

    setInlineDrafts((prev) => {
      const copy = { ...prev };
      delete copy[row.id];
      return copy;
    });

    const changedName = nextName !== row.assetName;
    const changedId = nextTicker !== row.tickerOrIdentifier;
    const changedVal =
      Math.abs(nextQty - row.quantity) > 0.00001 ||
      Math.abs(nextVal - row.totalMarketValue) > 0.001;

    if (!changedName && !changedId && !changedVal) return;

    await updateStagedRecord(row, {
      assetName: nextName,
      tickerOrIdentifier: nextTicker,
      quantity: Number.isFinite(nextQty) && nextQty > 0 ? nextQty : row.quantity,
      totalMarketValue: Number.isFinite(nextVal) && nextVal >= 0 ? nextVal : row.totalMarketValue,
      nameVerified: changedName ? false : row.nameVerified,
      identifierVerified: changedId ? false : row.identifierVerified,
      valuationVerified: changedVal ? false : row.valuationVerified,
    });
  };

  const handleBulkVerifyAll = async () => {
    if (!user || activeBatchRows.length === 0) return;
    setIngestionError(null);
    setCommittingBatch(true);
    try {
      const batch = writeBatch(db);
      activeBatchRows.forEach((row) => {
        if (row.reviewStatus === 'flagged') return;
        batch.update(doc(db, 'staged_assets', row.id), {
          nameVerified: true,
          identifierVerified: true,
          valuationVerified: true,
          reviewStatus: 'verified',
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
      setIngestionNotice('Marked all unflagged rows in this batch as field-verified.');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'staged_assets');
    } finally {
      setCommittingBatch(false);
    }
  };

  const handleBulkAssignAccount = async (accountId: string) => {
    if (!user || activeBatchRows.length === 0) return;
    setCommittingBatch(true);
    try {
      const batch = writeBatch(db);
      activeBatchRows.forEach((row) => {
        batch.update(doc(db, 'staged_assets', row.id), {
          accountId,
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'staged_assets');
    } finally {
      setCommittingBatch(false);
    }
  };

  const handleBulkAssignFirm = async (firmId: string) => {
    if (!user || activeBatchRows.length === 0) return;
    setCommittingBatch(true);
    try {
      const batch = writeBatch(db);
      activeBatchRows.forEach((row) => {
        batch.update(doc(db, 'staged_assets', row.id), {
          firmId,
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'staged_assets');
    } finally {
      setCommittingBatch(false);
    }
  };

  const handleRejectBatch = async () => {
    if (!user || !activeBatch) return;
    setIngestionError(null);
    setCommittingBatch(true);
    try {
      const batch = writeBatch(db);
      activeBatchRows.forEach((row) => {
        batch.update(doc(db, 'staged_assets', row.id), {
          reviewStatus: 'rejected',
          updatedAt: serverTimestamp(),
        });
      });
      if (activeBatch.status === 'staged') {
        const previouslyCommitted = stagedAssets.filter(
          (s) => s.ingestionId === activeBatch.id && s.reviewStatus === 'committed',
        );
        batch.update(doc(db, 'asset_ingestions', activeBatch.id), {
          status: previouslyCommitted.length > 0 ? 'committed' : 'rejected',
          extractedCount: Math.max(1, previouslyCommitted.length || activeBatch.extractedCount),
          totalExtractedValue:
            previouslyCommitted.length > 0
              ? Math.round(
                  previouslyCommitted.reduce((sum, s) => sum + s.totalMarketValue, 0) * 100,
                ) / 100
              : activeBatch.totalExtractedValue,
          summaryNotes:
            previouslyCommitted.length > 0
              ? `Partially committed (${previouslyCommitted.length} verified); remaining staged items rejected.`
              : 'Staging batch rejected during field accuracy review.',
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      setIngestionNotice(`Closed staging batch ${activeBatch.fileName}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `asset_ingestions/${activeBatch.id}`);
    } finally {
      setCommittingBatch(false);
    }
  };

  const handleCommitVerifiedToLedger = async (
    targetBatchOverride?: AssetIngestion | null,
    targetRowsOverride?: StagedAssetRecord[],
  ) => {
    const batchTarget = targetBatchOverride ?? activeBatch;
    const rowsTarget = targetRowsOverride ?? activeBatchRows;
    if (!user || !batchTarget) return;

    const verifiedRows = rowsTarget.filter(
      (r) =>
        r.reviewStatus === 'verified' &&
        r.nameVerified &&
        r.identifierVerified &&
        r.valuationVerified,
    );

    if (verifiedRows.length === 0) {
      setIngestionError(
        'Verify Asset Name, Identifier, and Valuation on at least one staged row before committing to the permanent ledger.',
      );
      return;
    }

    for (const item of verifiedRows) {
      if (item.assetName.trim().length < 2) {
        setIngestionError('Every verified asset must have a name of at least 2 characters.');
        return;
      }
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        setIngestionError(`Quantity for ${item.assetName} must be greater than zero.`);
        return;
      }
    }

    setIngestionError(null);
    setIngestionNotice(null);
    setCommittingBatch(true);
    try {
      const batch = writeBatch(db);

      verifiedRows.forEach((item) => {
        const assetRef = doc(collection(db, 'assets'));
        const meta = ASSET_CLASS_META[item.assetClass];
        batch.set(assetRef, {
          ownerId: user.uid,
          ingestionId: batchTarget.id,
          accountId: item.accountId || '',
          firmId: item.firmId || '',
          assetName: item.assetName.trim().slice(0, 140),
          tickerOrIdentifier: item.tickerOrIdentifier.trim().slice(0, 48) || 'AST',
          assetCategoryGroup: meta.group,
          assetClass: item.assetClass,
          quantity: Math.round(item.quantity * 10000) / 10000,
          unitCostBasis: Math.round(Math.max(0, item.unitCostBasis) * 100) / 100,
          totalMarketValue: Math.round(Math.max(0, item.totalMarketValue) * 100) / 100,
          currency: item.currency,
          valuationDate: normalizeDate(item.valuationDate),
          jurisdiction: item.jurisdiction.trim().slice(0, 80) || 'United States',
          regulatoryClassification:
            item.regulatoryClassification.trim().slice(0, 80) || meta.defaultRegClass,
          mfaVerified: false,
          custodyStatus: 'pending_verification',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        batch.update(doc(db, 'staged_assets', item.id), {
          reviewStatus: 'committed',
          committedAssetId: assetRef.id,
          updatedAt: serverTimestamp(),
        });
      });

      const remainingOpenCount = rowsTarget.length - verifiedRows.length;
      if (remainingOpenCount === 0 && batchTarget.status === 'staged') {
        const previouslyCommitted = stagedAssets.filter(
          (s) => s.ingestionId === batchTarget.id && s.reviewStatus === 'committed',
        );
        const allCommitted = [...previouslyCommitted, ...verifiedRows];
        const totalCommittedValue =
          Math.round(allCommitted.reduce((sum, s) => sum + s.totalMarketValue, 0) * 100) / 100;

        batch.update(doc(db, 'asset_ingestions', batchTarget.id), {
          status: 'committed',
          extractedCount: allCommitted.length,
          totalExtractedValue: totalCommittedValue,
          summaryNotes:
            `Verified and committed ${allCommitted.length} holding${allCommitted.length === 1 ? '' : 's'} from ${batchTarget.fileName} to the permanent ledger.`.slice(
              0,
              400,
            ),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
      setIngestionNotice(
        `Committed ${verifiedRows.length} verified asset${verifiedRows.length === 1 ? '' : 's'} to the Permanent Ledger (pending TOTP MFA custody sign-off).`,
      );
      if (remainingOpenCount === 0) {
        setActiveSection('ledger');
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'assets');
    } finally {
      setCommittingBatch(false);
    }
  };

  const openInspectorModal = (row: StagedAssetRecord) => {
    setInspectTargetId(row.id);
    setInspName(row.assetName);
    setInspIdentifier(row.tickerOrIdentifier);
    setInspClass(row.assetClass);
    setInspQty(String(row.quantity));
    setInspCostBasis(String(row.unitCostBasis));
    setInspMarketValue(String(row.totalMarketValue));
    setInspCurrency(row.currency);
    setInspDate(row.valuationDate);
    setInspJurisdiction(row.jurisdiction);
    setInspRegClass(row.regulatoryClassification);
    setInspAccountId(row.accountId);
    setInspFirmId(row.firmId);
    setInspNameVerified(row.nameVerified);
    setInspIdVerified(row.identifierVerified);
    setInspValVerified(row.valuationVerified);
    setInspFlagged(row.reviewStatus === 'flagged');
    setInspNotes(row.reviewerNotes);
    setInspError(null);
    setInspFeedback(null);
  };

  const handleSaveInspector = async (
    e: React.FormEvent,
    overrideVerifyAll?: boolean,
  ): Promise<boolean> => {
    e.preventDefault();
    if (!inspectTarget) return false;
    setInspError(null);
    setInspFeedback(null);

    if (inspName.trim().length < 2) {
      setInspError('Asset name must be at least 2 characters.');
      return false;
    }
    if (inspIdentifier.trim().length < 1) {
      setInspError('Identifier / Ticker / CUSIP is required.');
      return false;
    }
    const qty = Number.parseFloat(inspQty);
    const cost = Number.parseFloat(inspCostBasis);
    const mkt = Number.parseFloat(inspMarketValue);
    if (!Number.isFinite(qty) || qty <= 0) {
      setInspError('Quantity must be greater than zero.');
      return false;
    }
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(mkt) || mkt < 0) {
      setInspError('Cost basis and market value must be non-negative.');
      return false;
    }

    const finalNameVer = overrideVerifyAll ? true : inspNameVerified;
    const finalIdVer = overrideVerifyAll ? true : inspIdVerified;
    const finalValVer = overrideVerifyAll ? true : inspValVerified;
    const finalStatus: StagedAssetReviewStatus = overrideVerifyAll
      ? 'verified'
      : inspFlagged
        ? 'flagged'
        : finalNameVer && finalIdVer && finalValVer
          ? 'verified'
          : 'pending_review';

    if (overrideVerifyAll) {
      setInspNameVerified(true);
      setInspIdVerified(true);
      setInspValVerified(true);
      setInspFlagged(false);
    }

    setSavingInspect(true);
    try {
      await updateStagedRecord(inspectTarget, {
        assetName: inspName,
        tickerOrIdentifier: inspIdentifier,
        assetClass: inspClass,
        quantity: qty,
        unitCostBasis: cost,
        totalMarketValue: mkt,
        currency: inspCurrency,
        valuationDate: inspDate,
        jurisdiction: inspJurisdiction,
        regulatoryClassification: inspRegClass,
        accountId: inspAccountId,
        firmId: inspFirmId,
        nameVerified: finalNameVer,
        identifierVerified: finalIdVer,
        valuationVerified: finalValVer,
        reviewStatus: finalStatus,
        reviewerNotes: inspNotes,
      });
      setInspFeedback(
        overrideVerifyAll
          ? 'Fields saved and holding verified for final ledger submission.'
          : 'Edited fields saved to staging record.',
      );
      return true;
    } finally {
      setSavingInspect(false);
    }
  };

  const openCreateAssetModal = () => {
    setEditingAsset(null);
    setAssetName('');
    setTickerOrId('');
    setAssetClass('public_equity');
    setQuantity('100');
    setUnitCostBasis('125.00');
    setTotalMarketValue('12500.00');
    setCurrency('USD');
    setValuationDate('2026-11-18');
    setJurisdiction('United States · Delaware');
    setRegClassification(ASSET_CLASS_META.public_equity.defaultRegClass);
    setLinkedAccountId(accounts[0]?.id || '');
    setLinkedFirmId(firms[0]?.id || '');
    setAssetFormError(null);
    setAssetModalOpen(true);
  };

  const openEditAssetModal = (asset: OnboardedAsset) => {
    setEditingAsset(asset);
    setAssetName(asset.assetName);
    setTickerOrId(asset.tickerOrIdentifier);
    setAssetClass(asset.assetClass);
    setQuantity(String(asset.quantity));
    setUnitCostBasis(String(asset.unitCostBasis));
    setTotalMarketValue(String(asset.totalMarketValue));
    setCurrency(asset.currency);
    setValuationDate(asset.valuationDate);
    setJurisdiction(asset.jurisdiction);
    setRegClassification(asset.regulatoryClassification);
    setLinkedAccountId(asset.accountId);
    setLinkedFirmId(asset.firmId);
    setAssetFormError(null);
    setAssetModalOpen(true);
  };

  const handleSaveAssetModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setAssetFormError(null);

    if (assetName.trim().length < 2) {
      setAssetFormError('Asset name must be at least 2 characters.');
      return;
    }
    if (tickerOrId.trim().length < 1) {
      setAssetFormError('Ticker or parcel/cusip identifier is required.');
      return;
    }
    const qty = Number.parseFloat(quantity);
    const cost = Number.parseFloat(unitCostBasis);
    const marketVal = Number.parseFloat(totalMarketValue);
    if (!Number.isFinite(qty) || qty <= 0) {
      setAssetFormError('Quantity must be a positive number.');
      return;
    }
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(marketVal) || marketVal < 0) {
      setAssetFormError('Cost basis and market value must be non-negative.');
      return;
    }

    setSavingAsset(true);
    try {
      if (editingAsset) {
        await updateDoc(doc(db, 'assets', editingAsset.id), {
          assetName: assetName.trim().slice(0, 140),
          tickerOrIdentifier: tickerOrId.trim().slice(0, 48),
          quantity: Math.round(qty * 10000) / 10000,
          unitCostBasis: Math.round(cost * 100) / 100,
          totalMarketValue: Math.round(marketVal * 100) / 100,
          valuationDate: normalizeDate(valuationDate),
          jurisdiction: jurisdiction.trim().slice(0, 80) || 'United States',
          regulatoryClassification:
            regClassification.trim().slice(0, 80) ||
            ASSET_CLASS_META[editingAsset.assetClass].defaultRegClass,
          accountId: linkedAccountId || '',
          firmId: linkedFirmId || '',
          updatedAt: serverTimestamp(),
        });
      } else {
        const meta = ASSET_CLASS_META[assetClass];
        await addDoc(collection(db, 'assets'), {
          ownerId: user.uid,
          ingestionId: '',
          accountId: linkedAccountId || '',
          firmId: linkedFirmId || '',
          assetName: assetName.trim().slice(0, 140),
          tickerOrIdentifier: tickerOrId.trim().slice(0, 48),
          assetCategoryGroup: meta.group,
          assetClass,
          quantity: Math.round(qty * 10000) / 10000,
          unitCostBasis: Math.round(cost * 100) / 100,
          totalMarketValue: Math.round(marketVal * 100) / 100,
          currency,
          valuationDate: normalizeDate(valuationDate),
          jurisdiction: jurisdiction.trim().slice(0, 80) || 'United States',
          regulatoryClassification: regClassification.trim().slice(0, 80) || meta.defaultRegClass,
          mfaVerified: false,
          custodyStatus: 'pending_verification',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setEditingAsset(null);
      setAssetModalOpen(false);
    } catch (error) {
      handleFirestoreError(
        error,
        editingAsset ? OperationType.UPDATE : OperationType.CREATE,
        editingAsset ? `assets/${editingAsset.id}` : 'assets',
      );
    } finally {
      setSavingAsset(false);
    }
  };

  const handleConfirmAssetMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !mfaTargetAsset) return;
    setMfaError(null);

    const ok = await verifyTotpCode(totpSecret, enteredMfaCode);
    if (!ok) {
      setMfaError('Invalid TOTP token. Enter the current 6-digit authenticator code.');
      return;
    }

    setVerifyingMfa(true);
    try {
      await updateDoc(doc(db, 'assets', mfaTargetAsset.id), {
        mfaVerified: true,
        custodyStatus: 'custodied',
        updatedAt: serverTimestamp(),
      });
      await updateDoc(doc(db, 'users', user.uid), {
        mfaEnrolled: true,
        updatedAt: serverTimestamp(),
      });
      setMfaTargetAsset(null);
      setEnteredMfaCode('');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `assets/${mfaTargetAsset.id}`);
    } finally {
      setVerifyingMfa(false);
    }
  };

  const handleArchiveAsset = async (asset: OnboardedAsset) => {
    try {
      await updateDoc(doc(db, 'assets', asset.id), {
        custodyStatus: 'archived',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `assets/${asset.id}`);
    }
  };

  const handleDeletePendingAsset = async (asset: OnboardedAsset) => {
    try {
      await deleteDoc(doc(db, 'assets', asset.id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `assets/${asset.id}`);
    }
  };

  const handleExportAssetsCsv = () => {
    const header = [
      'Asset Name',
      'Ticker / Identifier',
      'Category Group',
      'Asset Class',
      'Quantity',
      'Unit Cost Basis',
      'Total Market Value',
      'Currency',
      'Valuation Date',
      'Jurisdiction',
      'Regulatory Classification',
      'Custody Status',
      'MFA Verified',
      'Linked Account',
      'Brokerage Firm',
    ].join(',');

    const rows = filteredAssets.map((a) => {
      const acc = a.accountId ? accountLookup.get(a.accountId) : undefined;
      const firm = a.firmId ? firmLookup.get(a.firmId) : undefined;
      return [
        csvEscape(a.assetName),
        csvEscape(a.tickerOrIdentifier),
        csvEscape(ASSET_CLASS_META[a.assetClass].groupLabel),
        csvEscape(ASSET_CLASS_META[a.assetClass].label),
        csvEscape(a.quantity),
        csvEscape(a.unitCostBasis.toFixed(2)),
        csvEscape(a.totalMarketValue.toFixed(2)),
        csvEscape(a.currency),
        csvEscape(a.valuationDate),
        csvEscape(a.jurisdiction),
        csvEscape(a.regulatoryClassification),
        csvEscape(a.custodyStatus),
        csvEscape(a.mfaVerified),
        csvEscape(acc ? `${acc.accountName} (${acc.accountMask})` : 'Unlinked'),
        csvEscape(firm ? `${firm.firmName} (CRD ${firm.crdNumber})` : 'Direct'),
      ].join(',');
    });

    downloadTextFile('veridian-onboarded-assets.csv', [header, ...rows].join('\n'));
  };

  const handleExportAssetsJson = () => {
    const payload = {
      schema: 'veridian-asset-registry-v1',
      exportedAt: new Date().toISOString(),
      totalAssets: filteredAssets.length,
      assets: filteredAssets.map((a) => ({
        assetName: a.assetName,
        tickerOrIdentifier: a.tickerOrIdentifier,
        assetCategoryGroup: a.assetCategoryGroup,
        assetClass: a.assetClass,
        quantity: a.quantity,
        unitCostBasis: a.unitCostBasis,
        totalMarketValue: a.totalMarketValue,
        currency: a.currency,
        valuationDate: a.valuationDate,
        jurisdiction: a.jurisdiction,
        regulatoryClassification: a.regulatoryClassification,
        custodyStatus: a.custodyStatus,
        mfaVerified: a.mfaVerified,
        linkedAccount: a.accountId ? accountLookup.get(a.accountId)?.accountName || a.accountId : null,
        brokerageFirm: a.firmId ? firmLookup.get(a.firmId)?.firmName || a.firmId : null,
      })),
    };
    downloadTextFile(
      'veridian-onboarded-assets.json',
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8;',
    );
  };

  return (
    <div className="space-y-8">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 font-display">
            Asset Onboarding &amp; Staging Review
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Upload statements to extract holdings into the Staging Review queue, verify asset name,
            identifier, and valuation accuracy, then commit approved positions to the permanent
            ledger.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateAssetModal}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Onboard Single Asset</span>
        </button>
      </div>

      {/* 4-Card Portfolio & Staging Summary Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Staging Review Queue</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {summary.stagedTotal}
          </p>
          <p className="text-xs text-slate-500 mt-2">
            {summary.stagedVerifiedReady} verified ready · {summary.stagedBatchesCount} queued
            document{summary.stagedBatchesCount === 1 ? '' : 's'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Permanent Ledger Value</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {formatCurrency(summary.totalValue)}
          </p>
          <p className="text-xs text-slate-500 mt-2">
            {activeAssets.length} active · {summary.custodiedCount} MFA custodied
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Public Securities</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {formatCurrency(summary.publicSecuritiesValue)}
          </p>
          <p className="text-xs text-slate-500 mt-2">
            {summary.publicSharePct}% of ledger · {summary.pendingMfaCount} pending MFA
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Alternatives &amp; Real Estate</p>
          <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
            {formatCurrency(summary.alternativesAndRealEstateValue)}
          </p>
          <p className="text-xs text-slate-500 mt-2">
            Private Equity, Commodities &amp; Deeds
          </p>
        </div>
      </section>

      {/* Workspace Section Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveSection('staging')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              activeSection === 'staging'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ClipboardCheck className="w-3.5 h-3.5" />
            <span>Staging Review ({summary.stagedTotal})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('ledger')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              activeSection === 'ledger'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Permanent Ledger ({activeAssets.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('audit')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              activeSection === 'audit'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Ingestion Audit ({ingestions.length})</span>
          </button>
        </div>

        {ingestionNotice && (
          <div className="px-3 py-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-3">
            <span>{ingestionNotice}</span>
            <button
              type="button"
              onClick={() => setIngestionNotice(null)}
              className="text-emerald-700 hover:text-emerald-950 font-medium cursor-pointer whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* SECTION 1: UPLOAD & STAGING REVIEW QUEUE */}
      {activeSection === 'staging' && (
        <div className="space-y-6">
          {/* Document Upload & Multimodal Extraction Zone */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 font-display">
                  Document Upload &amp; AI Extraction
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Extracted holdings enter the Staging Review queue in Firestore so every asset
                  name, identifier, and valuation can be verified before permanent commit.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={extracting}
                  onClick={() => void handleLoadSampleCsv()}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                >
                  Stage Sample CSV
                </button>
                <button
                  type="button"
                  disabled={extracting}
                  onClick={() => void handleLoadSampleJson()}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                >
                  Stage Sample JSON
                </button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.json,.txt,application/pdf,image/png,image/jpeg,image/webp,text/csv,application/json,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void processDocumentFile(file);
                }
                e.target.value = '';
              }}
            />

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                const file = e.dataTransfer.files?.[0];
                if (file) {
                  void processDocumentFile(file);
                }
              }}
              onClick={() => !extracting && fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !extracting) {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className={`border border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer ${
                dragActive
                  ? 'border-slate-900 bg-slate-50'
                  : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50/60'
              }`}
            >
              <FolderUp className="w-6 h-6 text-slate-600 mx-auto mb-2.5" />
              {extracting ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-slate-900">{extractionStatusText}</p>
                  <p className="text-xs text-slate-500">
                    Parsing holdings into Staging Review for field accuracy verification...
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-slate-900">
                    Drop a brokerage statement, closing disclosure, CSV, or JSON file here, or click
                    to browse
                  </p>
                  <p className="text-xs text-slate-500">
                    Supports PDF, PNG, JPEG, WEBP, TXT, CSV, and JSON up to 8 MB
                  </p>
                </div>
              )}
            </div>

            {ingestionError && (
              <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between gap-3">
                <span>{ingestionError}</span>
                <button
                  type="button"
                  onClick={() => setIngestionError(null)}
                  className="text-red-700 hover:text-red-900 font-medium cursor-pointer whitespace-nowrap"
                >
                  Dismiss
                </button>
              </div>
            )}
          </section>

          {/* Queued Document Batches Selector */}
          {stagedBatches.length === 0 ? (
            <section className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
              <ClipboardCheck className="w-8 h-8 text-slate-400 mx-auto" />
              <h3 className="text-sm font-semibold text-slate-900 font-display">
                Staging Review Queue is Clear
              </h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                No unverified document extractions are waiting for sign-off. Upload a statement or
                stage a sample CSV/JSON schedule above to review extracted fields.
              </p>
            </section>
          ) : (
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {/* Batch Queue Tabs */}
              <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-500 mr-1 whitespace-nowrap">
                  Queued Documents ({stagedBatches.length}):
                </span>
                {stagedBatches.map((batch) => {
                  const rowsForBatch = openStagingRows.filter((r) => r.ingestionId === batch.id);
                  const verifiedForBatch = rowsForBatch.filter(
                    (r) => r.reviewStatus === 'verified',
                  ).length;
                  const isSelected = activeBatch?.id === batch.id;
                  return (
                    <button
                      key={batch.id}
                      type="button"
                      onClick={() => setSelectedBatchId(batch.id)}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer whitespace-nowrap shrink-0 flex items-center gap-2 ${
                        isSelected
                          ? 'bg-slate-900 text-white border-slate-900 font-medium'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <span className="truncate max-w-[200px]">{batch.fileName}</span>
                      <span
                        className={`font-mono tabular-nums ${
                          isSelected ? 'text-slate-300' : 'text-slate-500'
                        }`}
                      >
                        {verifiedForBatch}/{rowsForBatch.length}
                      </span>
                    </button>
                  );
                })}
              </div>

              {activeBatch && (
                <>
                  {/* Active Batch Header */}
                  <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900 font-display">
                        {activeBatch.fileName}
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {engineLabel(activeBatch.extractionEngine)} ·{' '}
                        {formatBytes(activeBatch.fileSizeBytes)} ·{' '}
                        <span className="font-mono tabular-nums">
                          {activeBatchStats.verifiedCount} of {activeBatchStats.totalCount} verified
                        </span>{' '}
                        · {activeBatchStats.flaggedCount} flagged · {activeBatch.summaryNotes}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        disabled={committingBatch || activeBatchRows.length === 0}
                        onClick={() => {
                          if (activeBatchRows[0]) {
                            openInspectorModal(activeBatchRows[0]);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-900 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Columns2 className="w-3.5 h-3.5" />
                        <span>Staging Review Modal</span>
                      </button>
                      <button
                        type="button"
                        disabled={committingBatch || activeBatchRows.length === 0}
                        onClick={() => void handleRejectBatch()}
                        className="px-3 py-2 text-xs font-medium text-red-700 border border-red-200 bg-white rounded-lg hover:bg-red-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        Reject Batch
                      </button>
                      <button
                        type="button"
                        disabled={committingBatch || activeBatchRows.length === 0}
                        onClick={() => void handleBulkVerifyAll()}
                        className="px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 bg-white rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        Verify All Unflagged
                      </button>
                      <button
                        type="button"
                        disabled={committingBatch || activeBatchStats.verifiedCount === 0}
                        onClick={() => void handleCommitVerifiedToLedger()}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>
                          {committingBatch
                            ? 'Committing...'
                            : `Commit ${activeBatchStats.verifiedCount} Verified (${formatCurrency(activeBatchStats.verifiedValue)})`}
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Filter & Bulk Custody Routing Bar */}
                  <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative min-w-[200px]">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={stagingSearch}
                          onChange={(e) => setStagingSearch(e.target.value)}
                          placeholder="Filter staged items..."
                          className="pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                        />
                      </div>

                      <div className="flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-lg">
                        {(
                          [
                            { id: 'all', label: `All (${activeBatchStats.totalCount})` },
                            {
                              id: 'pending_review',
                              label: `Needs Review (${activeBatchStats.pendingCount})`,
                            },
                            {
                              id: 'verified',
                              label: `Verified (${activeBatchStats.verifiedCount})`,
                            },
                            {
                              id: 'flagged',
                              label: `Flagged (${activeBatchStats.flaggedCount})`,
                            },
                          ] as const
                        ).map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setStagingFilter(tab.id)}
                            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                              stagingFilter === tab.id
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-500">Bulk Account:</span>
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            const val = e.target.value;
                            if (!val) return;
                            void handleBulkAssignAccount(val === '__none__' ? '' : val);
                            e.target.value = '';
                          }}
                          className="px-2 py-1 border border-slate-200 rounded bg-white text-slate-800"
                        >
                          <option value="" disabled>
                            Apply to batch...
                          </option>
                          <option value="__none__">Unlinked</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.accountName}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-500">Bulk Brokerage:</span>
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            const val = e.target.value;
                            if (!val) return;
                            void handleBulkAssignFirm(val === '__none__' ? '' : val);
                            e.target.value = '';
                          }}
                          className="px-2 py-1 border border-slate-200 rounded bg-white text-slate-800"
                        >
                          <option value="" disabled>
                            Apply to batch...
                          </option>
                          <option value="__none__">Direct Custody</option>
                          {firms.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.firmName}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Field Accuracy Verification Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                          <th className="py-3 px-4">Asset Name &amp; Field Check</th>
                          <th className="py-3 px-4">Identifier &amp; Field Check</th>
                          <th className="py-3 px-4">Class &amp; Routing</th>
                          <th className="py-3 px-4 text-right">Qty &amp; Valuation Check</th>
                          <th className="py-3 px-4">Review Status</th>
                          <th className="py-3 px-4 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {filteredStagingRows.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-10 text-center text-sm text-slate-500">
                              No staged items match the current review filter.
                            </td>
                          </tr>
                        ) : (
                          filteredStagingRows.map((row) => {
                            const draft = inlineDrafts[row.id];
                            const nameVal = draft?.assetName ?? row.assetName;
                            const idVal = draft?.tickerOrIdentifier ?? row.tickerOrIdentifier;
                            const qtyVal = draft?.quantity ?? String(row.quantity);
                            const mktVal = draft?.totalMarketValue ?? String(row.totalMarketValue);
                            const busy = updatingStagedId === row.id;

                            return (
                              <tr
                                key={row.id}
                                className={
                                  row.reviewStatus === 'flagged'
                                    ? 'bg-red-50/40'
                                    : row.reviewStatus === 'verified'
                                      ? 'bg-emerald-50/25'
                                      : 'hover:bg-slate-50/70'
                                }
                              >
                                {/* Asset Name + Name Accuracy Verification */}
                                <td className="py-3 px-4 min-w-[230px] align-top space-y-1.5">
                                  <input
                                    type="text"
                                    value={nameVal}
                                    onChange={(e) =>
                                      setInlineDrafts((prev) => ({
                                        ...prev,
                                        [row.id]: { ...prev[row.id], assetName: e.target.value },
                                      }))
                                    }
                                    onBlur={() => void commitInlineDraft(row)}
                                    aria-label="Extracted Asset Name"
                                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded bg-white text-xs font-medium text-slate-900"
                                  />
                                  <div className="flex items-center justify-between gap-2">
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() =>
                                        void updateStagedRecord(row, {
                                          nameVerified: !row.nameVerified,
                                          reviewStatus:
                                            row.reviewStatus === 'flagged'
                                              ? 'flagged'
                                              : !row.nameVerified &&
                                                  row.identifierVerified &&
                                                  row.valuationVerified
                                                ? 'verified'
                                                : 'pending_review',
                                        })
                                      }
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                                        row.nameVerified
                                          ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                                      }`}
                                    >
                                      <Check className="w-3 h-3" />
                                      <span>{row.nameVerified ? 'Name Verified' : 'Verify Name'}</span>
                                    </button>
                                    <span className="text-[11px] text-slate-500 truncate max-w-[140px]">
                                      {row.confidenceNote}
                                    </span>
                                  </div>
                                </td>

                                {/* Ticker / ID + ID Accuracy Verification */}
                                <td className="py-3 px-4 min-w-[160px] align-top space-y-1.5">
                                  <input
                                    type="text"
                                    value={idVal}
                                    onChange={(e) =>
                                      setInlineDrafts((prev) => ({
                                        ...prev,
                                        [row.id]: {
                                          ...prev[row.id],
                                          tickerOrIdentifier: e.target.value,
                                        },
                                      }))
                                    }
                                    onBlur={() => void commitInlineDraft(row)}
                                    aria-label="Extracted Identifier"
                                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded bg-white font-mono text-xs text-slate-900"
                                  />
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void updateStagedRecord(row, {
                                        identifierVerified: !row.identifierVerified,
                                        reviewStatus:
                                          row.reviewStatus === 'flagged'
                                            ? 'flagged'
                                            : row.nameVerified &&
                                                !row.identifierVerified &&
                                                row.valuationVerified
                                              ? 'verified'
                                              : 'pending_review',
                                      })
                                    }
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                                      row.identifierVerified
                                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                                    }`}
                                  >
                                    <Check className="w-3 h-3" />
                                    <span>
                                      {row.identifierVerified ? 'ID Verified' : 'Verify ID'}
                                    </span>
                                  </button>
                                </td>

                                {/* Class & Custody Routing */}
                                <td className="py-3 px-4 min-w-[190px] align-top space-y-1.5">
                                  <select
                                    value={row.assetClass}
                                    disabled={busy}
                                    onChange={(e) =>
                                      void updateStagedRecord(row, {
                                        assetClass: e.target.value as AssetClass,
                                      })
                                    }
                                    className="w-full px-2 py-1.5 border border-slate-200 rounded bg-white text-xs text-slate-800"
                                  >
                                    {(Object.keys(ASSET_CLASS_META) as AssetClass[]).map((cls) => (
                                      <option key={cls} value={cls}>
                                        {ASSET_CLASS_META[cls].label}
                                      </option>
                                    ))}
                                  </select>
                                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                                    <span className="truncate max-w-[100px]">
                                      {row.accountId
                                        ? accountLookup.get(row.accountId)?.accountName || 'Linked'
                                        : 'Unlinked'}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-mono">{row.valuationDate}</span>
                                  </div>
                                </td>

                                {/* Qty + Valuation + Valuation Accuracy Verification */}
                                <td className="py-3 px-4 min-w-[210px] align-top space-y-1.5">
                                  <div className="flex items-center justify-end gap-1.5">
                                    <input
                                      type="number"
                                      step="0.0001"
                                      min="0.0001"
                                      value={qtyVal}
                                      onChange={(e) =>
                                        setInlineDrafts((prev) => ({
                                          ...prev,
                                          [row.id]: { ...prev[row.id], quantity: e.target.value },
                                        }))
                                      }
                                      onBlur={() => void commitInlineDraft(row)}
                                      aria-label="Extracted Quantity"
                                      className="w-20 px-2 py-1.5 border border-slate-200 rounded bg-white text-right font-mono tabular-nums text-xs"
                                    />
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={mktVal}
                                      onChange={(e) =>
                                        setInlineDrafts((prev) => ({
                                          ...prev,
                                          [row.id]: {
                                            ...prev[row.id],
                                            totalMarketValue: e.target.value,
                                          },
                                        }))
                                      }
                                      onBlur={() => void commitInlineDraft(row)}
                                      aria-label="Extracted Market Valuation"
                                      className="w-28 px-2 py-1.5 border border-slate-200 rounded bg-white text-right font-mono tabular-nums text-xs font-medium text-slate-900"
                                    />
                                  </div>
                                  <div className="flex items-center justify-end gap-2">
                                    <span className="text-[11px] font-mono text-slate-500">
                                      {row.currency}
                                    </span>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() =>
                                        void updateStagedRecord(row, {
                                          valuationVerified: !row.valuationVerified,
                                          reviewStatus:
                                            row.reviewStatus === 'flagged'
                                              ? 'flagged'
                                              : row.nameVerified &&
                                                  row.identifierVerified &&
                                                  !row.valuationVerified
                                                ? 'verified'
                                                : 'pending_review',
                                        })
                                      }
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                                        row.valuationVerified
                                          ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                                      }`}
                                    >
                                      <Check className="w-3 h-3" />
                                      <span>
                                        {row.valuationVerified
                                          ? 'Valuation Verified'
                                          : 'Verify Valuation'}
                                      </span>
                                    </button>
                                  </div>
                                </td>

                                {/* Review Status */}
                                <td className="py-3 px-4 align-top whitespace-nowrap">
                                  {row.reviewStatus === 'verified' ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      <span>Verified Ready</span>
                                    </span>
                                  ) : row.reviewStatus === 'flagged' ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
                                      <AlertTriangle className="w-3.5 h-3.5" />
                                      <span>Flagged</span>
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                                      <Clock className="w-3.5 h-3.5" />
                                      <span>Needs Review</span>
                                    </span>
                                  )}
                                  <p className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
                                    {[row.nameVerified, row.identifierVerified, row.valuationVerified].filter(Boolean).length}/3 fields
                                  </p>
                                </td>

                                {/* Row Actions */}
                                <td className="py-3 px-4 text-right align-top whitespace-nowrap">
                                  <div className="inline-flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => openInspectorModal(row)}
                                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                                    >
                                      <FileSearch className="w-3 h-3" />
                                      <span>Inspect</span>
                                    </button>
                                    {row.reviewStatus !== 'verified' ? (
                                      <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                          void updateStagedRecord(row, {
                                            nameVerified: true,
                                            identifierVerified: true,
                                            valuationVerified: true,
                                            reviewStatus: 'verified',
                                          })
                                        }
                                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                                      >
                                        <Check className="w-3 h-3" />
                                        <span>Approve</span>
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                          void updateStagedRecord(row, {
                                            reviewStatus: 'flagged',
                                          })
                                        }
                                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-amber-700 bg-white border border-amber-200 rounded-lg hover:bg-amber-50 cursor-pointer"
                                      >
                                        <AlertTriangle className="w-3 h-3" />
                                        <span>Flag</span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      disabled={busy}
                                      aria-label={`Reject ${row.assetName}`}
                                      onClick={() =>
                                        void updateStagedRecord(row, {
                                          reviewStatus: 'rejected',
                                        })
                                      }
                                      className="p-1.5 text-slate-500 hover:text-red-700 bg-white border border-slate-200 rounded-lg cursor-pointer"
                                    >
                                      <XCircle className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      )}

      {/* SECTION 2: PERMANENT ASSET LEDGER */}
      {activeSection === 'ledger' && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[260px]">
              <div className="relative flex-1 max-w-xs min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search asset, ticker, or parcel ID..."
                  className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                {(
                  [
                    { id: 'all', label: 'All Classes' },
                    { id: 'public_securities', label: 'Public Securities' },
                    { id: 'alternatives', label: 'Alternatives' },
                    { id: 'real_estate', label: 'Real Estate' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setGroupFilter(tab.id)}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      groupFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(
                    e.target.value as 'all' | 'pending_verification' | 'custodied' | 'archived',
                  )
                }
                className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-700"
              >
                <option value="all">All Custody States</option>
                <option value="pending_verification">Pending MFA</option>
                <option value="custodied">MFA Custodied</option>
                <option value="archived">Archived</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleExportAssetsCsv}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>
              <button
                type="button"
                onClick={handleExportAssetsJson}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-900 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>JSON</span>
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 px-4">Asset &amp; Identifier</th>
                  <th className="py-3 px-4">Class &amp; Regulation</th>
                  <th className="py-3 px-4">Custody &amp; Brokerage</th>
                  <th className="py-3 px-4 text-right">Quantity</th>
                  <th className="py-3 px-4 text-right">Market Value</th>
                  <th className="py-3 px-4">Custody Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredAssets.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-sm text-slate-500">
                      No assets match the current filter. Review &amp; commit items from the
                      Staging Review queue or click Onboard Single Asset.
                    </td>
                  </tr>
                ) : (
                  filteredAssets.map((asset) => {
                    const meta = ASSET_CLASS_META[asset.assetClass];
                    const acc = asset.accountId ? accountLookup.get(asset.accountId) : undefined;
                    const firm = asset.firmId ? firmLookup.get(asset.firmId) : undefined;
                    return (
                      <tr key={asset.id} className="hover:bg-slate-50 transition-colors">
                        <td className="py-3 px-4 min-w-[220px]">
                          <p className="font-medium text-slate-900">{asset.assetName}</p>
                          <p className="text-xs font-mono text-slate-500">
                            {asset.tickerOrIdentifier} · Valued {asset.valuationDate}
                          </p>
                        </td>
                        <td className="py-3 px-4 min-w-[180px]">
                          <p className="text-xs font-medium text-slate-800">{meta.label}</p>
                          <p className="text-xs text-slate-500 truncate max-w-[220px]">
                            {asset.regulatoryClassification}
                          </p>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600 min-w-[180px]">
                          <p className="truncate max-w-[210px]">
                            {acc
                              ? `${acc.accountName} (•••• ${acc.accountMask})`
                              : 'Unlinked Account'}
                          </p>
                          <p className="text-slate-500 truncate max-w-[210px]">
                            {firm ? `${firm.firmName}` : 'Direct Beneficial Ownership'}
                          </p>
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-800 whitespace-nowrap">
                          {asset.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                          {formatCurrency(asset.totalMarketValue, asset.currency)}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {asset.custodyStatus === 'custodied' ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Custodied (MFA)</span>
                            </span>
                          ) : asset.custodyStatus === 'pending_verification' ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                              <Clock className="w-3.5 h-3.5" />
                              <span>Pending MFA</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500">
                              <Archive className="w-3.5 h-3.5" />
                              <span>Archived</span>
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            {asset.custodyStatus === 'pending_verification' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTotpSecret(generateTotpSecret());
                                    setEnteredMfaCode('');
                                    setCopiedSecret(false);
                                    setMfaError(null);
                                    setMfaTargetAsset(asset);
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                                >
                                  <ShieldCheck className="w-3 h-3" />
                                  <span>Verify MFA</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openEditAssetModal(asset)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                                >
                                  <Pencil className="w-3 h-3" />
                                  <span>Edit</span>
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Delete ${asset.assetName}`}
                                  onClick={() => void handleDeletePendingAsset(asset)}
                                  className="p-1.5 text-slate-500 hover:text-red-700 border border-slate-200 rounded-lg cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                            {asset.custodyStatus === 'custodied' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => openEditAssetModal(asset)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                                >
                                  <Pencil className="w-3 h-3" />
                                  <span>Edit</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleArchiveAsset(asset)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                                >
                                  <Archive className="w-3 h-3" />
                                  <span>Archive</span>
                                </button>
                              </>
                            )}
                            {asset.custodyStatus === 'archived' && (
                              <span className="text-xs text-slate-400">Locked</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* SECTION 3: DOCUMENT INGESTION AUDIT TRAIL */}
      {activeSection === 'audit' && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              Ingested Document Audit Trail ({ingestions.length})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Complete log of uploaded statements across staged, committed, and rejected states
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {ingestions.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No onboarding documents recorded yet.
              </div>
            ) : (
              ingestions.map((ing) => (
                <div
                  key={ing.id}
                  className="px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-xs"
                >
                  <div className="flex items-start gap-3 min-w-[240px]">
                    <FileText className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-slate-900">{ing.fileName}</p>
                      <p className="text-slate-500 mt-0.5">
                        {ing.documentCategory.replace('_', ' ')} ·{' '}
                        {engineLabel(ing.extractionEngine)} · {formatBytes(ing.fileSizeBytes)}
                      </p>
                      <p className="text-slate-600 mt-1">{ing.summaryNotes}</p>
                    </div>
                  </div>
                  <div className="text-right font-mono tabular-nums flex items-center gap-4">
                    <div>
                      <p className="font-medium text-slate-900">
                        {formatCurrency(ing.totalExtractedValue)}
                      </p>
                      <p className="text-slate-500 mt-0.5">
                        {ing.extractedCount} asset{ing.extractedCount === 1 ? '' : 's'} ·{' '}
                        <span
                          className={`capitalize font-sans font-medium ${
                            ing.status === 'committed'
                              ? 'text-emerald-700'
                              : ing.status === 'rejected'
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }`}
                        >
                          {ing.status}
                        </span>
                      </p>
                    </div>
                    {ing.status === 'staged' && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedBatchId(ing.id);
                          setActiveSection('staging');
                        }}
                        className="px-3 py-1.5 text-xs font-sans font-medium text-slate-800 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                      >
                        Open Review
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* Dedicated Side-by-Side Staging Review Modal */}
      {inspectTarget && (() => {
        const currentIndex = Math.max(
          0,
          inspectBatchRows.findIndex((r) => r.id === inspectTarget.id),
        );
        const prevRow = currentIndex > 0 ? inspectBatchRows[currentIndex - 1] : null;
        const nextRow =
          currentIndex >= 0 && currentIndex < inspectBatchRows.length - 1
            ? inspectBatchRows[currentIndex + 1]
            : null;

        const parsedQty = Number.parseFloat(inspQty);
        const parsedCost = Number.parseFloat(inspCostBasis);
        const parsedMkt = Number.parseFloat(inspMarketValue);
        const extractedJsonPayload = {
          assetName: inspName.trim(),
          tickerOrIdentifier: inspIdentifier.trim(),
          assetCategoryGroup: ASSET_CLASS_META[inspClass].group,
          assetClass: inspClass,
          quantity: Number.isFinite(parsedQty) ? parsedQty : inspectTarget.quantity,
          unitCostBasis: Number.isFinite(parsedCost) ? parsedCost : inspectTarget.unitCostBasis,
          totalMarketValue: Number.isFinite(parsedMkt) ? parsedMkt : inspectTarget.totalMarketValue,
          currency: inspCurrency,
          valuationDate: inspDate,
          jurisdiction: inspJurisdiction.trim(),
          regulatoryClassification: inspRegClass.trim(),
          confidenceNote: inspectTarget.confidenceNote,
        };
        const formattedExtractedJson = JSON.stringify(extractedJsonPayload, null, 2);

        const isDraftModified =
          inspName.trim() !== inspectTarget.assetName ||
          inspIdentifier.trim() !== inspectTarget.tickerOrIdentifier ||
          inspClass !== inspectTarget.assetClass ||
          inspCurrency !== inspectTarget.currency ||
          inspDate !== inspectTarget.valuationDate ||
          inspJurisdiction.trim() !== inspectTarget.jurisdiction ||
          inspRegClass.trim() !== inspectTarget.regulatoryClassification ||
          inspAccountId !== inspectTarget.accountId ||
          inspFirmId !== inspectTarget.firmId ||
          inspNotes !== inspectTarget.reviewerNotes ||
          inspFlagged !== (inspectTarget.reviewStatus === 'flagged') ||
          inspNameVerified !== inspectTarget.nameVerified ||
          inspIdVerified !== inspectTarget.identifierVerified ||
          inspValVerified !== inspectTarget.valuationVerified ||
          Math.abs((Number.isFinite(parsedQty) ? parsedQty : 0) - inspectTarget.quantity) > 0.00001 ||
          Math.abs((Number.isFinite(parsedCost) ? parsedCost : 0) - inspectTarget.unitCostBasis) > 0.001 ||
          Math.abs((Number.isFinite(parsedMkt) ? parsedMkt : 0) - inspectTarget.totalMarketValue) > 0.001;

        const rawDocDisplay =
          (inspectBatch?.rawDocumentText && inspectBatch.rawDocumentText.trim()) ||
          [
            `DOCUMENT: ${inspectTarget.fileName} (${engineLabel(inspectTarget.extractionEngine)})`,
            `SUMMARY: ${inspectBatch?.summaryNotes || 'Queued extraction batch'}`,
            '------------------------------------------------------------',
            ...inspectBatchRows.map(
              (r, idx) =>
                `[${String(idx + 1).padStart(2, '0')}] ${r.tickerOrIdentifier} | ${r.assetName} | Qty: ${r.quantity} | Value: ${r.totalMarketValue.toFixed(2)} ${r.currency}`,
            ),
          ].join('\n');
        const rawDocLines = rawDocDisplay.split(/\r?\n/);

        const activeExcerpt =
          (inspectTarget.sourceExcerpt && inspectTarget.sourceExcerpt.trim()) ||
          rawDocLines.find(
            (line) =>
              line.includes(inspectTarget.tickerOrIdentifier) ||
              line.toLowerCase().includes(inspectTarget.assetName.toLowerCase().slice(0, 14)),
          ) ||
          `${inspectTarget.tickerOrIdentifier} · ${inspectTarget.assetName} · ${formatCurrency(inspectTarget.totalMarketValue, inspectTarget.currency)}`;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
            <div className="bg-white border border-slate-200 rounded-xl max-w-6xl w-full my-6 flex flex-col max-h-[92vh] overflow-hidden">
              {/* Modal Top Bar */}
              <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 bg-slate-50">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Columns2 className="w-4 h-4 text-slate-700 shrink-0" />
                    <h3 className="text-base font-semibold text-slate-900 font-display">
                      Staging Review · Side-by-Side Extraction Verification
                    </h3>
                    {inspectTarget.reviewStatus === 'verified' ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Verified Ready</span>
                      </span>
                    ) : inspectTarget.reviewStatus === 'flagged' ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>Flagged Discrepancy</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                        <Clock className="w-3.5 h-3.5" />
                        <span>Needs Field Review</span>
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Source: {inspectTarget.fileName} · {engineLabel(inspectTarget.extractionEngine)} ·{' '}
                    <span className="font-mono tabular-nums">
                      Holding {currentIndex + 1} of {inspectBatchRows.length}
                    </span>
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={!prevRow || savingInspect}
                    onClick={() => prevRow && openInspectorModal(prevRow)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-40 cursor-pointer whitespace-nowrap"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Prev</span>
                  </button>
                  <button
                    type="button"
                    disabled={!nextRow || savingInspect}
                    onClick={() => nextRow && openInspectorModal(nextRow)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-40 cursor-pointer whitespace-nowrap"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Close Staging Review modal"
                    onClick={() => setInspectTargetId(null)}
                    className="p-1.5 text-slate-500 hover:text-slate-900 bg-white border border-slate-200 rounded-lg cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Batch Holding Selector Strip */}
              {inspectBatchRows.length > 1 && (
                <div className="px-6 py-2.5 bg-white border-b border-slate-200 flex items-center gap-2 overflow-x-auto">
                  <span className="text-[11px] font-medium text-slate-500 whitespace-nowrap shrink-0">
                    Batch Holdings:
                  </span>
                  {inspectBatchRows.map((row, idx) => {
                    const active = row.id === inspectTarget.id;
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => openInspectorModal(row)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          active
                            ? 'bg-slate-900 text-white border-slate-900 font-medium'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        <span className="font-mono text-[11px] opacity-75">#{idx + 1}</span>
                        <span>{row.tickerOrIdentifier}</span>
                        {row.reviewStatus === 'verified' ? (
                          <CheckCircle2
                            className={`w-3 h-3 ${active ? 'text-emerald-300' : 'text-emerald-600'}`}
                          />
                        ) : row.reviewStatus === 'flagged' ? (
                          <AlertTriangle
                            className={`w-3 h-3 ${active ? 'text-amber-300' : 'text-red-600'}`}
                          />
                        ) : (
                          <Clock className={`w-3 h-3 ${active ? 'text-slate-300' : 'text-amber-600'}`} />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Side-by-Side Comparison Body */}
              <form
                onSubmit={(e) => void handleSaveInspector(e)}
                className="flex-1 overflow-y-auto flex flex-col"
              >
                <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
                  {/* LEFT COLUMN: RAW DOCUMENT TEXT */}
                  <div className="lg:col-span-5 p-5 bg-slate-50/70 flex flex-col gap-4">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                          <FileText className="w-3.5 h-3.5" />
                          <span>Raw Document Text</span>
                        </h4>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Verbatim document excerpt vs. extracted holding line
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(rawDocDisplay);
                          setCopiedModalPayload('raw');
                          window.setTimeout(() => setCopiedModalPayload(null), 1800);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                      >
                        <Copy className="w-3 h-3" />
                        <span>{copiedModalPayload === 'raw' ? 'Copied' : 'Copy Text'}</span>
                      </button>
                    </div>

                    {/* Matched Source Snippet for Selected Asset */}
                    <div className="p-3.5 bg-amber-50/60 border border-amber-200 rounded-lg space-y-1.5">
                      <p className="text-[11px] font-semibold text-amber-900 uppercase tracking-wider">
                        Matched Source Line · {inspectTarget.tickerOrIdentifier}
                      </p>
                      <p className="font-mono text-xs text-slate-900 break-words leading-relaxed">
                        {activeExcerpt}
                      </p>
                      <p className="text-[11px] text-slate-600">
                        <span className="font-medium text-slate-800">AI Note:</span>{' '}
                        {inspectTarget.confidenceNote}
                      </p>
                    </div>

                    {/* Line-Numbered Full Document Raw Text */}
                    <div className="flex-1 min-h-[280px] max-h-[520px] bg-white border border-slate-200 rounded-lg overflow-auto">
                      <div className="px-3 py-2 bg-slate-100 border-b border-slate-200 flex items-center justify-between text-[11px] text-slate-600 font-mono">
                        <span>{inspectTarget.fileName}</span>
                        <span>{rawDocLines.length} lines</span>
                      </div>
                      <div className="p-3 font-mono text-xs leading-relaxed space-y-0.5">
                        {rawDocLines.map((line, lineIdx) => {
                          const normalizedLine = line.toLowerCase();
                          const isHighlighted =
                            (inspectTarget.tickerOrIdentifier.length >= 2 &&
                              normalizedLine.includes(
                                inspectTarget.tickerOrIdentifier.toLowerCase(),
                              )) ||
                            (activeExcerpt.length >= 8 &&
                              normalizedLine.includes(activeExcerpt.toLowerCase().slice(0, 24)));
                          return (
                            <div
                              key={lineIdx}
                              className={`flex gap-3 px-2 py-0.5 rounded ${
                                isHighlighted
                                  ? 'bg-amber-100/80 text-slate-900 font-medium'
                                  : 'text-slate-700'
                              }`}
                            >
                              <span className="select-none text-slate-400 w-6 text-right shrink-0 tabular-nums">
                                {lineIdx + 1}
                              </span>
                              <span className="whitespace-pre-wrap break-all">{line || ' '}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* RIGHT COLUMN: AI-EXTRACTED JSON FIELDS & MANUAL CORRECTION FORM */}
                  <div className="lg:col-span-7 p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                          <Code2 className="w-3.5 h-3.5" />
                          <span>AI-Extracted JSON Fields &amp; Manual Corrections</span>
                        </h4>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Compare parsed JSON against the source text and edit any incorrect values
                          before submission
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {isDraftModified && (
                          <span className="text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                            Unsaved Edits
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(formattedExtractedJson);
                            setCopiedModalPayload('json');
                            window.setTimeout(() => setCopiedModalPayload(null), 1800);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                        >
                          <Copy className="w-3 h-3" />
                          <span>{copiedModalPayload === 'json' ? 'Copied' : 'Copy JSON'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Live AI-Extracted JSON Comparison Block */}
                    <pre className="bg-slate-900 text-slate-100 rounded-lg p-3.5 font-mono text-xs leading-relaxed overflow-x-auto max-h-56">
                      <code>{formattedExtractedJson}</code>
                    </pre>

                    {inspError && (
                      <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                        {inspError}
                      </div>
                    )}
                    {inspFeedback && (
                      <div className="p-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
                        {inspFeedback}
                      </div>
                    )}

                    {/* 3 Required Accuracy Verification Checkboxes */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <label
                        className={`flex items-center gap-2 p-2.5 border rounded-lg cursor-pointer transition-colors ${
                          inspNameVerified
                            ? 'bg-emerald-50/70 border-emerald-300'
                            : 'bg-white border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={inspNameVerified}
                          onChange={(e) => setInspNameVerified(e.target.checked)}
                        />
                        <span className="text-xs font-medium text-slate-900">
                          Asset Name Accurate
                        </span>
                      </label>
                      <label
                        className={`flex items-center gap-2 p-2.5 border rounded-lg cursor-pointer transition-colors ${
                          inspIdVerified
                            ? 'bg-emerald-50/70 border-emerald-300'
                            : 'bg-white border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={inspIdVerified}
                          onChange={(e) => setInspIdVerified(e.target.checked)}
                        />
                        <span className="text-xs font-medium text-slate-900">
                          Identifier / ID Accurate
                        </span>
                      </label>
                      <label
                        className={`flex items-center gap-2 p-2.5 border rounded-lg cursor-pointer transition-colors ${
                          inspValVerified
                            ? 'bg-emerald-50/70 border-emerald-300'
                            : 'bg-white border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={inspValVerified}
                          onChange={(e) => setInspValVerified(e.target.checked)}
                        />
                        <span className="text-xs font-medium text-slate-900">
                          Valuation Accurate
                        </span>
                      </label>
                    </div>

                    {/* Editable Extracted Fields */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Asset Name
                        </label>
                        <input
                          type="text"
                          value={inspName}
                          onChange={(e) => setInspName(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Ticker / CUSIP / Parcel ID
                        </label>
                        <input
                          type="text"
                          value={inspIdentifier}
                          onChange={(e) => setInspIdentifier(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                          required
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Quantity
                        </label>
                        <input
                          type="number"
                          step="0.0001"
                          min="0.0001"
                          value={inspQty}
                          onChange={(e) => setInspQty(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Unit Cost Basis
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={inspCostBasis}
                          onChange={(e) => setInspCostBasis(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg"
                          required
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-xs font-medium text-slate-700">
                            Market Valuation
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              const q = Number.parseFloat(inspQty);
                              const c = Number.parseFloat(inspCostBasis);
                              if (Number.isFinite(q) && Number.isFinite(c)) {
                                setInspMarketValue((q * c).toFixed(2));
                              }
                            }}
                            className="text-[11px] font-medium text-slate-600 hover:text-slate-900 underline cursor-pointer"
                          >
                            Qty × Cost
                          </button>
                        </div>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={inspMarketValue}
                          onChange={(e) => setInspMarketValue(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg"
                          required
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Asset Class
                        </label>
                        <select
                          value={inspClass}
                          onChange={(e) => {
                            const nextCls = e.target.value as AssetClass;
                            setInspClass(nextCls);
                            setInspRegClass(ASSET_CLASS_META[nextCls].defaultRegClass);
                          }}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                        >
                          {(Object.keys(ASSET_CLASS_META) as AssetClass[]).map((cls) => (
                            <option key={cls} value={cls}>
                              {ASSET_CLASS_META[cls].label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Currency
                        </label>
                        <select
                          value={inspCurrency}
                          onChange={(e) => setInspCurrency(e.target.value as CurrencyCode)}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                        >
                          <option value="USD">USD</option>
                          <option value="EUR">EUR</option>
                          <option value="GBP">GBP</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Valuation Date
                        </label>
                        <input
                          type="date"
                          value={inspDate}
                          onChange={(e) => setInspDate(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                          required
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Jurisdiction
                        </label>
                        <input
                          type="text"
                          value={inspJurisdiction}
                          onChange={(e) => setInspJurisdiction(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Regulatory Classification
                        </label>
                        <input
                          type="text"
                          value={inspRegClass}
                          onChange={(e) => setInspRegClass(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                          required
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Linked Custody Account
                        </label>
                        <select
                          value={inspAccountId}
                          onChange={(e) => setInspAccountId(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                        >
                          <option value="">Unlinked</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.accountName} (•••• {a.accountMask})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Brokerage Firm
                        </label>
                        <select
                          value={inspFirmId}
                          onChange={(e) => setInspFirmId(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                        >
                          <option value="">Direct Custody</option>
                          {firms.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.firmName}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Reviewer Audit Notes
                        </label>
                        <input
                          type="text"
                          maxLength={240}
                          value={inspNotes}
                          onChange={(e) => setInspNotes(e.target.value)}
                          placeholder="Optional discrepancy or reconciliation note..."
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                        />
                      </div>
                      <label className="flex items-center gap-2 px-3 py-2 border border-amber-200 bg-amber-50/50 rounded-lg cursor-pointer">
                        <input
                          type="checkbox"
                          checked={inspFlagged}
                          onChange={(e) => setInspFlagged(e.target.checked)}
                        />
                        <span className="text-xs font-medium text-amber-900">Flag Discrepancy</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Modal Sticky Footer */}
                <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-slate-600 font-mono tabular-nums">
                    Batch Readiness: {inspectBatchStats.verifiedCount}/{inspectBatchStats.totalCount}{' '}
                    verified ({formatCurrency(inspectBatchStats.verifiedValue)})
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setInspectTargetId(null)}
                      className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                    >
                      Close
                    </button>
                    <button
                      type="submit"
                      disabled={savingInspect || committingBatch}
                      className="px-3.5 py-2 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      {savingInspect ? 'Saving...' : 'Save Field Edits'}
                    </button>
                    <button
                      type="button"
                      disabled={savingInspect || committingBatch}
                      onClick={(e) => void handleSaveInspector(e, true)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-300 rounded-lg hover:bg-emerald-100 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Verify &amp; Approve Item</span>
                    </button>
                    <button
                      type="button"
                      disabled={
                        savingInspect ||
                        committingBatch ||
                        (inspectBatchStats.verifiedCount === 0 &&
                          !(inspNameVerified && inspIdVerified && inspValVerified && !inspFlagged))
                      }
                      onClick={async (e) => {
                        let overrideRows: StagedAssetRecord[] | undefined;
                        if (isDraftModified) {
                          const ok = await handleSaveInspector(e);
                          if (!ok) return;
                          const draftStatus: StagedAssetReviewStatus = inspFlagged
                            ? 'flagged'
                            : inspNameVerified && inspIdVerified && inspValVerified
                              ? 'verified'
                              : 'pending_review';
                          overrideRows = inspectBatchRows.map((row) =>
                            row.id === inspectTarget.id
                              ? {
                                  ...row,
                                  assetName: inspName.trim(),
                                  tickerOrIdentifier: inspIdentifier.trim(),
                                  assetClass: inspClass,
                                  assetCategoryGroup: ASSET_CLASS_META[inspClass].group,
                                  quantity: Number.isFinite(parsedQty) ? parsedQty : row.quantity,
                                  unitCostBasis: Number.isFinite(parsedCost)
                                    ? parsedCost
                                    : row.unitCostBasis,
                                  totalMarketValue: Number.isFinite(parsedMkt)
                                    ? parsedMkt
                                    : row.totalMarketValue,
                                  currency: inspCurrency,
                                  valuationDate: inspDate,
                                  jurisdiction: inspJurisdiction.trim(),
                                  regulatoryClassification: inspRegClass.trim(),
                                  accountId: inspAccountId,
                                  firmId: inspFirmId,
                                  nameVerified: inspNameVerified,
                                  identifierVerified: inspIdVerified,
                                  valuationVerified: inspValVerified,
                                  reviewStatus: draftStatus,
                                  reviewerNotes: inspNotes,
                                }
                              : row,
                          );
                        }
                        if (inspectBatch) {
                          setSelectedBatchId(inspectBatch.id);
                        }
                        setInspectTargetId(null);
                        await handleCommitVerifiedToLedger(inspectBatch, overrideRows);
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>
                        {committingBatch
                          ? 'Submitting...'
                          : `Submit ${
                              inspectBatchStats.verifiedCount === 0 &&
                              inspNameVerified &&
                              inspIdVerified &&
                              inspValVerified &&
                              !inspFlagged
                                ? 1
                                : inspectBatchStats.verifiedCount
                            } Verified to Ledger`}
                      </span>
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* Manual Asset Onboard / Edit Modal */}
      {assetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 my-8">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                {editingAsset ? `Edit Asset · ${editingAsset.assetName}` : 'Onboard Single Asset'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setEditingAsset(null);
                  setAssetModalOpen(false);
                }}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveAssetModal(e)} className="mt-5 space-y-4">
              {assetFormError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {assetFormError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Asset Name</label>
                <input
                  type="text"
                  value={assetName}
                  onChange={(e) => setAssetName(e.target.value)}
                  placeholder="NVIDIA Corporation Common / 500 Pearl St Deed"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Ticker / CUSIP / Parcel ID
                  </label>
                  <input
                    type="text"
                    value={tickerOrId}
                    onChange={(e) => setTickerOrId(e.target.value)}
                    placeholder="NVDA"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Asset Class
                  </label>
                  <select
                    value={assetClass}
                    disabled={Boolean(editingAsset)}
                    onChange={(e) => {
                      const nextCls = e.target.value as AssetClass;
                      setAssetClass(nextCls);
                      setRegClassification(ASSET_CLASS_META[nextCls].defaultRegClass);
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white disabled:bg-slate-100"
                  >
                    {(Object.keys(ASSET_CLASS_META) as AssetClass[]).map((cls) => (
                      <option key={cls} value={cls}>
                        {ASSET_CLASS_META[cls].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Quantity</label>
                  <input
                    type="number"
                    step="0.0001"
                    min="0.0001"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Unit Cost Basis
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={unitCostBasis}
                    onChange={(e) => setUnitCostBasis(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-700">Market Value</label>
                    <button
                      type="button"
                      onClick={() => {
                        const qtyNum = Number.parseFloat(quantity);
                        const costNum = Number.parseFloat(unitCostBasis);
                        if (Number.isFinite(qtyNum) && Number.isFinite(costNum)) {
                          setTotalMarketValue((qtyNum * costNum).toFixed(2));
                        }
                      }}
                      className="text-[11px] font-medium text-slate-600 hover:text-slate-900 underline cursor-pointer"
                    >
                      Qty × Cost
                    </button>
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={totalMarketValue}
                    onChange={(e) => setTotalMarketValue(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Valuation Date
                  </label>
                  <input
                    type="date"
                    value={valuationDate}
                    onChange={(e) => setValuationDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                    required
                  />
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
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Regulatory Classification
                </label>
                <input
                  type="text"
                  value={regClassification}
                  onChange={(e) => setRegClassification(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Linked Custody Account
                  </label>
                  <select
                    value={linkedAccountId}
                    onChange={(e) => setLinkedAccountId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="">Unlinked</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountName} (•••• {a.accountMask})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Brokerage Firm
                  </label>
                  <select
                    value={linkedFirmId}
                    onChange={(e) => setLinkedFirmId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="">Direct Ownership</option>
                    {firms.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.firmName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!editingAsset && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Currency</label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              )}

              <div className="pt-3 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditingAsset(null);
                    setAssetModalOpen(false);
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAsset}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {savingAsset
                    ? 'Saving...'
                    : editingAsset
                      ? 'Save Changes'
                      : 'Onboard Asset'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TOTP MFA Custody Verification Modal */}
      {mfaTargetAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900 font-display">
                Verify Asset Custody via TOTP MFA
              </h3>
              <button
                type="button"
                onClick={() => setMfaTargetAsset(null)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleConfirmAssetMfa(e)} className="mt-5 space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1">
                <p className="font-semibold text-slate-900">{mfaTargetAsset.assetName}</p>
                <p className="font-mono text-slate-600">
                  {mfaTargetAsset.tickerOrIdentifier} ·{' '}
                  {formatCurrency(mfaTargetAsset.totalMarketValue, mfaTargetAsset.currency)}
                </p>
              </div>

              <div className="p-4 border border-slate-200 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-900 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Per-Action Authenticator Token</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        formatOtpAuthUri(mfaTargetAsset.tickerOrIdentifier, totpSecret),
                      );
                      setCopiedSecret(true);
                      window.setTimeout(() => setCopiedSecret(false), 2000);
                    }}
                    className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                    <span>{copiedSecret ? 'Copied' : 'Copy URI'}</span>
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-lg font-mono font-semibold tracking-widest text-slate-900 tabular-nums">
                    {liveCode}
                  </span>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-slate-500 font-mono">{secondsLeft}s</span>
                    <button
                      type="button"
                      onClick={() => setEnteredMfaCode(liveCode)}
                      className="text-slate-800 font-medium underline cursor-pointer"
                    >
                      Autofill Token
                    </button>
                  </div>
                </div>
              </div>

              {mfaError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {mfaError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Enter 6-Digit MFA Code
                </label>
                <input
                  type="text"
                  maxLength={6}
                  value={enteredMfaCode}
                  onChange={(e) =>
                    setEnteredMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  placeholder="000000"
                  className="w-full px-3 py-2 text-sm font-mono tracking-widest border border-slate-200 rounded-lg"
                  required
                />
              </div>

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setMfaTargetAsset(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={verifyingMfa}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  {verifyingMfa ? 'Verifying...' : 'Authorize & Custody Asset'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
