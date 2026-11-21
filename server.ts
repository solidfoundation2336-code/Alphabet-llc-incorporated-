import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const SUPPORTED_GEMINI_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/json',
]);

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '16mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'veridian-ledger' });
  });

  app.get('/api/portfolio/providers', (_req, res) => {
    const hasPlaid = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
    const hasSnapTrade = Boolean(process.env.SNAPTRADE_CLIENT_ID && process.env.SNAPTRADE_CONSUMER_KEY);
    res.json({
      manualSupported: true,
      statementSyncSupported: Boolean(process.env.GEMINI_API_KEY),
      liveQuoteFeedSupported: true,
      externalAggregators: [
        {
          id: 'custody_fix_gateway',
          label: 'Veridian Custody FIX / Market Quote Feed',
          available: true,
          mode: 'built_in',
        },
        {
          id: 'direct_api_feed',
          label: 'External Brokerage Aggregator API',
          available: hasPlaid || hasSnapTrade,
          mode: hasPlaid || hasSnapTrade ? 'configured' : 'server_credentials_optional',
        },
      ],
    });
  });

  app.post('/api/portfolio/quotes', async (req, res) => {
    try {
      const { tickers } = req.body as { tickers?: string[] };
      if (!Array.isArray(tickers) || tickers.length === 0) {
        res.status(400).json({ error: 'tickers array is required.' });
        return;
      }

      const sanitized = Array.from(
        new Set(
          tickers
            .map((t) => String(t || '').trim().toUpperCase())
            .filter((t) => /^[A-Z0-9.\-^]{1,12}$/.test(t)),
        ),
      ).slice(0, 20);

      const results: Record<
        string,
        {
          ticker: string;
          status: 'live' | 'unavailable';
          price?: number;
          previousClose?: number;
          changePct?: number;
          currency?: string;
          asOf?: string;
          history?: { date: string; close: number }[];
        }
      > = {};

      await Promise.all(
        sanitized.map(async (ticker) => {
          try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1mo&interval=1d`;
            const resp = await fetch(url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; VeridianLedger/1.0)',
                Accept: 'application/json',
              },
              signal: AbortSignal.timeout(4500),
            });
            if (!resp.ok) {
              results[ticker] = { ticker, status: 'unavailable' };
              return;
            }
            const json = (await resp.json()) as {
              chart?: {
                result?: Array<{
                  meta?: {
                    regularMarketPrice?: number;
                    chartPreviousClose?: number;
                    previousClose?: number;
                    currency?: string;
                    regularMarketTime?: number;
                  };
                  timestamp?: number[];
                  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
                }>;
              };
            };
            const chartResult = json?.chart?.result?.[0];
            const meta = chartResult?.meta;
            const price = meta?.regularMarketPrice;
            if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
              results[ticker] = { ticker, status: 'unavailable' };
              return;
            }
            const prev = meta?.previousClose ?? meta?.chartPreviousClose ?? price;
            const changePct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
            const timestamps = chartResult?.timestamp || [];
            const closes = chartResult?.indicators?.quote?.[0]?.close || [];
            const history: { date: string; close: number }[] = [];
            for (let i = 0; i < timestamps.length; i++) {
              const c = closes[i];
              if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
                const d = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
                history.push({ date: d, close: Number(c.toFixed(2)) });
              }
            }
            results[ticker] = {
              ticker,
              status: 'live',
              price: Number(price.toFixed(2)),
              previousClose: Number(prev.toFixed(2)),
              changePct: Number(changePct.toFixed(2)),
              currency: meta?.currency || 'USD',
              asOf: meta?.regularMarketTime
                ? new Date(meta.regularMarketTime * 1000).toISOString()
                : new Date().toISOString(),
              history,
            };
          } catch {
            results[ticker] = { ticker, status: 'unavailable' };
          }
        }),
      );

      res.json({
        syncedAt: new Date().toISOString(),
        quotes: results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Quote synchronization failed.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/assets/ingest', async (req, res) => {
    try {
      const { fileName, mimeType, base64Data, textContent } = req.body as {
        fileName?: string;
        mimeType?: string;
        base64Data?: string;
        textContent?: string;
      };

      if (!fileName || !mimeType) {
        res.status(400).json({ error: 'fileName and mimeType are required.' });
        return;
      }

      const normalizedMime = mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mimeType.toLowerCase();
      if (!SUPPORTED_GEMINI_MIME_TYPES.has(normalizedMime)) {
        res.status(400).json({
          error: `Unsupported file type (${mimeType}). Upload PDF, PNG, JPEG, WEBP, TXT, CSV, or JSON.`,
        });
        return;
      }

      if (!base64Data && !textContent) {
        res.status(400).json({ error: 'Document content is empty.' });
        return;
      }

      const ai = getGeminiClient();

      const promptText = `You are a financial custody document extraction engine for Veridian Ledger.
Inspect the uploaded document "${fileName}" and extract every investment holding, security position, private fund commitment, commodity holding, or real estate asset mentioned.

Rules:
1. Map each holding to the closest assetClass from:
   - public_equity (stocks, common shares)
   - etf_fund (ETFs, mutual funds, index funds)
   - fixed_income (corporate bonds, municipal bonds, Treasuries, T-Bills, notes)
   - private_equity (LP stakes, buyout funds, direct private shares)
   - venture_fund (VC funds, seed vehicles)
   - commodity (gold, silver, commodities, bullion)
   - commercial_real_estate (office, warehouse, industrial, retail property)
   - residential_real_estate (single-family, multifamily, condo)
   - reit (REIT holdings)
2. Use numeric values (no currency symbols) for quantity, unitCostBasis, and totalMarketValue.
   If quantity is not stated (e.g., a real estate deed or LP commitment), use quantity = 1 and unitCostBasis = purchase price or totalMarketValue.
   If unitCostBasis is missing, estimate cleanly from totalMarketValue / quantity or set 0.
3. Use ISO date format YYYY-MM-DD for valuationDate (default to 2026-11-18 if undated).
4. Choose documentCategory from: brokerage_statement, closing_disclosure, subscription_agreement, holdings_csv, holdings_json, other_document.
5. Keep summaryNotes concise (1-2 sentences) and factual.
6. Provide rawDocumentExcerpt: a verbatim plain-text transcription of the readable text, tables, and headers from the uploaded document (up to 7,500 characters) so reviewers can perform side-by-side verification.
7. For each extracted holding, provide rawTextSnippet: the exact verbatim line, table row, or paragraph excerpt from the document (up to 750 characters) supporting that holding's name, identifier, and valuation.`;

      const parts = base64Data
        ? [
            {
              inlineData: {
                mimeType: normalizedMime,
                data: base64Data,
              },
            },
            { text: promptText },
          ]
        : [
            {
              text: `${promptText}\n\nDocument Content:\n${(textContent || '').slice(0, 120000)}`,
            },
          ];

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          systemInstruction:
            'Extract structured asset holdings strictly matching the JSON response schema alongside verbatim source document text excerpts. Never fabricate non-financial entries.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              documentCategory: {
                type: Type.STRING,
                description:
                  'One of: brokerage_statement, closing_disclosure, subscription_agreement, holdings_csv, holdings_json, other_document',
              },
              summaryNotes: {
                type: Type.STRING,
                description: 'Concise 1-2 sentence audit summary of extracted holdings.',
              },
              rawDocumentExcerpt: {
                type: Type.STRING,
                description:
                  'Verbatim plain-text transcription/excerpt of the source document text (up to 7,500 chars).',
              },
              assets: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    assetName: { type: Type.STRING },
                    tickerOrIdentifier: { type: Type.STRING },
                    assetClass: { type: Type.STRING },
                    quantity: { type: Type.NUMBER },
                    unitCostBasis: { type: Type.NUMBER },
                    totalMarketValue: { type: Type.NUMBER },
                    currency: { type: Type.STRING },
                    valuationDate: { type: Type.STRING },
                    jurisdiction: { type: Type.STRING },
                    regulatoryClassification: { type: Type.STRING },
                    confidenceNote: { type: Type.STRING },
                    rawTextSnippet: {
                      type: Type.STRING,
                      description:
                        'Exact verbatim line or table row from the source document corresponding to this holding.',
                    },
                  },
                  required: [
                    'assetName',
                    'tickerOrIdentifier',
                    'assetClass',
                    'quantity',
                    'unitCostBasis',
                    'totalMarketValue',
                    'currency',
                    'valuationDate',
                    'rawTextSnippet',
                  ],
                },
              },
            },
            required: ['documentCategory', 'summaryNotes', 'rawDocumentExcerpt', 'assets'],
          },
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        res.status(502).json({ error: 'Gemini returned an empty extraction payload.' });
        return;
      }

      const parsed = JSON.parse(rawText) as {
        documentCategory?: string;
        summaryNotes?: string;
        rawDocumentExcerpt?: string;
        assets?: unknown[];
      };

      if (!Array.isArray(parsed.assets) || parsed.assets.length === 0) {
        res.status(422).json({
          error: 'No asset positions could be identified in the uploaded document.',
        });
        return;
      }

      const fallbackRawText = textContent
        ? textContent.trim().slice(0, 7500)
        : `Document: ${fileName} (${normalizedMime})`;

      res.json({
        documentCategory: parsed.documentCategory || 'other_document',
        summaryNotes:
          parsed.summaryNotes || `Extracted ${parsed.assets.length} holdings from ${fileName}.`,
        rawDocumentExcerpt: (parsed.rawDocumentExcerpt || fallbackRawText).slice(0, 7500),
        assets: parsed.assets,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Document extraction failed.';
      const status =
        message.includes('GEMINI_API_KEY')
          ? 500
          : message.includes('429') || message.includes('RESOURCE_EXHAUSTED')
            ? 429
            : 500;
      res.status(status).json({ error: message });
    }
  });

  if (!IS_PROD) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      plugins: [
        {
          name: 'disable-hmr-websocket-transport',
          enforce: 'post',
          transform(code, id) {
            if (id.endsWith('/vite/dist/client/client.mjs')) {
              return {
                code: code.replace(
                  'transport.connect(createHMRHandler(handleMessage));',
                  '/* HMR WebSocket disabled */',
                ),
                map: null,
              };
            }
          },
        },
      ],
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Production build not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Veridian Ledger server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
