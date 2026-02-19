import React, { useEffect, useMemo, useRef, useState } from 'react';
import SymbolRow from './SymbolRow';
import MobileSymbolCard from './MobileSymbolCard';
import { useTelemetrySocket } from '../services/useTelemetrySocket';
import { withProxyApiKey } from '../services/proxyAuth';
import { getProxyApiBase } from '../services/proxyBase';
import { MetricsMessage } from '../types/metrics';

interface DryRunConsoleLog {
  seq: number;
  timestampMs: number;
  symbol: string | null;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}

interface DryRunStatus {
  running: boolean;
  runId: string | null;
  symbols: string[];
  config: {
    walletBalanceStartUsdt: number;
    initialMarginUsdt: number;
    leverage: number;
    takerFeeRate: number;
    maintenanceMarginRate: number;
    fundingIntervalMs: number;
    heartbeatIntervalMs: number;
    debugAggressiveEntry: boolean;
  } | null;
  summary: {
    totalEquity: number;
    walletBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    feePaid: number;
    fundingPnl: number;
    marginHealth: number;
    performance?: {
      totalPnL: number;
      winCount: number;
      lossCount: number;
      totalTrades: number;
      winRate: number;
      maxDrawdown: number;
      sharpeRatio: number;
      pnlCurve: Array<{ timestamp: number; pnl: number }>;
    };
  };
  perSymbol: Record<string, {
    symbol: string;
    metrics: {
      markPrice: number;
      totalEquity: number;
      walletBalance: number;
      unrealizedPnl: number;
      realizedPnl: number;
      feePaid: number;
      fundingPnl: number;
      marginHealth: number;
    };
    performance?: {
      totalPnL: number;
      winCount: number;
      lossCount: number;
      totalTrades: number;
      winRate: number;
      maxDrawdown: number;
      sharpeRatio: number;
      pnlCurve: Array<{ timestamp: number; pnl: number }>;
    };
    risk?: {
      winStreak: number;
      lossStreak: number;
      dynamicLeverage: number;
      stopLossPrice: number | null;
      liquidationRisk?: {
        score: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL';
        timeToLiquidationMs: number | null;
        fundingRateImpact: number;
      };
    };
    position: {
      side: 'LONG' | 'SHORT';
      qty: number;
      notionalUsdt: number;
      entryPrice: number;
      breakEvenPrice: number | null;
      markPrice: number;
      unrealizedPnl: number;
      realizedPnl: number;
      netPnl: number;
      liqPrice: null;
    } | null;
    openLimitOrders: Array<{
      orderId: string;
      side: 'BUY' | 'SELL';
      price: number;
      remainingQty: number;
      reduceOnly: boolean;
      createdTsMs: number;
    }>;
    lastEventTimestampMs: number;
    eventCount: number;
  }>;
  logTail: DryRunConsoleLog[];
  alphaDecay: Array<{
    signalType: string;
    avgValidityMs: number;
    alphaDecayHalfLife: number;
    optimalEntryWindow: [number, number];
    optimalExitWindow: [number, number];
    sampleCount: number;
  }>;
}

interface AIDryRunStatus {
  active: boolean;
  model: string | null;
  decisionIntervalMs: number;
  temperature: number;
  maxOutputTokens: number;
  apiKeySet: boolean;
  localOnly?: boolean;
  lastError: string | null;
  symbols: string[];
}

const DEFAULT_STATUS: DryRunStatus = {
  running: false,
  runId: null,
  symbols: [],
  config: null,
  summary: {
    totalEquity: 0,
    walletBalance: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    feePaid: 0,
    fundingPnl: 0,
    marginHealth: 0,
    performance: {
      totalPnL: 0,
      winCount: 0,
      lossCount: 0,
      totalTrades: 0,
      winRate: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      pnlCurve: [],
    },
  },
  perSymbol: {},
  logTail: [],
  alphaDecay: [],
};

const formatNum = (n: number, d = 2): string => n.toLocaleString(undefined, {
  minimumFractionDigits: d,
  maximumFractionDigits: d,
});

const formatTs = (ts: number): string => {
  if (!(ts > 0)) return '-';
  return new Date(ts).toLocaleTimeString();
};

const MODEL_OPTIONS = [
  // Gemini 3 (Latest)
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  // Gemini 2.5 (Stable)
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Stable)' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Stable)' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (Stable)' },
  // Gemini 2.0 (Deprecated March 2026)
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  // Custom
  { value: 'custom', label: 'Custom Model' },
];

const AIDryRunDashboard: React.FC = () => {
  const proxyUrl = getProxyApiBase();
  const fetchWithAuth = (url: string, init?: RequestInit) => fetch(url, withProxyApiKey(init));

  const [availablePairs, setAvailablePairs] = useState<string[]>([]);
  const [isLoadingPairs, setIsLoadingPairs] = useState(true);
  const [selectedPairs, setSelectedPairs] = useState<string[]>(['BTCUSDT', 'ETHUSDT']);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setDropdownOpen] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<DryRunStatus>(DEFAULT_STATUS);
  const [aiStatus, setAiStatus] = useState<AIDryRunStatus | null>(null);

  const [startBalance, setStartBalance] = useState('5000');
  const [initialMargin, setInitialMargin] = useState('200');
  const [leverage, setLeverage] = useState('10');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gemini-2.5-flash');
  const [customModel, setCustomModel] = useState('');
  const [localMode, setLocalMode] = useState(false);
  const localModeManualOverrideRef = useRef(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [lastMetricsUpdateMs, setLastMetricsUpdateMs] = useState(0);
  const [isRefreshingPositions, setIsRefreshingPositions] = useState(false);

  const activeMetricSymbols = useMemo(
    () => (status.running && status.symbols.length > 0 ? status.symbols : selectedPairs),
    [status.running, status.symbols, selectedPairs]
  );
  const marketData = useTelemetrySocket(activeMetricSymbols);

  useEffect(() => {
    if (Object.keys(marketData).length > 0) {
      setLastMetricsUpdateMs(Date.now());
    }
  }, [marketData]);

  useEffect(() => {
    const loadPairs = async () => {
      setIsLoadingPairs(true);
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetchWithAuth(`${proxyUrl}/api/dry-run/symbols`, { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`symbols_http_${res.status}`);
        }
        const data = await res.json();
        const pairs = Array.isArray(data?.symbols)
          ? data.symbols.filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
          : [];
        if (pairs.length === 0) {
          throw new Error('symbols_empty');
        }
        setAvailablePairs(pairs);
        if (pairs.length > 0) {
          setSelectedPairs((prev) => {
            const valid = prev.filter((s) => pairs.includes(s));
            if (valid.length > 0) return valid;
            return [pairs[0]];
          });
        }
      } catch {
        const fallbackPairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
        setAvailablePairs(fallbackPairs);
        setSelectedPairs((prev) => {
          const valid = prev.filter((s) => fallbackPairs.includes(s));
          if (valid.length > 0) return valid;
          return [fallbackPairs[0]];
        });
      } finally {
        window.clearTimeout(timer);
        setIsLoadingPairs(false);
      }
    };

    loadPairs();
  }, [proxyUrl]);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetchWithAuth(`${proxyUrl}/api/ai-dry-run/status`, { cache: 'no-store' });
        const data = await res.json();
        if (!active) return;
        if (res.ok && data?.status) {
          const next = data.status as DryRunStatus;
          const nextAi = (data?.ai || null) as AIDryRunStatus | null;
          setStatus(next);
          setAiStatus(nextAi);
          if (nextAi && typeof nextAi.localOnly === 'boolean') {
            const shouldApplyServerLocalOnly = next.running || !localModeManualOverrideRef.current;
            if (shouldApplyServerLocalOnly) {
              setLocalMode(nextAi.localOnly);
              if (next.running) {
                localModeManualOverrideRef.current = false;
              }
            }
          }
          if (next.running && next.symbols.length > 0) {
            setSelectedPairs(next.symbols);
          } else if (!next.running && next.config) {
            setStartBalance(String(next.config.walletBalanceStartUsdt));
            setInitialMargin(String(next.config.initialMarginUsdt));
            setLeverage(String(next.config.leverage));
          }
        }
      } catch {
        // keep last known state
      }
    };

    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [proxyUrl]);

  const filteredPairs = useMemo(
    () => availablePairs.filter((p) => p.includes(searchTerm.toUpperCase())),
    [availablePairs, searchTerm]
  );

  const togglePair = (pair: string) => {
    setSelectedPairs((prev) => {
      if (prev.includes(pair)) {
        return prev.filter((p) => p !== pair);
      }
      return [...prev, pair];
    });
  };

  const startDryRun = async () => {
    setActionError(null);
    try {
      if (selectedPairs.length === 0) {
        throw new Error('at_least_one_pair_required');
      }
      const resolvedModel = model === 'custom' ? customModel.trim() : model;
      if (!localMode && (!apiKey.trim() || !resolvedModel)) {
        throw new Error('ai_api_key_and_model_required');
      }
      const res = await fetchWithAuth(`${proxyUrl}/api/ai-dry-run/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: selectedPairs,
          walletBalanceStartUsdt: Number(startBalance),
          initialMarginUsdt: Number(initialMargin),
          leverage: Number(leverage),
          apiKey: localMode ? '' : apiKey.trim(),
          model: localMode ? '' : resolvedModel,
          localOnly: localMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'ai_dry_run_start_failed');
      }
      setStatus((data?.status || DEFAULT_STATUS) as DryRunStatus);
      const nextAi = (data?.ai || null) as AIDryRunStatus | null;
      setAiStatus(nextAi);
      if (nextAi && typeof nextAi.localOnly === 'boolean') {
        setLocalMode(nextAi.localOnly);
        localModeManualOverrideRef.current = false;
      }
    } catch (e: any) {
      setActionError(e?.message || 'ai_dry_run_start_failed');
    }
  };

  const stopDryRun = async () => {
    setActionError(null);
    try {
      const res = await fetchWithAuth(`${proxyUrl}/api/ai-dry-run/stop`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'ai_dry_run_stop_failed');
      setStatus((data?.status || DEFAULT_STATUS) as DryRunStatus);
      const nextAi = (data?.ai || null) as AIDryRunStatus | null;
      setAiStatus(nextAi);
      if (nextAi && typeof nextAi.localOnly === 'boolean') {
        setLocalMode(nextAi.localOnly);
      }
    } catch (e: any) {
      setActionError(e?.message || 'ai_dry_run_stop_failed');
    }
  };

  const resetDryRun = async () => {
    setActionError(null);
    try {
      const res = await fetchWithAuth(`${proxyUrl}/api/ai-dry-run/reset`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'ai_dry_run_reset_failed');
      setStatus((data?.status || DEFAULT_STATUS) as DryRunStatus);
      const nextAi = (data?.ai || null) as AIDryRunStatus | null;
      setAiStatus(nextAi);
      if (nextAi && typeof nextAi.localOnly === 'boolean') {
        setLocalMode(nextAi.localOnly);
      }
    } catch (e: any) {
      setActionError(e?.message || 'ai_dry_run_reset_failed');
    }
  };

  const refreshPositions = async () => {
    setActionError(null);
    setIsRefreshingPositions(true);
    try {
      const res = await fetchWithAuth(`${proxyUrl}/api/ai-dry-run/status`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data?.status) {
        throw new Error(data?.error || 'ai_dry_run_status_failed');
      }
      const next = data.status as DryRunStatus;
      const nextAi = (data?.ai || null) as AIDryRunStatus | null;
      setStatus(next);
      setAiStatus(nextAi);
    } catch (e: any) {
      setActionError(e?.message || 'ai_dry_run_status_failed');
    } finally {
      setIsRefreshingPositions(false);
    }
  };

  const validateApiKey = async () => {
    const key = apiKey.trim();
    if (!key) {
      setApiKeyStatus('invalid');
      setApiKeyError('API key is empty');
      return;
    }
    setApiKeyStatus('validating');
    setApiKeyError(null);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
      );
      if (res.ok) {
        setApiKeyStatus('valid');
        setApiKeyError(null);
      } else {
        const data = await res.json().catch(() => ({}));
        setApiKeyStatus('invalid');
        setApiKeyError(data?.error?.message || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setApiKeyStatus('invalid');
      setApiKeyError(e?.message || 'Network error');
    }
  };

  const summary = status.summary;
  const perf = summary.performance || DEFAULT_STATUS.summary.performance!;
  const marginHealthPct = summary.marginHealth * 100;
  const symbolRows = useMemo(() => Object.values(status.perSymbol), [status.perSymbol]);
  const effectiveLocalMode = status.running ? Boolean(aiStatus?.localOnly) : localMode;
  const telemetryLagMs = lastMetricsUpdateMs > 0 ? Date.now() - lastMetricsUpdateMs : Number.POSITIVE_INFINITY;
  const telemetryConnection = telemetryLagMs < 3_000 ? 'CONNECTED' : telemetryLagMs < 10_000 ? 'STALE' : 'DISCONNECTED';
  const telemetryTone = telemetryConnection === 'CONNECTED'
    ? 'text-emerald-400'
    : telemetryConnection === 'STALE'
      ? 'text-amber-300'
      : 'text-red-400';

  const logLines = useMemo(() => {
    return status.logTail.slice(-200).map((item) => {
      const prefix = `[${formatTs(item.timestampMs)}]${item.symbol ? ` [${item.symbol}]` : ''} [${item.level}]`;
      return `${prefix} ${item.message}`;
    });
  }, [status.logTail]);

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-200 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">AI Dry Run Simulation</h1>
            <p className="text-zinc-500 text-sm mt-1">DATA: MAINNET | MODE: AI PAPER EXECUTION | MULTI-PAIR</p>
          </div>
          <div className="text-xs rounded border border-zinc-700 px-3 py-2 bg-zinc-900">
            <span className={status.running ? 'text-emerald-400' : 'text-zinc-400'}>
              {status.running ? 'RUNNING' : 'STOPPED'}
            </span>
            {status.runId && <span className="text-zinc-500 ml-2">{status.runId}</span>}
            {aiStatus?.model && (
              <span className="text-zinc-500 ml-2">AI: {aiStatus.model}</span>
            )}
            {effectiveLocalMode && (
              <span className="text-zinc-500 ml-2">MODE: LOCAL_POLICY</span>
            )}
            <span className={`ml-2 ${telemetryTone}`}>WS: {telemetryConnection}</span>
            <span className="text-zinc-500 ml-2">
              Last Update: {lastMetricsUpdateMs > 0 ? `${Math.floor(telemetryLagMs / 1000)}s ago` : '-'}
            </span>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-300">Control Panel</h2>

          <div className="relative">
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              disabled={status.running || isLoadingPairs}
              className="w-full flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm disabled:opacity-60"
            >
              <span>{isLoadingPairs ? 'Loading pairs...' : `${selectedPairs.length} pairs selected`}</span>
              <span>▾</span>
            </button>
            <div className="flex flex-wrap gap-1 mt-2">
              {selectedPairs.map((pair) => (
                <span key={pair} className="text-[10px] px-2 py-1 bg-zinc-800 text-zinc-300 rounded-full border border-zinc-700 flex items-center gap-1">
                  {pair}
                  {!status.running && (
                    <button onClick={() => togglePair(pair)} className="hover:text-white transition-colors">×</button>
                  )}
                </span>
              ))}
            </div>
            {isDropdownOpen && !isLoadingPairs && !status.running && (
              <div className="absolute z-10 mt-1 w-full border border-zinc-700 rounded bg-[#18181b] p-2 shadow-2xl">
                <input
                  type="text"
                  placeholder="Filter symbols..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-black border border-zinc-800 rounded px-2 py-1 text-xs mb-2"
                />
                <div className="max-h-56 overflow-y-auto space-y-1">
                  {filteredPairs.map((pair) => (
                    <button
                      key={pair}
                      onClick={() => togglePair(pair)}
                      className={`w-full text-left px-2 py-1 rounded text-xs flex justify-between ${selectedPairs.includes(pair) ? 'bg-zinc-700 text-white' : 'hover:bg-zinc-800 text-zinc-400'}`}
                    >
                      <span>{pair}</span>
                      {selectedPairs.includes(pair) && <span>✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-xs text-zinc-500">
              Start Balance (USDT)
              <input
                type="number"
                min={1}
                value={startBalance}
                disabled={status.running}
                onChange={(e) => setStartBalance(e.target.value)}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono"
              />
            </label>

            <label className="text-xs text-zinc-500">
              Initial Margin (USDT)
              <input
                type="number"
                min={1}
                value={initialMargin}
                disabled={status.running}
                onChange={(e) => setInitialMargin(e.target.value)}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono"
              />
            </label>

            <label className="text-xs text-zinc-500">
              Leverage
              <input
                type="number"
                min={1}
                max={125}
                value={leverage}
                disabled={status.running}
                onChange={(e) => setLeverage(e.target.value)}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="text-xs text-zinc-500">
              <label className="mb-2 flex items-center gap-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={localMode}
                  disabled={status.running}
                  onChange={(e) => {
                    localModeManualOverrideRef.current = true;
                    setLocalMode(e.target.checked);
                  }}
                  className="accent-zinc-300"
                />
                Use local autonomous policy (no external AI call)
              </label>
              Google AI API Key
              <div className="flex gap-2 mt-1">
                <input
                  type="password"
                  value={apiKey}
                  disabled={status.running || localMode}
                  onChange={(e) => { setApiKey(e.target.value); setApiKeyStatus('idle'); setApiKeyError(null); }}
                  placeholder={localMode ? 'Local mode active' : 'AIza...'}
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono"
                />
                <button
                  onClick={validateApiKey}
                  disabled={status.running || localMode || apiKeyStatus === 'validating' || !apiKey.trim()}
                  className={`px-3 py-2 rounded text-xs font-bold whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${apiKeyStatus === 'valid'
                    ? 'bg-emerald-700 text-white'
                    : apiKeyStatus === 'invalid'
                      ? 'bg-red-700 text-white'
                      : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600'
                    }`}
                >
                  {apiKeyStatus === 'validating' ? '⏳ Checking...' : apiKeyStatus === 'valid' ? '✓ Valid' : apiKeyStatus === 'invalid' ? '✗ Invalid' : 'Validate Key'}
                </button>
              </div>
              {apiKeyStatus === 'valid' && (
                <div className="text-emerald-400 text-[11px] mt-1">✓ API key is valid and ready to use.</div>
              )}
              {localMode && (
                <div className="text-zinc-500 text-[11px] mt-1">Local mode aktif: kararlar metrik tabanli policy ile uretilir.</div>
              )}
              {apiKeyStatus === 'invalid' && apiKeyError && (
                <div className="text-red-400 text-[11px] mt-1">✗ {apiKeyError}</div>
              )}
            </div>

            <label className="text-xs text-zinc-500">
              Google AI Model
              <select
                value={model}
                disabled={status.running || localMode}
                onChange={(e) => setModel(e.target.value)}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
          </div>

          {model === 'custom' && (
            <label className="text-xs text-zinc-500">
              Custom Model ID
              <input
                type="text"
                value={customModel}
                disabled={status.running || localMode}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="models/your-model"
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono"
              />
            </label>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <button
              onClick={startDryRun}
              disabled={status.running}
              className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs font-bold text-white"
            >
              START AI DRY RUN
            </button>
            <button
              onClick={stopDryRun}
              disabled={!status.running}
              className="px-3 py-2 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs font-bold text-white"
            >
              STOP
            </button>
            <button
              onClick={resetDryRun}
              className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-200 border border-zinc-700"
            >
              RESET
            </button>
          </div>

          {actionError && (
            <div className="text-xs text-red-500" role="alert" aria-live="assertive">
              {actionError}
            </div>
          )}
          {aiStatus?.lastError && (
            <div className="text-xs text-amber-400" role="status" aria-live="polite">
              AI Error: {aiStatus.lastError}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2 bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-wider">Total Equity</div>
            <div className="text-3xl font-bold text-white mt-2 font-mono">{formatNum(summary.totalEquity, 4)} USDT</div>
            <div className="text-[11px] text-zinc-500 mt-2">Symbols: {status.symbols.length}</div>
          </div>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Wallet Balance</div>
            <div className="text-lg font-mono text-white mt-1">{formatNum(summary.walletBalance, 4)}</div>
          </div>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Unrealized PnL</div>
            <div className={`text-lg font-mono mt-1 ${summary.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {summary.unrealizedPnl >= 0 ? '+' : ''}{formatNum(summary.unrealizedPnl, 4)}
            </div>
          </div>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Realized PnL</div>
            <div className={`text-lg font-mono mt-1 ${summary.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {summary.realizedPnl >= 0 ? '+' : ''}{formatNum(summary.realizedPnl, 4)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Total PnL</div>
            <div className={`text-lg font-mono mt-1 ${perf.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {perf.totalPnL >= 0 ? '+' : ''}{formatNum(perf.totalPnL, 4)}
            </div>
          </div>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Win Rate</div>
            <div className={`text-lg font-mono mt-1 ${perf.winRate >= 55 ? 'text-emerald-400' : 'text-amber-300'}`}>
              {formatNum(perf.winRate, 2)}%
            </div>
          </div>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Max Drawdown</div>
            <div className="text-lg font-mono mt-1 text-red-400">
              {formatNum(perf.maxDrawdown, 4)}
            </div>
          </div>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Sharpe</div>
            <div className={`text-lg font-mono mt-1 ${perf.sharpeRatio >= 1.8 ? 'text-emerald-400' : 'text-amber-300'}`}>
              {formatNum(perf.sharpeRatio, 2)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 overflow-x-auto">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-300">Per-Symbol Positions</h2>
              <button
                onClick={refreshPositions}
                disabled={isRefreshingPositions}
                className="px-2 py-1 text-[11px] font-semibold rounded border border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-800 disabled:opacity-60"
              >
                {isRefreshingPositions ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
            <table className="w-full text-xs min-w-[1320px]">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2">Symbol</th>
                  <th className="text-left py-2">Side</th>
                  <th className="text-right py-2">Entry</th>
                  <th className="text-right py-2">Breakeven</th>
                  <th className="text-right py-2">Notional (USDT)</th>
                  <th className="text-right py-2">Mark</th>
                  <th className="text-right py-2">uPnL</th>
                  <th className="text-right py-2">rPnL</th>
                  <th className="text-right py-2">Net</th>
                  <th className="text-right py-2">Eq</th>
                  <th className="text-right py-2">Margin Health</th>
                  <th className="text-right py-2">Streak</th>
                  <th className="text-right py-2">Lev</th>
                  <th className="text-right py-2">Stop</th>
                  <th className="text-right py-2">Liq</th>
                  <th className="text-right py-2">Events</th>
                </tr>
              </thead>
              <tbody>
                {symbolRows.length === 0 && (
                  <tr>
                    <td colSpan={16} className="py-4 text-center text-zinc-600 italic">No active symbol session</td>
                  </tr>
                )}
                {symbolRows.map((row) => (
                  <tr key={row.symbol} className="border-b border-zinc-900">
                    <td className="py-2 font-mono text-zinc-200">{row.symbol}</td>
                    <td className={`py-2 ${row.position?.side === 'LONG' ? 'text-emerald-400' : row.position?.side === 'SHORT' ? 'text-red-400' : 'text-zinc-600'}`}>
                      {row.position?.side || '-'}
                    </td>
                    <td className="py-2 text-right font-mono">{row.position ? formatNum(row.position.entryPrice, 4) : '-'}</td>
                    <td className="py-2 text-right font-mono">{row.position?.breakEvenPrice != null ? formatNum(row.position.breakEvenPrice, 4) : '-'}</td>
                    <td className="py-2 text-right font-mono">{row.position ? formatNum(row.position.notionalUsdt, 2) : '-'}</td>
                    <td className="py-2 text-right font-mono">{formatNum(row.metrics.markPrice, 4)}</td>
                    <td className={`py-2 text-right font-mono ${(row.position?.unrealizedPnl ?? row.metrics.unrealizedPnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {(row.position?.unrealizedPnl ?? row.metrics.unrealizedPnl) >= 0 ? '+' : ''}
                      {formatNum(row.position?.unrealizedPnl ?? row.metrics.unrealizedPnl, 4)}
                    </td>
                    <td className={`py-2 text-right font-mono ${(row.position?.realizedPnl ?? row.metrics.realizedPnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {(row.position?.realizedPnl ?? row.metrics.realizedPnl) >= 0 ? '+' : ''}
                      {formatNum(row.position?.realizedPnl ?? row.metrics.realizedPnl, 4)}
                    </td>
                    <td className={`py-2 text-right font-mono ${(row.position?.netPnl ?? (row.metrics.unrealizedPnl + row.metrics.realizedPnl - row.metrics.feePaid + row.metrics.fundingPnl)) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                      {(row.position?.netPnl ?? (row.metrics.unrealizedPnl + row.metrics.realizedPnl - row.metrics.feePaid + row.metrics.fundingPnl)) >= 0 ? '+' : ''}
                      {formatNum(row.position?.netPnl ?? (row.metrics.unrealizedPnl + row.metrics.realizedPnl - row.metrics.feePaid + row.metrics.fundingPnl), 4)}
                    </td>
                    <td className="py-2 text-right font-mono">{formatNum(row.metrics.totalEquity, 4)}</td>
                    <td className="py-2 text-right font-mono">{formatNum(row.metrics.marginHealth * 100, 2)}%</td>
                    <td className="py-2 text-right font-mono">
                      {row.risk ? `${row.risk.winStreak}/${row.risk.lossStreak}` : '-'}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {row.risk ? formatNum(row.risk.dynamicLeverage, 2) : '-'}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {row.risk?.stopLossPrice ? formatNum(row.risk.stopLossPrice, 4) : '-'}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {row.risk?.liquidationRisk?.score || '-'}
                    </td>
                    <td className="py-2 text-right font-mono text-zinc-500">{row.eventCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4 text-[11px] text-zinc-500 grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>Fees: {formatNum(summary.feePaid, 4)} USDT</div>
              <div>Funding: {formatNum(summary.fundingPnl, 4)} USDT</div>
              <div>Margin Health: {formatNum(marginHealthPct, 2)}%</div>
              <div>Pairs: {status.symbols.join(', ') || '-'}</div>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-zinc-300 mb-3">Event Console</h2>
            <div className="bg-black border border-zinc-800 rounded p-3 h-[360px] overflow-auto font-mono text-[11px] text-zinc-300 whitespace-pre-wrap">
              {logLines.length === 0 ? 'Dry Run not started.' : logLines.join('\n')}
            </div>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Alpha Decay Summary</h2>
          {status.alphaDecay.length === 0 ? (
            <div className="text-xs text-zinc-500">No alpha decay samples yet.</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2">Signal</th>
                  <th className="text-right py-2">Avg Validity (ms)</th>
                  <th className="text-right py-2">Half-Life (ms)</th>
                  <th className="text-right py-2">Entry Window</th>
                  <th className="text-right py-2">Exit Window</th>
                  <th className="text-right py-2">Samples</th>
                </tr>
              </thead>
              <tbody>
                {status.alphaDecay.map((item) => (
                  <tr key={item.signalType} className="border-b border-zinc-800/40">
                    <td className="py-2 font-mono text-zinc-200">{item.signalType}</td>
                    <td className="py-2 text-right font-mono">{formatNum(item.avgValidityMs, 0)}</td>
                    <td className="py-2 text-right font-mono">{formatNum(item.alphaDecayHalfLife, 0)}</td>
                    <td className="py-2 text-right font-mono">{item.optimalEntryWindow[0]}-{item.optimalEntryWindow[1]}</td>
                    <td className="py-2 text-right font-mono">{item.optimalExitWindow[0]}-{item.optimalExitWindow[1]}</td>
                    <td className="py-2 text-right font-mono text-zinc-500">{item.sampleCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden shadow-2xl">
          <div className="px-4 py-3 text-xs uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
            Live Orderflow Metrics (Selected Pairs)
          </div>
          <div className="hidden md:block overflow-x-auto">
            <div className="min-w-[1100px]">
              <div
                className="grid gap-0 px-5 py-4 text-[11px] font-bold text-zinc-500 uppercase tracking-widest bg-zinc-900 border-b border-zinc-800"
                style={{ gridTemplateColumns: 'minmax(140px, 1fr) 110px 130px 90px 90px 90px 90px 90px 120px' }}
              >
                <div>Symbol / Trend</div>
                <div className="text-right">Price</div>
                <div className="text-right">OI / Change</div>
                <div className="text-center">OBI (10L)</div>
                <div className="text-center">OBI (50L)</div>
                <div className="text-center">OBI Div</div>
                <div className="text-center">Delta Z</div>
                <div className="text-center">CVD Slope</div>
                <div className="text-center">Signal</div>
              </div>
              <div className="bg-black/20 divide-y divide-zinc-900">
                {activeMetricSymbols.map((symbol) => {
                  const msg: MetricsMessage | undefined = marketData[symbol];
                  if (!msg) {
                    return (
                      <div key={symbol} className="px-5 py-4 text-xs text-zinc-600 italic">
                        Waiting metrics for {symbol}...
                      </div>
                    );
                  }
                  return <SymbolRow key={symbol} symbol={symbol} data={msg} showLatency={false} />;
                })}
              </div>
            </div>
          </div>

          <div className="md:hidden p-3 space-y-3">
            {activeMetricSymbols.map((symbol) => (
              <MobileSymbolCard key={symbol} symbol={symbol} metrics={marketData[symbol]} showLatency={false} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIDryRunDashboard;
