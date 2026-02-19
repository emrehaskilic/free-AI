import { DryRunEngine } from './DryRunEngine';
import { DryRunConfig, DryRunEventInput, DryRunEventLog, DryRunOrderBook, DryRunOrderRequest, DryRunReasonCode, DryRunStateSnapshot } from './types';
import { StrategyDecision, StrategyActionType, StrategyPositionState, StrategyRegime, StrategySignal, StrategySide } from '../types/strategy';
import { AlertService } from '../notifications/AlertService';
import { PerformanceCalculator, PerformanceMetrics } from '../metrics/PerformanceCalculator';
import { SessionStore } from './SessionStore';
import { LimitOrderStrategy, LimitStrategyMode } from './LimitOrderStrategy';
import { DryRunLogEvent, DryRunOrderflowMetrics, DryRunTradeLogger } from './DryRunTradeLogger';
import { FlipGovernor } from './FlipGovernor';
import { WinnerManager, WinnerState } from './WinnerManager';
import { AddOnManager } from './AddOnManager';
import { DryRunClock } from './DryRunClock';
import path from 'path';

export interface DryRunSessionStartInput {
  symbols?: string[];
  symbol?: string;
  runId?: string;
  walletBalanceStartUsdt: number;
  initialMarginUsdt: number;
  leverage: number;
  takerFeeRate?: number;
  makerFeeRate?: number;
  maintenanceMarginRate?: number;
  fundingRate?: number;
  fundingRates?: Record<string, number>;
  fundingIntervalMs?: number;
  heartbeatIntervalMs?: number;
  debugAggressiveEntry?: boolean;
}

export interface DryRunConsoleLog {
  seq: number;
  timestampMs: number;
  symbol: string | null;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}

export interface DryRunSymbolStatus {
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
  performance?: PerformanceMetrics;
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
  openLimitOrders: DryRunStateSnapshot['openLimitOrders'];
  lastEventTimestampMs: number;
  eventCount: number;
}

export interface DryRunSessionStatus {
  running: boolean;
  runId: string | null;
  symbols: string[];
  config: {
    walletBalanceStartUsdt: number;
    initialMarginUsdt: number;
    leverage: number;
    makerFeeRate: number;
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
    performance?: PerformanceMetrics;
  };
  perSymbol: Record<string, DryRunSymbolStatus>;
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

type PendingEntryContext = {
  reason: 'STRATEGY_SIGNAL' | 'MANUAL_TEST' | 'DEBUG_AGGRESSIVE_ENTRY' | 'UNKNOWN';
  signalType: string | null;
  signalScore: number | null;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
  boost?: StrategySignal['boost'];
  market?: StrategySignal['market'];
  timestampMs: number;
  leverage: number | null;
};

type ActiveTrade = {
  tradeId: string;
  side: 'LONG' | 'SHORT';
  entryTimeMs: number;
  entryPrice: number;
  qty: number;
  notional: number;
  marginUsed: number;
  leverage: number;
  pnlRealized: number;
  feeAcc: number;
  fundingAcc: number;
  signalType: string | null;
  signalScore: number | null;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
};

type SignalSnapshot = {
  side: 'LONG' | 'SHORT';
  signalType: string;
  score: number;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
  boost?: StrategySignal['boost'];
  market?: StrategySignal['market'];
  timestampMs: number;
};

type PendingFlipEntry = {
  side: 'BUY' | 'SELL';
  signalType: string;
  signalScore: number;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
  boost?: StrategySignal['boost'];
  market?: StrategySignal['market'];
  timestampMs: number;
  leverage: number | null;
};

type AddOnState = {
  count: number;
  lastAddOnTs: number;
  pendingClientOrderId: string | null;
  pendingAddonIndex: number | null;
  pendingAttempt: number;
  filledClientOrderIds: Set<string>;
};

type SymbolSession = {
  symbol: string;
  engine: DryRunEngine;
  fundingRate: number;
  lastEventTimestampMs: number;
  lastState: DryRunStateSnapshot;
  lastOrderBook: DryRunOrderBook;
  latestMarkPrice: number;
  lastMarkPrice: number;
  atr: number;
  avgAtr: number;
  priceHistory: number[];
  obi: number;
  volatilityRegime: 'LOW' | 'MEDIUM' | 'HIGH';
  winStreak: number;
  lossStreak: number;
  dynamicLeverage: number;
  stopLossPrice: number | null;
  winnerState: WinnerState | null;
  flipGovernor: FlipGovernor;
  flipState: { partialReduced: boolean; lastPartialReduceTs: number };
  addOnState: AddOnState;
  lastEntryOrAddOnTs: number;
  lastSignal: SignalSnapshot | null;
  pendingFlipEntry: PendingFlipEntry | null;
  spreadBreachCount: number;
  performance: PerformanceCalculator;
  activeSignal: { type: string; timestampMs: number } | null;
  lastEntryEventTs: number;
  lastHeartbeatTs: number;
  lastDataLogTs: number;
  lastEmptyBookLogTs: number;
  lastPerfTs: number;
  realizedPnl: number;
  feePaid: number;
  fundingPnl: number;
  eventCount: number;
  manualOrders: DryRunOrderRequest[];
  logTail: DryRunEventLog[];
  pendingEntry: PendingEntryContext | null;
  pendingExitReason: string | null;
  tradeSeq: number;
  currentTrade: ActiveTrade | null;
  lastSnapshotLogTs: number;
  lastWinnerSignalLogTs: number;
};

type AIIntentMetadata = {
  entryStyle?: 'LIMIT' | 'MARKET_SMALL' | 'HYBRID';
  urgency?: 'LOW' | 'MED' | 'HIGH';
  maxAdds?: number;
  addRule?: 'WINNER_ONLY' | 'TREND_INTACT' | 'NEVER';
  addTrigger?: {
    minUnrealizedPnlPct?: number;
    trendIntact?: boolean;
    obiSupportMin?: number;
    deltaConfirm?: boolean;
  };
  reducePct?: number | null;
};

type AIActionMetadata = {
  plan?: AIIntentMetadata;
  incrementalRiskCapPct?: number;
};

const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005;
const DEFAULT_FUNDING_RATE = 0;
const DEFAULT_FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_EVENT_INTERVAL_MS = Number(process.env.DRY_RUN_EVENT_INTERVAL_MS || 250);
const DEFAULT_ORDERBOOK_DEPTH = Number(process.env.DRY_RUN_ORDERBOOK_DEPTH || 20);
const DEFAULT_ENTRY_COOLDOWN_MS = Number(process.env.DRY_RUN_ENTRY_COOLDOWN_MS || 5000);
const DEFAULT_HEARTBEAT_INTERVAL_MS = Number(process.env.DRY_RUN_HEARTBEAT_INTERVAL_MS || 10_000);
const CONSOLE_LOG_TAIL_LIMIT = Number(process.env.DRY_RUN_CONSOLE_TAIL_LIMIT || 500);
const ENGINE_LOG_TAIL_LIMIT = Number(process.env.DRY_RUN_ENGINE_TAIL_LIMIT || 120);
const DEFAULT_WIN_STREAK_MULT = Number(process.env.DRY_RUN_WIN_STREAK_MULT || 0.06);
const DEFAULT_LOSS_STREAK_DIV = Number(process.env.DRY_RUN_LOSS_STREAK_DIV || 0.25);
const DEFAULT_MARTINGALE_FACTOR = Number(process.env.DRY_RUN_MARTINGALE_FACTOR || 1.2);
const DEFAULT_MARTINGALE_MAX = Number(process.env.DRY_RUN_MARTINGALE_MAX || 3);
const DEFAULT_MAX_NOTIONAL = Number(process.env.DRY_RUN_MAX_NOTIONAL_USDT || 5000);
const DEFAULT_STOP_ATR_MULT = Number(process.env.DRY_RUN_STOP_ATR_MULT || 1.4);
const DEFAULT_STOP_MIN_DIST = Number(process.env.DRY_RUN_STOP_MIN_DIST || 0.5);
const DEFAULT_ATR_WINDOW = Number(process.env.DRY_RUN_ATR_WINDOW || 14);
const DEFAULT_LARGE_LOSS_ALERT = Number(process.env.DRY_RUN_LARGE_LOSS_USDT || 500);
const DEFAULT_LIMIT_STRATEGY = String(process.env.DRY_RUN_LIMIT_STRATEGY || 'MARKET').toUpperCase();
const DEFAULT_PERF_SAMPLE_MS = Number(process.env.DRY_RUN_PERF_SAMPLE_MS || 2000);
const DEFAULT_TRADE_LOG_ENABLED = String(process.env.DRY_RUN_TRADE_LOGS || 'true').toLowerCase();
const DEFAULT_TRADE_LOG_DIR = String(process.env.DRY_RUN_LOG_DIR || path.join(process.cwd(), 'server', 'logs', 'dryrun'));
const DEFAULT_TRADE_LOG_QUEUE = Number(process.env.DRY_RUN_LOG_QUEUE_LIMIT || 10000);
const DEFAULT_TRADE_LOG_DROP = Number(process.env.DRY_RUN_LOG_DROP_THRESHOLD || 2000);
const DEFAULT_SNAPSHOT_LOG_MS = Number(process.env.DRY_RUN_SNAPSHOT_LOG_MS || 30_000);
const DEFAULT_MAKER_FEE_BPS = clampNumber(process.env.MAKER_FEE_BPS, 2, 0, 50);
const DEFAULT_TAKER_FEE_BPS = clampNumber(process.env.TAKER_FEE_BPS, 4, 0, 50);
const DEFAULT_MAKER_FEE_RATE = DEFAULT_MAKER_FEE_BPS / 10000;
const DEFAULT_TAKER_FEE_RATE = DEFAULT_TAKER_FEE_BPS / 10000;
const DEFAULT_ENTRY_SIGNAL_MIN = clampNumber(process.env.ENTRY_SIGNAL_MIN, 50, 0, 100);
const DEFAULT_MIN_HOLD_MS = clampNumber(process.env.MIN_HOLD_MS, 90_000, 0, 600_000);
const DEFAULT_FLIP_DEADBAND_PCT = clampNumber(process.env.FLIP_DEADBAND_PCT, 0.003, 0, 0.05);
const DEFAULT_FLIP_HYSTERESIS = clampNumber(process.env.FLIP_HYSTERESIS, 0.15, 0, 1);
const DEFAULT_FLIP_CONFIRM_TICKS = Math.max(1, Math.trunc(clampNumber(process.env.FLIP_CONFIRM_TICKS, 3, 1, 20)));
const DEFAULT_ADDON_MIN_UPNL_PCT = clampNumber(process.env.ADDON_MIN_UPNL_PCT, 0.0025, 0, 0.05);
const DEFAULT_ADDON_SIGNAL_MIN = clampNumber(process.env.ADDON_SIGNAL_MIN, 60, 0, 100);
const DEFAULT_ADDON_COOLDOWN_MS = clampNumber(process.env.ADDON_COOLDOWN_MS, 60_000, 0, 600_000);
const DEFAULT_ADDON_MAX_COUNT = Math.max(0, Math.trunc(clampNumber(process.env.ADDON_MAX_COUNT, 3, 0, 10)));
const DEFAULT_ADDON_TTL_MS = Math.max(1000, Math.trunc(clampNumber(process.env.ADDON_TTL_MS, 15_000, 1000, 120_000)));
const DEFAULT_ADDON_REPRICE_MAX = Math.max(0, Math.trunc(clampNumber(process.env.ADDON_REPRICE_MAX, 2, 0, 5)));
const DEFAULT_TRAIL_ATR_MULT = clampNumber(process.env.TRAIL_ATR_MULT, 3.8, 0.5, 10);
const DEFAULT_TRAIL_ACTIVATE_R = clampNumber(process.env.TRAIL_ACTIVATE_R, 3.0, 0.5, 10);
const DEFAULT_TRAIL_CONFIRM_TICKS = Math.max(1, Math.trunc(clampNumber(process.env.TRAIL_CONFIRM_TICKS, 4, 1, 20)));
const DEFAULT_TRAIL_MIN_HOLD_MS = Math.max(0, Math.trunc(clampNumber(process.env.TRAIL_MIN_HOLD_MS, 180_000, 0, 1_800_000)));
const DEFAULT_MAX_SPREAD_PCT = clampNumber(process.env.MAX_SPREAD_PCT, 0.0008, 0, 0.01);
const DEFAULT_AI_MAX_MARGIN_USAGE_PCT = clampNumber(process.env.AI_MAX_MARGIN_USAGE_PCT, 0.85, 0.3, 0.98);
const DEFAULT_AI_MAX_POSITION_NOTIONAL = clampNumber(process.env.AI_MAX_POSITION_NOTIONAL_USDT, DEFAULT_MAX_NOTIONAL, 10, 10_000_000);
const DEFAULT_AI_DAILY_LOSS_LOCK_PCT = clampNumber(process.env.AI_DAILY_LOSS_LOCK_PCT, 0.05, 0.005, 0.5);

function parseLimitStrategy(input: string): LimitStrategyMode {
  switch (input) {
    case 'PASSIVE':
      return 'PASSIVE';
    case 'SPLIT':
      return 'SPLIT';
    case 'AGGRESSIVE':
      return 'AGGRESSIVE';
    default:
      return 'MARKET';
  }
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase();
}

function roundTo(value: number, decimals: number): number {
  const m = Math.pow(10, Math.max(0, decimals));
  return Math.round(value * m) / m;
}

function normalizeSymbols(input: { symbols?: string[]; symbol?: string }): string[] {
  const out: string[] = [];
  if (Array.isArray(input.symbols)) {
    for (const raw of input.symbols) {
      const s = normalizeSymbol(String(raw || ''));
      if (s && !out.includes(s)) out.push(s);
    }
  }
  if (out.length === 0 && input.symbol) {
    const s = normalizeSymbol(input.symbol);
    if (s) out.push(s);
  }
  return out;
}

export class DryRunSessionService {
  private running = false;
  private runId: string | null = null;
  private runCounter = 0;
  private consoleSeq = 0;

  private config: DryRunSessionStatus['config'] = null;
  private symbols: string[] = [];
  private sessions = new Map<string, SymbolSession>();
  private logTail: DryRunConsoleLog[] = [];
  private limitStrategy: LimitOrderStrategy;
  private readonly alertService?: AlertService;
  private readonly sessionStore: SessionStore;
  private readonly tradeLogger?: DryRunTradeLogger;
  private readonly tradeLogEnabled: boolean;
  private readonly clock = new DryRunClock();
  private readonly winnerManager: WinnerManager;
  private readonly addOnManager: AddOnManager;

  constructor(alertService?: AlertService) {
    this.limitStrategy = new LimitOrderStrategy({
      mode: parseLimitStrategy(DEFAULT_LIMIT_STRATEGY),
      splitLevels: 3,
      passiveOffsetBps: 2,
      maxSlices: 4,
    });
    this.winnerManager = new WinnerManager({
      trailAtrMult: DEFAULT_TRAIL_ATR_MULT,
      rAtrMult: DEFAULT_STOP_ATR_MULT,
      minRDistance: DEFAULT_STOP_MIN_DIST,
      trailActivateR: DEFAULT_TRAIL_ACTIVATE_R,
      trailConfirmTicks: DEFAULT_TRAIL_CONFIRM_TICKS,
      minHoldMs: DEFAULT_TRAIL_MIN_HOLD_MS,
    });
    this.addOnManager = new AddOnManager({
      minUnrealizedPnlPct: DEFAULT_ADDON_MIN_UPNL_PCT,
      signalMin: DEFAULT_ADDON_SIGNAL_MIN,
      cooldownMs: DEFAULT_ADDON_COOLDOWN_MS,
      maxCount: DEFAULT_ADDON_MAX_COUNT,
      ttlMs: DEFAULT_ADDON_TTL_MS,
      maxSpreadPct: DEFAULT_MAX_SPREAD_PCT,
      maxNotional: DEFAULT_MAX_NOTIONAL,
    });
    this.alertService = alertService;
    this.sessionStore = new SessionStore();
    this.tradeLogEnabled = !['false', '0', 'no'].includes(DEFAULT_TRADE_LOG_ENABLED);
    if (this.tradeLogEnabled) {
      this.tradeLogger = new DryRunTradeLogger({
        dir: DEFAULT_TRADE_LOG_DIR,
        queueLimit: finiteOr(DEFAULT_TRADE_LOG_QUEUE, 10000),
        dropHaltThreshold: finiteOr(DEFAULT_TRADE_LOG_DROP, 2000),
        onDropSpike: (count) => {
          this.addConsoleLog('WARN', null, `Dry Run log backlog dropped ${count} events`, this.clock.now());
        },
      });
    }
  }

  start(input: DryRunSessionStartInput): DryRunSessionStatus {
    const symbols = normalizeSymbols(input);
    if (symbols.length === 0) {
      throw new Error('symbols_required');
    }

    const walletBalanceStartUsdt = finiteOr(input.walletBalanceStartUsdt, 5000);
    const initialMarginUsdt = finiteOr(input.initialMarginUsdt, 200);
    const leverage = finiteOr(input.leverage, 10);

    if (!(walletBalanceStartUsdt > 0)) throw new Error('wallet_balance_start_must_be_positive');
    if (!(initialMarginUsdt > 0)) throw new Error('initial_margin_must_be_positive');
    if (!(leverage > 0)) throw new Error('leverage_must_be_positive');

    this.runCounter += 1;
    const runIdBase = String(input.runId || `dryrun-${this.runCounter}`);
    const makerFeeRate = finiteOr(input.makerFeeRate, DEFAULT_MAKER_FEE_RATE);
    const takerFeeRate = finiteOr(input.takerFeeRate, DEFAULT_TAKER_FEE_RATE);
    const maintenanceMarginRate = finiteOr(input.maintenanceMarginRate, DEFAULT_MAINTENANCE_MARGIN_RATE);
    const fundingIntervalMs = Math.max(1, Math.trunc(finiteOr(input.fundingIntervalMs, DEFAULT_FUNDING_INTERVAL_MS)));
    const heartbeatIntervalMs = Math.max(1_000, Math.trunc(finiteOr(input.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS)));
    const debugAggressiveEntry = Boolean(input.debugAggressiveEntry);

    this.running = true;
    this.runId = runIdBase;
    this.symbols = [...symbols];
    this.sessions.clear();
    this.logTail = [];
    this.consoleSeq = 0;

    this.config = {
      walletBalanceStartUsdt,
      initialMarginUsdt,
      leverage,
      makerFeeRate,
      takerFeeRate,
      maintenanceMarginRate,
      fundingIntervalMs,
      heartbeatIntervalMs,
      debugAggressiveEntry,
    };

    for (const symbol of this.symbols) {
      const fundingRate = Number.isFinite(input.fundingRates?.[symbol] as number)
        ? Number(input.fundingRates?.[symbol])
        : finiteOr(input.fundingRate, DEFAULT_FUNDING_RATE);

      const cfg: DryRunConfig = {
        runId: `${runIdBase}-${symbol}`,
        walletBalanceStartUsdt,
        initialMarginUsdt,
        leverage,
        makerFeeRate,
        takerFeeRate,
        maintenanceMarginRate,
        fundingRate,
        fundingIntervalMs,
        proxy: {
          mode: 'backend-proxy',
          restBaseUrl: 'https://fapi.binance.com',
          marketWsBaseUrl: 'wss://fstream.binance.com/stream',
        },
      };

      const engine = new DryRunEngine(cfg);
      const lastState = engine.getStateSnapshot();
      this.sessions.set(symbol, {
        symbol,
        engine,
        fundingRate,
        lastEventTimestampMs: 0,
        lastState,
        lastOrderBook: { bids: [], asks: [] },
        latestMarkPrice: 0,
        lastMarkPrice: 0,
        atr: 0,
        avgAtr: 0,
        priceHistory: [],
        obi: 0,
        volatilityRegime: 'MEDIUM',
        winStreak: 0,
        lossStreak: 0,
        dynamicLeverage: leverage,
        stopLossPrice: null,
        winnerState: null,
        flipGovernor: new FlipGovernor(),
        flipState: { partialReduced: false, lastPartialReduceTs: 0 },
        addOnState: {
          count: 0,
          lastAddOnTs: 0,
          pendingClientOrderId: null,
          pendingAddonIndex: null,
          pendingAttempt: 0,
          filledClientOrderIds: new Set<string>(),
        },
        lastEntryOrAddOnTs: 0,
        lastSignal: null,
        pendingFlipEntry: null,
        spreadBreachCount: 0,
        performance: new PerformanceCalculator(walletBalanceStartUsdt),
        activeSignal: null,
        lastEntryEventTs: 0,
        lastHeartbeatTs: 0,
        lastDataLogTs: 0,
        lastEmptyBookLogTs: 0,
        lastPerfTs: 0,
        realizedPnl: 0,
        feePaid: 0,
        fundingPnl: 0,
        eventCount: 0,
        manualOrders: [],
        logTail: [],
        pendingEntry: null,
        pendingExitReason: null,
        tradeSeq: 0,
        currentTrade: null,
        lastSnapshotLogTs: 0,
        lastWinnerSignalLogTs: 0,
      });
    }

    this.addConsoleLog('INFO', null, `Dry Run Initialized with pairs: [${this.symbols.join(', ')}]`, 0);
    for (const symbol of this.symbols) {
      this.addConsoleLog('INFO', symbol, `Session ready. Funding rate=${this.sessions.get(symbol)?.fundingRate ?? 0}`, 0);
    }

    return this.getStatus();
  }

  stop(): DryRunSessionStatus {
    if (this.running) {
      this.addConsoleLog('INFO', null, 'Dry Run stopped by user.', 0);
    }
    this.running = false;
    return this.getStatus();
  }

  reset(): DryRunSessionStatus {
    this.running = false;
    this.runId = null;
    this.symbols = [];
    this.config = null;
    this.sessions.clear();
    this.logTail = [];
    this.consoleSeq = 0;
    return this.getStatus();
  }

  async saveSession(sessionId?: string): Promise<void> {
    if (!this.runId) {
      throw new Error('dry_run_not_initialized');
    }
    const id = sessionId || this.runId;
    const payload = {
      runId: this.runId,
      config: this.config,
      symbols: this.symbols,
      status: this.getStatus(),
      sessions: Array.from(this.sessions.values()).map((session) => ({
        symbol: session.symbol,
        lastState: session.lastState,
        latestMarkPrice: session.latestMarkPrice,
        lastMarkPrice: session.lastMarkPrice,
        atr: session.atr,
        avgAtr: session.avgAtr,
        priceHistory: session.priceHistory,
        obi: session.obi,
        volatilityRegime: session.volatilityRegime,
        winStreak: session.winStreak,
        lossStreak: session.lossStreak,
        dynamicLeverage: session.dynamicLeverage,
        stopLossPrice: session.stopLossPrice,
        activeSignal: session.activeSignal,
        performance: session.performance.getMetrics(),
        realizedPnl: session.realizedPnl,
        feePaid: session.feePaid,
        fundingPnl: session.fundingPnl,
        eventCount: session.eventCount,
        lastEventTimestampMs: session.lastEventTimestampMs,
      })),
    };
    await this.sessionStore.save(id, payload);
  }

  async loadSession(sessionId: string): Promise<DryRunSessionStatus> {
    const stored = await this.sessionStore.load(sessionId);
    if (!stored) {
      throw new Error('dry_run_session_not_found');
    }
    const payload: any = stored.payload;
    if (!payload?.config || !Array.isArray(payload?.symbols)) {
      throw new Error('dry_run_session_invalid');
    }

    this.running = false;
    const config = payload.config as NonNullable<DryRunSessionStatus['config']>;
    this.runId = payload.runId || sessionId;
    this.symbols = [...payload.symbols];
    this.config = config;
    this.sessions.clear();

    for (const symbol of this.symbols) {
      const sessionSnapshot = payload.sessions?.find((s: any) => s.symbol === symbol);
      const cfg: DryRunConfig = {
        runId: `${this.runId}-${symbol}`,
        walletBalanceStartUsdt: config.walletBalanceStartUsdt,
        initialMarginUsdt: config.initialMarginUsdt,
        leverage: config.leverage,
        makerFeeRate: Number.isFinite(config.makerFeeRate) ? config.makerFeeRate : DEFAULT_MAKER_FEE_RATE,
        takerFeeRate: config.takerFeeRate,
        maintenanceMarginRate: config.maintenanceMarginRate,
        fundingRate: 0,
        fundingIntervalMs: config.fundingIntervalMs,
        proxy: {
          mode: 'backend-proxy',
          restBaseUrl: 'https://fapi.binance.com',
          marketWsBaseUrl: 'wss://fstream.binance.com/stream',
        },
      };
      const engine = new DryRunEngine(cfg);
      if (sessionSnapshot?.lastState) {
        engine.restoreState(sessionSnapshot.lastState);
      }
      const perf = new PerformanceCalculator(config.walletBalanceStartUsdt);
      if (sessionSnapshot?.performance) {
        perf.restore(sessionSnapshot.performance);
      }
      this.sessions.set(symbol, {
        symbol,
        engine,
        fundingRate: 0,
        lastEventTimestampMs: sessionSnapshot?.lastEventTimestampMs || 0,
        lastState: sessionSnapshot?.lastState || engine.getStateSnapshot(),
        lastOrderBook: { bids: [], asks: [] },
        latestMarkPrice: sessionSnapshot?.latestMarkPrice || 0,
        lastMarkPrice: sessionSnapshot?.lastMarkPrice || 0,
        atr: sessionSnapshot?.atr || 0,
        avgAtr: sessionSnapshot?.avgAtr || 0,
        priceHistory: sessionSnapshot?.priceHistory || [],
        obi: sessionSnapshot?.obi || 0,
        volatilityRegime: sessionSnapshot?.volatilityRegime || 'MEDIUM',
        winStreak: sessionSnapshot?.winStreak || 0,
        lossStreak: sessionSnapshot?.lossStreak || 0,
        dynamicLeverage: sessionSnapshot?.dynamicLeverage || config.leverage,
        stopLossPrice: sessionSnapshot?.stopLossPrice ?? null,
        winnerState: null,
        flipGovernor: new FlipGovernor(),
        flipState: { partialReduced: false, lastPartialReduceTs: 0 },
        addOnState: {
          count: 0,
          lastAddOnTs: 0,
          pendingClientOrderId: null,
          pendingAddonIndex: null,
          pendingAttempt: 0,
          filledClientOrderIds: new Set<string>(),
        },
        lastEntryOrAddOnTs: 0,
        lastSignal: null,
        pendingFlipEntry: null,
        spreadBreachCount: 0,
        performance: perf,
        activeSignal: sessionSnapshot?.activeSignal ?? null,
        lastEntryEventTs: 0,
        lastHeartbeatTs: 0,
        lastDataLogTs: 0,
        lastEmptyBookLogTs: 0,
        lastPerfTs: 0,
        realizedPnl: sessionSnapshot?.realizedPnl || 0,
        feePaid: sessionSnapshot?.feePaid || 0,
        fundingPnl: sessionSnapshot?.fundingPnl || 0,
        eventCount: sessionSnapshot?.eventCount || 0,
        manualOrders: [],
        logTail: [],
        pendingEntry: null,
        pendingExitReason: null,
        tradeSeq: 0,
        currentTrade: null,
        lastSnapshotLogTs: 0,
        lastWinnerSignalLogTs: 0,
      });
    }

    return this.getStatus();
  }

  async listSessions(): Promise<string[]> {
    return this.sessionStore.list();
  }

  getActiveSymbols(): string[] {
    return this.running ? [...this.symbols] : [];
  }

  isTrackingSymbol(symbol: string): boolean {
    const normalized = normalizeSymbol(symbol);
    return this.running && this.sessions.has(normalized);
  }

  submitManualTestOrder(symbol: string, side: 'BUY' | 'SELL' = 'BUY'): DryRunSessionStatus {
    const normalized = normalizeSymbol(symbol);
    const session = this.sessions.get(normalized);
    if (!this.running || !session || !this.config) {
      throw new Error('dry_run_not_running_for_symbol');
    }

    const referencePrice = session.latestMarkPrice > 0
      ? session.latestMarkPrice
      : (session.lastState.position?.entryPrice || 1);
    const qty = roundTo((this.config.initialMarginUsdt * this.config.leverage) / referencePrice, 6);
    if (!(qty > 0)) {
      throw new Error('manual_test_qty_invalid');
    }

    const nowMs = this.clock.now();
    session.manualOrders.push({
      side,
      type: 'MARKET',
      qty,
      timeInForce: 'IOC',
      reduceOnly: false,
      reasonCode: 'ENTRY_MARKET',
      clientOrderId: `manual-${this.getRunId()}-${normalized}-${nowMs}`,
    });

    session.pendingEntry = {
      reason: 'MANUAL_TEST',
      signalType: null,
      signalScore: null,
      candidate: null,
      orderflow: this.buildOrderflowMetrics(undefined, session),
      market: this.buildMarketMetrics({ price: referencePrice }, session),
      timestampMs: nowMs,
      leverage: this.config.leverage,
    };

    this.addConsoleLog('INFO', normalized, `Manual test order queued: ${side} ${qty}`, session.lastEventTimestampMs);
    return this.getStatus();
  }

  submitStrategySignal(symbol: string, signal: StrategySignal, timestampMs?: number): void {
    if (!signal.signal) return;
    const side = signal.signal.includes('LONG') ? 'LONG' : signal.signal.includes('SHORT') ? 'SHORT' : null;
    if (!side) return;
    const ts = Number.isFinite(timestampMs as number) ? Number(timestampMs) : this.clock.now();
    const decision: StrategyDecision = {
      symbol,
      timestampMs: ts,
      regime: 'TR',
      dfs: signal.score,
      dfsPercentile: clampNumber(signal.score / 100, 0, 0, 1),
      volLevel: 0.5,
      gatePassed: true,
      reasons: ['ENTRY_TR'],
      actions: [{
        type: StrategyActionType.ENTRY,
        side: side as StrategySide,
        reason: 'ENTRY_TR',
        expectedPrice: signal.candidate?.entryPrice ?? signal.market?.price ?? null,
      }],
      log: {
        timestampMs: ts,
        symbol,
        regime: 'TR',
        gate: { passed: true, reason: null, details: {} },
        dfs: signal.score,
        dfsPercentile: clampNumber(signal.score / 100, 0, 0, 1),
        volLevel: 0.5,
        thresholds: { longEntry: 0.85, longBreak: 0.55, shortEntry: 0.15, shortBreak: 0.45 },
        reasons: ['ENTRY_TR'],
        actions: [{
          type: StrategyActionType.ENTRY,
          side: side as StrategySide,
          reason: 'ENTRY_TR',
          expectedPrice: signal.candidate?.entryPrice ?? signal.market?.price ?? null,
        }],
        stats: {},
      },
    };
    this.submitStrategyDecision(symbol, decision, ts);
  }

  submitStrategyDecision(symbol: string, decision: StrategyDecision, timestampMs?: number): DryRunOrderRequest[] {
    const normalized = normalizeSymbol(symbol);
    const session = this.sessions.get(normalized);
    if (!this.running || !session || !this.config) return [];

    const decisionTs = Number.isFinite(timestampMs as number) ? Number(timestampMs) : this.clock.now();
    this.clock.set(decisionTs);
    const createdOrders: DryRunOrderRequest[] = [];

    const queueOrder = (order: DryRunOrderRequest) => {
      session.manualOrders.push(order);
      createdOrders.push(order);
    };

    for (const action of decision.actions) {
      if (action.type === StrategyActionType.NOOP) continue;

      const position = session.lastState.position;
      const actionSide = action.side || null;
      const desiredOrderSide = actionSide === 'LONG' ? 'BUY' : actionSide === 'SHORT' ? 'SELL' : null;
      const aiPlan = this.extractAIPlan(action.metadata);
      const entryStyle = this.normalizeAIEntryStyle(aiPlan?.entryStyle);
      const urgencyLevel = this.normalizeAIUrgency(aiPlan?.urgency);
      const spreadPct = this.computeSpreadPct(session.lastOrderBook);
      const volatility = session.atr || decision.volLevel || 0;
      const laddersRequested = Math.max(0, Math.min(5, Math.trunc(Number(aiPlan?.maxAdds ?? 2))));

      if (action.type === StrategyActionType.ENTRY && desiredOrderSide) {
        // AI decided to ENTRY. Handle existing position if any.
        if (position && position.side !== actionSide) {
          const closeQty = roundTo(position.qty, 6);
          if (closeQty > 0) {
            const closeOrder = this.buildAiLimitOrder(
              session,
              position.side === 'LONG' ? 'SELL' : 'BUY',
              closeQty,
              true,
              'AI_REVERSAL_EXIT'
            );
            if (closeOrder) {
              queueOrder(closeOrder);
              this.addConsoleLog('INFO', normalized, `AI reversal: closing ${position.side} before ${actionSide}`, session.lastEventTimestampMs);
            }
          }
        }

        if (position && position.side === actionSide) {
          const referencePrice = Number(action.expectedPrice) || session.latestMarkPrice || position.entryPrice;
          const sizing = this.computeRiskSizing(session, referencePrice, decision.regime, action.sizeMultiplier || 0.5, {
            mode: 'ADD',
          });
          if (sizing.qty > 0) {
            session.engine.setLeverageOverride(sizing.leverage);
            const addOrders = this.limitStrategy.buildEntryOrders({
              side: desiredOrderSide,
              qty: sizing.qty,
              markPrice: referencePrice,
              orderBook: session.lastOrderBook,
              entryStyle: 'LIMIT',
              urgencyLevel,
              spreadPct,
              volatility,
              ladderCount: laddersRequested,
            });
            for (const order of addOrders) {
              queueOrder({ ...order, reasonCode: 'AI_ADD' });
            }
            session.addOnState.count += 1;
            session.addOnState.lastAddOnTs = decisionTs;
            this.addConsoleLog('INFO', normalized, `AI add ${actionSide} +${sizing.qty}`, session.lastEventTimestampMs);
          }
          continue;
        }

        const referencePrice = Number(action.expectedPrice) || session.latestMarkPrice || 0;
        if (!(referencePrice > 0)) continue;
        const sizing = this.computeRiskSizing(session, referencePrice, decision.regime, action.sizeMultiplier || 1, {
          mode: 'ENTRY',
        });
        if (!(sizing.qty > 0)) continue;
        session.engine.setLeverageOverride(sizing.leverage);
        const entryOrders = this.limitStrategy.buildEntryOrders({
          side: desiredOrderSide,
          qty: sizing.qty,
          markPrice: referencePrice,
          orderBook: session.lastOrderBook,
          entryStyle,
          urgencyLevel,
          spreadPct,
          volatility,
          ladderCount: laddersRequested,
        });
        for (const order of entryOrders) {
          queueOrder({ ...order, reasonCode: 'AI_ENTRY' });
        }
        session.lastEntryEventTs = decisionTs;
        this.addConsoleLog('INFO', normalized, `AI entry ${actionSide} ${sizing.qty} @ ~${referencePrice}`, session.lastEventTimestampMs);
        continue;
      }

      if (action.type === StrategyActionType.ADD) {
        const currentPosition = session.lastState.position;
        if (!currentPosition) continue;
        const currentSide = currentPosition.side === 'LONG' ? 'BUY' : 'SELL';
        const referencePrice = Number(action.expectedPrice) || session.latestMarkPrice || currentPosition.entryPrice;
        const sizing = this.computeRiskSizing(session, referencePrice, decision.regime, action.sizeMultiplier || 0.5, {
          mode: 'ADD',
        });
        if (!(sizing.qty > 0)) continue;
        session.engine.setLeverageOverride(sizing.leverage);
        const addOrders = this.limitStrategy.buildEntryOrders({
          side: currentSide,
          qty: sizing.qty,
          markPrice: referencePrice,
          orderBook: session.lastOrderBook,
          entryStyle,
          urgencyLevel,
          spreadPct,
          volatility,
          ladderCount: laddersRequested,
        });
        for (const order of addOrders) {
          queueOrder({ ...order, reasonCode: 'AI_ADD' });
        }
        session.addOnState.count += 1;
        session.addOnState.lastAddOnTs = decisionTs;
        this.addConsoleLog('INFO', normalized, `AI add to ${currentPosition.side} +${sizing.qty}`, session.lastEventTimestampMs);
        continue;
      }

      if (action.type === StrategyActionType.REDUCE && position) {
        const reducePct = clampNumber(Number(action.reducePct ?? 0.5), 0.5, 0.1, 1);
        const reduceQty = roundTo(position.qty * reducePct, 6);
        if (!(reduceQty > 0)) continue;
        const reduceOrder = this.buildAiLimitOrder(
          session,
          position.side === 'LONG' ? 'SELL' : 'BUY',
          reduceQty,
          true,
          'AI_REDUCE'
        );
        if (reduceOrder) {
          queueOrder(reduceOrder);
          this.addConsoleLog('INFO', normalized, `AI reduce ${position.side} -${reduceQty} (${(reducePct * 100).toFixed(0)}%)`, session.lastEventTimestampMs);
        }
        continue;
      }

      if (action.type === StrategyActionType.EXIT && position) {
        const exitQty = roundTo(position.qty, 6);
        if (!(exitQty > 0)) continue;
        const exitOrder = this.buildAiLimitOrder(
          session,
          position.side === 'LONG' ? 'SELL' : 'BUY',
          exitQty,
          true,
          'AI_EXIT'
        );
        if (exitOrder) {
          queueOrder(exitOrder);
          this.addConsoleLog('INFO', normalized, `AI exit ${position.side} completely`, session.lastEventTimestampMs);
          session.pendingExitReason = action.reason;
        }
      }
    }

    return createdOrders;
  }

  getStrategyPosition(symbol: string): StrategyPositionState | null {
    const normalized = normalizeSymbol(symbol);
    const session = this.sessions.get(normalized);
    if (!session || !session.lastState.position) return null;
    const pos = session.lastState.position;
    const markPrice = session.latestMarkPrice || pos.entryPrice;
    return {
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      unrealizedPnlPct: this.computeUnrealizedPnlPct(session, markPrice),
      addsUsed: session.addOnState?.count ?? 0,
      timeInPositionMs: this.computePositionTimeInMs(session, Number(this.clock.now())),
      peakPnlPct: undefined,
    };
  }

  getAIDryRunRiskState(symbol: string, timestampMs?: number): {
    equity: number;
    leverage: number;
    startingMarginUser: number;
    marginInUse: number;
    drawdownPct: number;
    dailyLossLock: boolean;
    cooldownMsRemaining: number;
  } {
    const normalized = normalizeSymbol(symbol);
    const session = this.sessions.get(normalized);
    const nowMs = Number.isFinite(timestampMs as number) ? Number(timestampMs) : this.clock.now();
    if (!session || !this.config) {
      return {
        equity: 0,
        leverage: this.config?.leverage ?? 0,
        startingMarginUser: this.config?.initialMarginUsdt ?? 0,
        marginInUse: 0,
        drawdownPct: 0,
        dailyLossLock: false,
        cooldownMsRemaining: 0,
      };
    }

    const markPrice = session.latestMarkPrice || session.lastState.position?.entryPrice || 0;
    const unrealized = this.computeUnrealizedPnl(session);
    const equity = session.lastState.walletBalance + unrealized;
    const leverage = session.dynamicLeverage || this.config.leverage || 1;
    const marginInUse = session.lastState.position && markPrice > 0
      ? Math.abs(session.lastState.position.qty * markPrice) / Math.max(1, leverage)
      : 0;
    const equityStart = this.config.walletBalanceStartUsdt;
    const drawdownPct = equityStart > 0 ? (equity - equityStart) / equityStart : 0;
    const dailyLossLock = false;
    const cooldownMsRemaining = 0;

    return {
      equity: roundTo(equity, 8),
      leverage: roundTo(leverage, 4),
      startingMarginUser: roundTo(this.config.initialMarginUsdt, 8),
      marginInUse: roundTo(Math.max(0, marginInUse), 8),
      drawdownPct: roundTo(drawdownPct, 8),
      dailyLossLock,
      cooldownMsRemaining,
    };
  }

  getAIDryRunExecutionState(symbol: string, timestampMs?: number): {
    lastAction: 'NONE' | 'HOLD' | 'ENTER' | 'MANAGE' | 'EXIT';
    holdStreak: number;
    lastAddMsAgo: number | null;
    lastFlipMsAgo: number | null;
    winnerStopArmed?: boolean;
    winnerStopType?: 'TRAIL_STOP' | 'PROFITLOCK' | null;
    winnerStopPrice?: number | null;
    winnerRMultiple?: number | null;
  } {
    const normalized = normalizeSymbol(symbol);
    const session = this.sessions.get(normalized);
    const nowMs = Number.isFinite(timestampMs as number) ? Number(timestampMs) : this.clock.now();
    if (!session) {
      return {
        lastAction: 'NONE',
        holdStreak: 0,
        lastAddMsAgo: null,
        lastFlipMsAgo: null,
        winnerStopArmed: false,
        winnerStopType: null,
        winnerStopPrice: null,
        winnerRMultiple: null,
      };
    }

    let lastAction: 'NONE' | 'HOLD' | 'ENTER' | 'MANAGE' | 'EXIT' = 'NONE';
    if (session.pendingExitReason) {
      lastAction = 'EXIT';
    } else if (session.addOnState.lastAddOnTs > 0 && session.addOnState.lastAddOnTs >= session.lastEntryEventTs) {
      lastAction = 'MANAGE';
    } else if (session.lastEntryEventTs > 0) {
      lastAction = 'ENTER';
    }

    const winnerState = session.winnerState;
    const winnerStopPrice = session.stopLossPrice ? roundTo(session.stopLossPrice, 8) : null;
    const winnerRMultiple = winnerState && winnerState.rDistance > 0 && session.latestMarkPrice > 0
      ? roundTo(
        ((winnerState.side === 'LONG' ? 1 : -1) * (session.latestMarkPrice - winnerState.entryPrice)) / winnerState.rDistance,
        4
      )
      : null;
    const winnerStopType = winnerState?.trailingStop != null ? 'TRAIL_STOP' : winnerState?.profitLockStop != null ? 'PROFITLOCK' : null;

    return {
      lastAction,
      holdStreak: 0,
      lastAddMsAgo: session.addOnState.lastAddOnTs > 0 ? Math.max(0, nowMs - session.addOnState.lastAddOnTs) : null,
      lastFlipMsAgo: session.flipState.lastPartialReduceTs > 0 ? Math.max(0, nowMs - session.flipState.lastPartialReduceTs) : null,
      winnerStopArmed: Boolean(winnerStopPrice != null),
      winnerStopType,
      winnerStopPrice,
      winnerRMultiple,
    };
  }

  ingestDepthEvent(input: {
    symbol: string;
    eventTimestampMs: number;
    orderBook: DryRunOrderBook;
    markPrice?: number;
  }): DryRunSessionStatus | null {
    if (!this.running || !this.config) return null;

    const symbol = normalizeSymbol(input.symbol);
    const session = this.sessions.get(symbol);
    if (!session) return null;

    const eventTimestampMs = Number(input.eventTimestampMs);
    if (!Number.isFinite(eventTimestampMs) || eventTimestampMs <= 0) return null;
    if (session.lastEventTimestampMs > 0 && eventTimestampMs <= session.lastEventTimestampMs) return null;
    if (session.lastEventTimestampMs > 0 && (eventTimestampMs - session.lastEventTimestampMs) < DEFAULT_EVENT_INTERVAL_MS) {
      return null;
    }
    this.clock.set(eventTimestampMs);

    const book = this.normalizeBook(input.orderBook);
    session.lastOrderBook = book;
    if (book.bids.length === 0 || book.asks.length === 0) {
      if (session.lastEmptyBookLogTs === 0 || (eventTimestampMs - session.lastEmptyBookLogTs) >= this.config.heartbeatIntervalMs) {
        this.addConsoleLog('WARN', symbol, 'Orderbook empty on one side. Waiting for full depth.', eventTimestampMs);
        session.lastEmptyBookLogTs = eventTimestampMs;
      }
      return null;
    }

    const bestBid = book.bids[0].price;
    const bestAsk = book.asks[0].price;
    const resolvedMarkPriceRaw = Number.isFinite(input.markPrice as number) && Number(input.markPrice) > 0
      ? Number(input.markPrice)
      : (bestBid + bestAsk) / 2;
    const markPrice = roundTo(resolvedMarkPriceRaw, 8);
    if (!(markPrice > 0)) return null;

    this.updateDerivedMetrics(session, book, markPrice);
    const spreadPct = this.computeSpreadPct(book);
    if (spreadPct != null && spreadPct > DEFAULT_MAX_SPREAD_PCT) {
      session.spreadBreachCount += 1;
    } else {
      session.spreadBreachCount = 0;
    }

    const prevPosition = session.lastState.position;
    const orders = this.buildDeterministicOrders(session, markPrice, eventTimestampMs);
    const event: DryRunEventInput = {
      timestampMs: eventTimestampMs,
      markPrice,
      orderBook: book,
      orders,
    };

    const out = session.engine.processEvent(event);

    const lastCheckMs = session.lastHeartbeatTs > 0 ? eventTimestampMs - session.lastHeartbeatTs : eventTimestampMs;
    session.lastEventTimestampMs = eventTimestampMs;
    session.lastState = out.state;
    session.lastMarkPrice = session.latestMarkPrice;
    session.latestMarkPrice = markPrice;
    session.realizedPnl += out.log.realizedPnl;
    session.feePaid += out.log.fee;
    session.fundingPnl += out.log.fundingImpact;
    session.eventCount += 1;
    session.logTail.push(out.log);
    if (session.logTail.length > ENGINE_LOG_TAIL_LIMIT) {
      session.logTail = session.logTail.slice(session.logTail.length - ENGINE_LOG_TAIL_LIMIT);
    }

    if (out.log.realizedPnl !== 0) {
      if (out.log.realizedPnl > 0) {
        session.winStreak += 1;
        session.lossStreak = 0;
      } else {
        session.lossStreak += 1;
        session.winStreak = 0;
      }
      const equity = session.lastState.walletBalance + this.computeUnrealizedPnl(session);
      session.performance.recordTrade({
        realizedPnl: out.log.realizedPnl,
        equity,
      });
      session.lastPerfTs = eventTimestampMs;

      if (this.alertService && out.log.realizedPnl <= -DEFAULT_LARGE_LOSS_ALERT) {
        this.alertService.send('LARGE_LOSS', `${symbol}: realized PnL ${roundTo(out.log.realizedPnl, 2)} USDT`, 'HIGH');
      }
    }

    if (out.log.realizedPnl === 0) {
      const equity = session.lastState.walletBalance + this.computeUnrealizedPnl(session);
      if (session.lastPerfTs === 0 || (eventTimestampMs - session.lastPerfTs) >= DEFAULT_PERF_SAMPLE_MS) {
        session.performance.recordEquity(equity);
        session.lastPerfTs = eventTimestampMs;
      }
    }

    if (prevPosition && !out.state.position && session.activeSignal) {
      session.activeSignal = null;
    }

    if (session.lastDataLogTs === 0 || (eventTimestampMs - session.lastDataLogTs) >= 2_000) {
      this.addConsoleLog('INFO', symbol, `Market Data Received: ${symbol} @ ${markPrice}`, eventTimestampMs);
      session.lastDataLogTs = eventTimestampMs;
    }

    if (session.lastHeartbeatTs === 0 || (eventTimestampMs - session.lastHeartbeatTs) >= this.config.heartbeatIntervalMs) {
      const seconds = Math.max(1, Math.floor(lastCheckMs / 1000));
      this.addConsoleLog(
        'INFO',
        symbol,
        `Running... Scanning ${symbol}. Current Price: ${markPrice}. Last Check: ${seconds}s ago.`,
        eventTimestampMs
      );
      session.lastHeartbeatTs = eventTimestampMs;
    }

    if (out.log.fundingImpact !== 0) {
      this.addConsoleLog('INFO', symbol, `Funding applied: ${roundTo(out.log.fundingImpact, 8)} USDT`, eventTimestampMs);
    }

    if (out.log.orderResults.length > 0) {
      for (const order of out.log.orderResults) {
        this.addConsoleLog(
          'INFO',
          symbol,
          `Order ${order.type}/${order.side} ${order.status} fill=${roundTo(order.filledQty, 6)}/${roundTo(order.requestedQty, 6)} avg=${roundTo(order.avgFillPrice, 4)}`,
          eventTimestampMs
        );
      }
    }

    if (out.log.liquidationTriggered) {
      this.addConsoleLog('WARN', symbol, 'Liquidation triggered. Position force-closed.', eventTimestampMs);
    }

    this.handleOrderActions(session, out.log.orderResults, markPrice, spreadPct, eventTimestampMs);
    this.handleTradeTransitions(session, prevPosition, out.log, out.state.position, eventTimestampMs);
    this.syncPositionStateAfterEvent(session, prevPosition, out.state.position, eventTimestampMs, markPrice);
    this.maybeLogSnapshot(session, eventTimestampMs);

    return this.getStatus();
  }

  getStatus(): DryRunSessionStatus {
    const perSymbol: Record<string, DryRunSymbolStatus> = {};

    let totalEquity = 0;
    let walletBalance = 0;
    let unrealizedPnl = 0;
    let realizedPnl = 0;
    let feePaid = 0;
    let fundingPnl = 0;
    let marginHealth = 0;
    let marginHealthInit = false;
    let totalWins = 0;
    let totalLosses = 0;
    let totalPnL = 0;
    let maxDrawdown = 0;
    let sharpeSum = 0;
    let sharpeCount = 0;

    for (const symbol of this.symbols) {
      const session = this.sessions.get(symbol);
      if (!session) continue;

      const symbolWallet = session.lastState.walletBalance;
      const symbolUnrealized = this.computeUnrealizedPnl(session);
      const symbolEquity = symbolWallet + symbolUnrealized;
      const symbolMarginHealth = session.lastState.marginHealth;

      totalEquity += symbolEquity;
      walletBalance += symbolWallet;
      unrealizedPnl += symbolUnrealized;
      realizedPnl += session.realizedPnl;
      feePaid += session.feePaid;
      fundingPnl += session.fundingPnl;
      if (!marginHealthInit) {
        marginHealth = symbolMarginHealth;
        marginHealthInit = true;
      } else {
        marginHealth = Math.min(marginHealth, symbolMarginHealth);
      }

      const perf = session.performance.getMetrics();
      totalWins += perf.winCount;
      totalLosses += perf.lossCount;
      totalPnL += perf.totalPnL;
      maxDrawdown = Math.max(maxDrawdown, perf.maxDrawdown);
      if (perf.sharpeRatio !== 0) {
        sharpeSum += perf.sharpeRatio;
        sharpeCount += 1;
      }

      perSymbol[symbol] = {
        symbol,
        metrics: {
          markPrice: session.latestMarkPrice,
          totalEquity: roundTo(symbolEquity, 8),
          walletBalance: roundTo(symbolWallet, 8),
          unrealizedPnl: roundTo(symbolUnrealized, 8),
          realizedPnl: roundTo(session.realizedPnl, 8),
          feePaid: roundTo(session.feePaid, 8),
          fundingPnl: roundTo(session.fundingPnl, 8),
          marginHealth: roundTo(symbolMarginHealth, 8),
        },
        performance: perf,
        risk: {
          winStreak: session.winStreak,
          lossStreak: session.lossStreak,
          dynamicLeverage: roundTo(session.dynamicLeverage, 2),
          stopLossPrice: session.stopLossPrice ? roundTo(session.stopLossPrice, 6) : null,
          liquidationRisk: this.computeLiquidationRisk(session, symbolMarginHealth),
        },
        position: session.lastState.position
          ? {
            side: session.lastState.position.side,
            qty: session.lastState.position.qty,
            notionalUsdt: roundTo(Math.abs(session.lastState.position.qty * session.latestMarkPrice), 8),
            entryPrice: session.lastState.position.entryPrice,
            breakEvenPrice: (() => {
              const value = this.computeBreakEvenPrice(session);
              return value == null ? null : roundTo(value, 8);
            })(),
            markPrice: session.latestMarkPrice,
            unrealizedPnl: roundTo(symbolUnrealized, 8),
            realizedPnl: roundTo(session.realizedPnl, 8),
            netPnl: roundTo(symbolUnrealized + session.realizedPnl - session.feePaid + session.fundingPnl, 8),
            liqPrice: null,
          }
          : null,
        openLimitOrders: session.lastState.openLimitOrders,
        lastEventTimestampMs: session.lastEventTimestampMs,
        eventCount: session.eventCount,
      };
    }

    return {
      running: this.running,
      runId: this.runId,
      symbols: [...this.symbols],
      config: this.config,
      summary: {
        totalEquity: roundTo(totalEquity, 8),
        walletBalance: roundTo(walletBalance, 8),
        unrealizedPnl: roundTo(unrealizedPnl, 8),
        realizedPnl: roundTo(realizedPnl, 8),
        feePaid: roundTo(feePaid, 8),
        fundingPnl: roundTo(fundingPnl, 8),
        marginHealth: roundTo(marginHealthInit ? marginHealth : 0, 8),
        performance: {
          totalPnL: roundTo(totalPnL, 8),
          winCount: totalWins,
          lossCount: totalLosses,
          totalTrades: totalWins + totalLosses,
          winRate: totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0,
          maxDrawdown,
          sharpeRatio: sharpeCount > 0 ? sharpeSum / sharpeCount : 0,
          pnlCurve: [],
        },
      },
      perSymbol,
      logTail: [...this.logTail],
      alphaDecay: [],
    };
  }

  private normalizeBook(orderBook: DryRunOrderBook): DryRunOrderBook {
    const depth = Math.max(1, Math.trunc(DEFAULT_ORDERBOOK_DEPTH));
    const normalize = (levels: Array<{ price: number; qty: number }>, asc: boolean) => {
      const sorted = levels
        .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0)
        .map((l) => ({ price: Number(l.price), qty: Number(l.qty) }))
        .sort((a, b) => asc ? a.price - b.price : b.price - a.price);
      return sorted.slice(0, depth);
    };

    return {
      bids: normalize(orderBook.bids || [], false),
      asks: normalize(orderBook.asks || [], true),
    };
  }

  private buildDeterministicOrders(session: SymbolSession, markPrice: number, eventTimestampMs: number): DryRunOrderRequest[] {
    if (!this.config) {
      return [];
    }

    if (session.manualOrders.length > 0) {
      return [session.manualOrders.shift() as DryRunOrderRequest];
    }

    const state = session.lastState;
    const orders: DryRunOrderRequest[] = [];

    // Disable internal random entry if we are waiting for strategy signals?
    // Actually, we can keep debugAggressiveEntry as a "noise" generator if explicitly enabled,
    // but default should be OFF for strategy replication.
    const entryCooldownMs = this.config.debugAggressiveEntry
      ? Math.max(500, Math.trunc(DEFAULT_ENTRY_COOLDOWN_MS / 2))
      : Math.max(0, Math.trunc(DEFAULT_ENTRY_COOLDOWN_MS));
    const hasOpenLimits = state.openLimitOrders.length > 0;

    if (!state.position && !hasOpenLimits) {
      if (session.lastEntryEventTs === 0 || (eventTimestampMs - session.lastEntryEventTs) >= entryCooldownMs) {
        if (session.pendingFlipEntry) {
          const pending = session.pendingFlipEntry;
          const referencePrice = pending.candidate?.entryPrice ?? markPrice;
          if (referencePrice > 0) {
            const sizing = this.computeRiskSizing(session, referencePrice, 'TR');
            const qty = roundTo(Math.max(0, sizing.qty), 6);
            session.engine.setLeverageOverride(sizing.leverage);
            if (qty > 0) {
              const entryOrders = this.limitStrategy.buildEntryOrders({
                side: pending.side,
                qty,
                markPrice: referencePrice,
                orderBook: session.lastOrderBook,
                urgency: Math.min(1, (pending.signalScore || 0) / 100),
              });
              for (const order of entryOrders) {
                orders.push({ ...order, reasonCode: 'ENTRY_MARKET' });
              }
              session.lastEntryEventTs = eventTimestampMs;
              session.pendingEntry = {
                reason: 'STRATEGY_SIGNAL',
                signalType: pending.signalType,
                signalScore: pending.signalScore,
                candidate: pending.candidate,
                orderflow: pending.orderflow,
                boost: pending.boost,
                market: pending.market,
                timestampMs: pending.timestampMs,
                leverage: sizing.leverage,
              };
            }
          }
          session.pendingFlipEntry = null;
          return orders;
        }

        // Only trigger internal random entry if debugAggressiveEntry is TRUE
        if (this.config.debugAggressiveEntry) {
          const side: 'BUY' | 'SELL' = this.resolveEntrySide(session, markPrice);
          const sizing = this.computeRiskSizing(session, markPrice, 'TR');
          const qty = roundTo(Math.max(0, sizing.qty), 6);
          session.engine.setLeverageOverride(sizing.leverage);
          if (qty > 0) {
            const entryOrders = this.limitStrategy.buildEntryOrders({
              side,
              qty,
              markPrice,
              orderBook: session.lastOrderBook,
              urgency: 0.3,
            });
            orders.push(...entryOrders.map((order) => ({ ...order, reasonCode: 'ENTRY_MARKET' as DryRunReasonCode })));
            session.lastEntryEventTs = eventTimestampMs;
            if (!session.pendingEntry) {
              session.pendingEntry = {
                reason: 'DEBUG_AGGRESSIVE_ENTRY',
                signalType: null,
                signalScore: null,
                candidate: null,
                orderflow: this.buildOrderflowMetrics(undefined, session),
                market: this.buildMarketMetrics({ price: markPrice, atr: session.atr, avgAtr: session.avgAtr }, session),
                timestampMs: eventTimestampMs,
                leverage: sizing.leverage,
              };
            }
          }
        }
      }
      return orders;
    }

    if (!state.position) {
      return orders;
    }

    const position = state.position;
    this.ensureWinnerState(session, position, markPrice);
    const positionHoldMs = this.computePositionTimeInMs(session, eventTimestampMs);
    const winnerDecision = this.winnerManager.update(session.winnerState as WinnerState, {
      markPrice,
      atr: session.atr || Math.abs(markPrice - position.entryPrice) * 0.01,
      holdMs: positionHoldMs,
    });
    session.winnerState = winnerDecision.nextState;
    session.stopLossPrice = this.resolveActiveStop(session.winnerState);

    if (winnerDecision.action && position.qty > 0) {
      if (!this.isAIAutonomousRun()) {
        const closeSide: 'BUY' | 'SELL' = position.side === 'LONG' ? 'SELL' : 'BUY';
        orders.push({
          side: closeSide,
          type: 'MARKET',
          qty: roundTo(position.qty, 6),
          timeInForce: 'IOC',
          reduceOnly: true,
          reasonCode: winnerDecision.action === 'TRAIL_STOP' ? 'TRAIL_STOP' : 'PROFITLOCK',
        });
        session.pendingExitReason = winnerDecision.action === 'TRAIL_STOP' ? 'TRAIL_STOP' : 'PROFITLOCK_STOP';
        return orders;
      }

      if (
        session.lastWinnerSignalLogTs === 0
        || (eventTimestampMs - session.lastWinnerSignalLogTs) >= this.config.heartbeatIntervalMs
      ) {
        this.addConsoleLog(
          'INFO',
          session.symbol,
          `Winner stop armed (${winnerDecision.action}) at ${roundTo(winnerDecision.stopPrice ?? markPrice, 4)}; waiting AI decision.`,
          eventTimestampMs
        );
        session.lastWinnerSignalLogTs = eventTimestampMs;
      }
    }

    if (!this.isAIAutonomousRun() && this.shouldRiskEmergency(session, markPrice, this.computeSpreadPct(session.lastOrderBook))) {
      const closeSide: 'BUY' | 'SELL' = position.side === 'LONG' ? 'SELL' : 'BUY';
      orders.push({
        side: closeSide,
        type: 'MARKET',
        qty: roundTo(position.qty, 6),
        timeInForce: 'IOC',
        reduceOnly: true,
        reasonCode: 'RISK_EMERGENCY',
      });
      session.pendingExitReason = 'RISK_EMERGENCY';
      return orders;
    }

    return orders;
  }

  private updateDerivedMetrics(session: SymbolSession, book: DryRunOrderBook, markPrice: number): void {
    session.priceHistory.push(markPrice);
    if (session.priceHistory.length > Math.max(DEFAULT_ATR_WINDOW * 4, 40)) {
      session.priceHistory = session.priceHistory.slice(session.priceHistory.length - Math.max(DEFAULT_ATR_WINDOW * 4, 40));
    }

    if (session.priceHistory.length >= 2) {
      const diffs: number[] = [];
      for (let i = 1; i < session.priceHistory.length; i += 1) {
        diffs.push(Math.abs(session.priceHistory[i] - session.priceHistory[i - 1]));
      }
      const window = diffs.slice(-DEFAULT_ATR_WINDOW);
      const longWindow = diffs.slice(-Math.max(DEFAULT_ATR_WINDOW * 2, 20));
      session.atr = window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : session.atr;
      session.avgAtr = longWindow.length > 0 ? longWindow.reduce((a, b) => a + b, 0) / longWindow.length : session.avgAtr;
    }

    const topLevels = Math.min(10, book.bids.length, book.asks.length);
    let bidVol = 0;
    let askVol = 0;
    for (let i = 0; i < topLevels; i += 1) {
      bidVol += book.bids[i]?.qty ?? 0;
      askVol += book.asks[i]?.qty ?? 0;
    }
    const denom = bidVol + askVol;
    session.obi = denom > 0 ? (bidVol - askVol) / denom : 0;

    const ratio = session.avgAtr > 0 ? session.atr / session.avgAtr : 1;
    session.volatilityRegime = ratio > 1.5 ? 'HIGH' : ratio < 0.7 ? 'LOW' : 'MEDIUM';
  }

  private resolveEntrySide(session: SymbolSession, markPrice: number): 'BUY' | 'SELL' {
    if (session.lastMarkPrice <= 0) {
      return 'BUY';
    }
    return markPrice >= session.lastMarkPrice ? 'BUY' : 'SELL';
  }

  private computeUnrealizedPnl(session: SymbolSession): number {
    if (!session.lastState.position || !(session.latestMarkPrice > 0)) {
      return 0;
    }
    const pos = session.lastState.position;
    if (pos.side === 'LONG') {
      return (session.latestMarkPrice - pos.entryPrice) * pos.qty;
    }
    return (pos.entryPrice - session.latestMarkPrice) * pos.qty;
  }

  private computeLiquidationRisk(session: SymbolSession, marginHealth: number): {
    score: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL';
    timeToLiquidationMs: number | null;
    fundingRateImpact: number;
  } {
    const thresholds = { yellow: 0.3, orange: 0.2, red: 0.1, critical: 0.05 };
    let score: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL' = 'GREEN';
    if (marginHealth <= thresholds.critical) score = 'CRITICAL';
    else if (marginHealth <= thresholds.red) score = 'RED';
    else if (marginHealth <= thresholds.orange) score = 'ORANGE';
    else if (marginHealth <= thresholds.yellow) score = 'YELLOW';

    const positionNotional = session.lastState.position
      ? session.lastState.position.qty * (session.latestMarkPrice || 0)
      : 0;
    const fundingImpact = session.fundingRate * positionNotional;
    const volFactor = session.volatilityRegime === 'HIGH' ? 1.4 : session.volatilityRegime === 'LOW' ? 0.8 : 1;
    const baseMs = 5 * 60 * 1000;
    const timeToLiquidationMs = marginHealth > 0
      ? Math.max(0, Math.round(baseMs * (marginHealth / thresholds.yellow) / volFactor))
      : 0;

    return {
      score,
      timeToLiquidationMs,
      fundingRateImpact: roundTo(fundingImpact, 4),
    };
  }

  private handleTradeTransitions(
    session: SymbolSession,
    prevPosition: DryRunStateSnapshot['position'],
    log: DryRunEventLog,
    nextPosition: DryRunStateSnapshot['position'],
    eventTimestampMs: number
  ): void {
    if (!this.tradeLogger || !this.tradeLogEnabled) return;

    const prevSide = prevPosition?.side ?? null;
    const nextSide = nextPosition?.side ?? null;
    const orderResults = Array.isArray(log.orderResults) ? log.orderResults : [];

    let closingRealized = 0;
    let closingFee = 0;
    let closingQty = 0;
    let closingNotional = 0;
    let openingFee = 0;

    if (prevSide) {
      for (const order of orderResults) {
        const fee = Number.isFinite(order.fee) ? Number(order.fee) : 0;
        const realized = Number.isFinite(order.realizedPnl) ? Number(order.realizedPnl) : 0;
        const filledQty = Number.isFinite(order.filledQty) ? Number(order.filledQty) : 0;
        const avgPrice = Number.isFinite(order.avgFillPrice) ? Number(order.avgFillPrice) : 0;
        if (this.isClosingOrder(prevSide, order.side)) {
          closingFee += fee;
          closingRealized += realized;
          if (filledQty > 0 && avgPrice > 0) {
            closingQty += filledQty;
            closingNotional += filledQty * avgPrice;
          }
        } else {
          openingFee += fee;
        }
      }
    } else {
      for (const order of orderResults) {
        const fee = Number.isFinite(order.fee) ? Number(order.fee) : 0;
        openingFee += fee;
      }
    }

    const fundingImpact = Number.isFinite(log.fundingImpact) ? Number(log.fundingImpact) : 0;
    const liquidation = log.liquidationTriggered || orderResults.some((o) => o.reason === 'FORCED_LIQUIDATION');

    if (prevSide && prevPosition && !session.currentTrade) {
      session.currentTrade = this.buildFallbackTradeFromPosition(session, prevPosition, eventTimestampMs);
    }

    if (!prevSide && nextSide && nextPosition) {
      this.openTrade(session, nextPosition, eventTimestampMs, openingFee);
      return;
    }

    if (prevSide && !nextSide) {
      this.applyTradeAcc(session, closingRealized, closingFee, fundingImpact);
      const exitPrice = closingQty > 0 ? closingNotional / closingQty : session.latestMarkPrice;
      const reason = this.resolveExitReason(session, liquidation, closingRealized, null);
      this.closeTrade(session, eventTimestampMs, exitPrice, prevPosition?.qty || 0, reason);
      return;
    }

    if (prevSide && nextSide && nextPosition) {
      const flipped = prevSide !== nextSide;
      if (flipped) {
        this.applyTradeAcc(session, closingRealized, closingFee, fundingImpact);
        const exitPrice = closingQty > 0 ? closingNotional / closingQty : session.latestMarkPrice;
        const reason = this.resolveExitReason(session, liquidation, closingRealized, 'HARD_INVALIDATION');
        this.closeTrade(session, eventTimestampMs, exitPrice, prevPosition?.qty || 0, reason);
        this.openTrade(session, nextPosition, eventTimestampMs, openingFee);
        return;
      }

      this.applyTradeAcc(session, closingRealized, closingFee + openingFee, fundingImpact);
      this.updateTradePosition(session, nextPosition);
    }
  }

  private openTrade(
    session: SymbolSession,
    position: NonNullable<DryRunStateSnapshot['position']>,
    eventTimestampMs: number,
    openingFee: number
  ): void {
    const context = session.pendingEntry;
    const leverage = context?.leverage || session.dynamicLeverage || this.config?.leverage || 1;
    const entryPrice = Number(position.entryPrice) || 0;
    const qty = Number(position.qty) || 0;
    const notional = entryPrice * qty;
    const marginUsed = leverage > 0 ? notional / leverage : 0;
    const tradeId = `${this.getRunId()}-${session.symbol}-${++session.tradeSeq}`;
    const orderflow = context?.orderflow || this.buildOrderflowMetrics(undefined, session);

    session.currentTrade = {
      tradeId,
      side: position.side,
      entryTimeMs: eventTimestampMs,
      entryPrice,
      qty,
      notional,
      marginUsed,
      leverage,
      pnlRealized: 0,
      feeAcc: openingFee,
      fundingAcc: 0,
      signalType: context?.signalType ?? null,
      signalScore: context?.signalScore ?? null,
      candidate: context?.candidate ?? null,
      orderflow,
    };

    this.logTradeEvent({
      type: 'ENTRY',
      runId: this.getRunId(),
      symbol: session.symbol,
      timestampMs: eventTimestampMs,
      tradeId,
      side: position.side,
      entryPrice,
      qty,
      notional,
      marginUsed,
      leverage,
      reason: context?.reason || 'UNKNOWN',
      signalType: context?.signalType ?? null,
      signalScore: context?.signalScore ?? null,
      orderflow,
      candidate: context?.candidate ?? null,
    });

    session.pendingEntry = null;
  }

  private closeTrade(
    session: SymbolSession,
    eventTimestampMs: number,
    exitPrice: number,
    qty: number,
    reason: string
  ): void {
    const trade = session.currentTrade || this.buildFallbackTrade(session, eventTimestampMs, qty);
    const realized = trade.pnlRealized;
    const feeUsdt = trade.feeAcc;
    const fundingUsdt = trade.fundingAcc;
    const net = realized - feeUsdt + fundingUsdt;
    const returnPct = trade.marginUsed > 0 ? (net / trade.marginUsed) * 100 : null;
    const rMultiple = this.computeRMultiple(trade, net);

    this.logTradeEvent({
      type: 'EXIT',
      runId: this.getRunId(),
      symbol: session.symbol,
      timestampMs: eventTimestampMs,
      tradeId: trade.tradeId,
      side: trade.side,
      entryTimeMs: trade.entryTimeMs,
      entryPrice: trade.entryPrice,
      exitPrice,
      qty: trade.qty || qty,
      reason,
      durationMs: Math.max(0, eventTimestampMs - trade.entryTimeMs),
      pnl: {
        realizedUsdt: Number(realized.toFixed(8)),
        feeUsdt: Number(feeUsdt.toFixed(8)),
        fundingUsdt: Number(fundingUsdt.toFixed(8)),
        netUsdt: Number(net.toFixed(8)),
        returnPct: returnPct === null ? null : Number(returnPct.toFixed(4)),
        rMultiple: rMultiple === null ? null : Number(rMultiple.toFixed(4)),
      },
      cumulative: this.buildCumulativeSummary(),
      orderflow: trade.orderflow,
      candidate: trade.candidate ?? null,
    });

    session.currentTrade = null;
    session.pendingExitReason = null;
  }

  private updateTradePosition(session: SymbolSession, position: NonNullable<DryRunStateSnapshot['position']>): void {
    if (!session.currentTrade) return;
    const leverage = session.dynamicLeverage || session.currentTrade.leverage || this.config?.leverage || 1;
    const entryPrice = Number(position.entryPrice) || session.currentTrade.entryPrice;
    const qty = Number(position.qty) || session.currentTrade.qty;
    const notional = entryPrice * qty;
    const marginUsed = leverage > 0 ? notional / leverage : session.currentTrade.marginUsed;

    session.currentTrade.side = position.side;
    session.currentTrade.entryPrice = entryPrice;
    session.currentTrade.qty = qty;
    session.currentTrade.notional = notional;
    session.currentTrade.marginUsed = marginUsed;
    session.currentTrade.leverage = leverage;
  }

  private applyTradeAcc(session: SymbolSession, realized: number, fee: number, funding: number): void {
    const trade = session.currentTrade;
    if (!trade) return;
    trade.pnlRealized += realized;
    trade.feeAcc += fee;
    trade.fundingAcc += funding;
  }

  private resolveExitReason(
    session: SymbolSession,
    liquidation: boolean,
    realized: number,
    fallback: string | null
  ): string {
    if (liquidation) return 'RISK_EMERGENCY';
    if (fallback) return fallback;
    if (session.pendingExitReason) return session.pendingExitReason;
    if (realized > 0) return 'PROFITLOCK_STOP';
    if (realized < 0) return 'RISK_EMERGENCY';
    return 'HARD_INVALIDATION';
  }

  private computeRMultiple(trade: ActiveTrade, net: number): number | null {
    const sl = trade.candidate?.slPrice;
    if (!Number.isFinite(sl) || !(trade.qty > 0)) return null;
    const risk = Math.abs(trade.entryPrice - Number(sl)) * trade.qty;
    if (!(risk > 0)) return null;
    return net / risk;
  }

  private buildFallbackTradeFromPosition(
    session: SymbolSession,
    position: NonNullable<DryRunStateSnapshot['position']>,
    eventTimestampMs: number
  ): ActiveTrade {
    const leverage = session.dynamicLeverage || this.config?.leverage || 1;
    const entryPrice = Number(position.entryPrice) || session.latestMarkPrice || 0;
    const size = Number(position.qty) || 0;
    const notional = entryPrice * size;
    const marginUsed = leverage > 0 ? notional / leverage : 0;
    const tradeId = `${this.getRunId()}-${session.symbol}-${++session.tradeSeq}`;
    return {
      tradeId,
      side: position.side,
      entryTimeMs: eventTimestampMs,
      entryPrice,
      qty: size,
      notional,
      marginUsed,
      leverage,
      pnlRealized: 0,
      feeAcc: 0,
      fundingAcc: 0,
      signalType: null,
      signalScore: null,
      candidate: null,
      orderflow: this.buildOrderflowMetrics(undefined, session),
    };
  }

  private buildFallbackTrade(session: SymbolSession, eventTimestampMs: number, qty: number): ActiveTrade {
    if (session.lastState.position) {
      return this.buildFallbackTradeFromPosition(session, session.lastState.position, eventTimestampMs);
    }
    const leverage = session.dynamicLeverage || this.config?.leverage || 1;
    const entryPrice = session.latestMarkPrice || 0;
    const size = qty || 0;
    const notional = entryPrice * size;
    const marginUsed = leverage > 0 ? notional / leverage : 0;
    const tradeId = `${this.getRunId()}-${session.symbol}-${++session.tradeSeq}`;
    return {
      tradeId,
      side: 'LONG',
      entryTimeMs: eventTimestampMs,
      entryPrice,
      qty: size,
      notional,
      marginUsed,
      leverage,
      pnlRealized: 0,
      feeAcc: 0,
      fundingAcc: 0,
      signalType: null,
      signalScore: null,
      candidate: null,
      orderflow: this.buildOrderflowMetrics(undefined, session),
    };
  }

  private buildCumulativeSummary(): { totalPnL: number; totalTrades: number; winCount: number; winRate: number } {
    const perf = this.getStatus().summary.performance;
    if (!perf) {
      return { totalPnL: 0, totalTrades: 0, winCount: 0, winRate: 0 };
    }
    return {
      totalPnL: Number(perf.totalPnL.toFixed(8)),
      totalTrades: perf.totalTrades,
      winCount: perf.winCount,
      winRate: perf.winRate,
    };
  }

  private maybeLogSnapshot(session: SymbolSession, eventTimestampMs: number): void {
    if (!this.tradeLogger || !this.tradeLogEnabled) return;
    const intervalMs = Math.max(0, Math.trunc(DEFAULT_SNAPSHOT_LOG_MS));
    if (intervalMs === 0) return;
    if (session.lastSnapshotLogTs > 0 && (eventTimestampMs - session.lastSnapshotLogTs) < intervalMs) return;

    const unrealized = this.computeUnrealizedPnl(session);
    const totalEquity = session.lastState.walletBalance + unrealized;
    this.logTradeEvent({
      type: 'SNAPSHOT',
      runId: this.getRunId(),
      symbol: session.symbol,
      timestampMs: eventTimestampMs,
      markPrice: session.latestMarkPrice,
      walletBalance: roundTo(session.lastState.walletBalance, 8),
      totalEquity: roundTo(totalEquity, 8),
      unrealizedPnl: roundTo(unrealized, 8),
      realizedPnl: roundTo(session.realizedPnl, 8),
      feePaid: roundTo(session.feePaid, 8),
      fundingPnl: roundTo(session.fundingPnl, 8),
      marginHealth: roundTo(session.lastState.marginHealth, 8),
      position: session.lastState.position
        ? {
          side: session.lastState.position.side,
          qty: roundTo(session.lastState.position.qty, 6),
          entryPrice: roundTo(session.lastState.position.entryPrice, 8),
        }
        : null,
    });

    session.lastSnapshotLogTs = eventTimestampMs;
  }

  private buildOrderflowMetrics(
    input?: StrategySignal['orderflow'],
    session?: SymbolSession
  ): DryRunOrderflowMetrics {
    const norm = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    return {
      obiWeighted: norm(input?.obiWeighted),
      obiDeep: norm(input?.obiDeep ?? session?.obi),
      deltaZ: norm(input?.deltaZ),
      cvdSlope: norm(input?.cvdSlope),
    };
  }

  private buildMarketMetrics(
    input?: StrategySignal['market'] & { price?: number | null },
    session?: SymbolSession
  ): { price: number | null; atr: number | null; avgAtr: number | null; recentHigh: number | null; recentLow: number | null } {
    const norm = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    return {
      price: norm(input?.price ?? session?.latestMarkPrice),
      atr: norm(input?.atr ?? session?.atr),
      avgAtr: norm(input?.avgAtr ?? session?.avgAtr),
      recentHigh: norm(input?.recentHigh),
      recentLow: norm(input?.recentLow),
    };
  }

  private computeUnrealizedPnlPct(session: SymbolSession, markPrice: number): number {
    const pos = session.lastState.position;
    if (!pos || !(markPrice > 0) || !(pos.entryPrice > 0)) return 0;
    if (pos.side === 'LONG') return (markPrice - pos.entryPrice) / pos.entryPrice;
    return (pos.entryPrice - markPrice) / pos.entryPrice;
  }

  private computeBreakEvenPrice(session: SymbolSession): number | null {
    const position = session.lastState.position;
    if (!position) return null;
    const qty = Math.abs(Number(position.qty) || 0);
    const entryPrice = Number(position.entryPrice) || 0;
    if (!(qty > 0) || !(entryPrice > 0)) return null;

    const trade = session.currentTrade;
    const netCarry = trade
      ? Number(trade.pnlRealized || 0) - Number(trade.feeAcc || 0) + Number(trade.fundingAcc || 0)
      : 0;
    const configuredFeeRate = Number(this.config?.takerFeeRate ?? DEFAULT_TAKER_FEE_RATE);
    const feeRate = Number.isFinite(configuredFeeRate)
      ? clampNumber(configuredFeeRate, DEFAULT_TAKER_FEE_RATE, 0, 0.1)
      : DEFAULT_TAKER_FEE_RATE;

    let breakEven = entryPrice;
    if (position.side === 'LONG') {
      const denom = qty * Math.max(1e-6, 1 - feeRate);
      breakEven = ((qty * entryPrice) - netCarry) / denom;
    } else {
      const denom = qty * (1 + feeRate);
      breakEven = ((qty * entryPrice) + netCarry) / denom;
    }

    if (!Number.isFinite(breakEven) || !(breakEven > 0)) return entryPrice;
    return breakEven;
  }

  private computeSpreadPct(book: DryRunOrderBook): number | null {
    const bestBid = book.bids?.[0]?.price ?? 0;
    const bestAsk = book.asks?.[0]?.price ?? 0;
    if (!(bestBid > 0) || !(bestAsk > 0)) return null;
    const mid = (bestBid + bestAsk) / 2;
    return mid > 0 ? (bestAsk - bestBid) / mid : null;
  }

  private buildAiLimitOrder(
    session: SymbolSession,
    side: 'BUY' | 'SELL',
    qty: number,
    reduceOnly: boolean,
    reasonCode: DryRunReasonCode
  ): DryRunOrderRequest | null {
    if (!(qty > 0)) return null;
    const bestBid = Number(session.lastOrderBook.bids?.[0]?.price || 0);
    const bestAsk = Number(session.lastOrderBook.asks?.[0]?.price || 0);
    const mark = Number(session.latestMarkPrice || 0);
    let price = side === 'BUY' ? bestAsk : bestBid;
    if (!(price > 0)) {
      price = mark;
    }
    if (!(price > 0)) {
      return null;
    }
    return {
      side,
      type: 'LIMIT',
      qty: roundTo(qty, 6),
      price: roundTo(price, 6),
      timeInForce: 'IOC',
      reduceOnly,
      postOnly: false,
      reasonCode,
    };
  }

  private extractAIPlan(metadata?: Record<string, unknown>): AIIntentMetadata | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const candidate = (metadata as AIActionMetadata).plan;
    if (!candidate || typeof candidate !== 'object') return null;
    return candidate;
  }

  private normalizeAIEntryStyle(value?: string): 'LIMIT' | 'MARKET_SMALL' | 'HYBRID' {
    return 'LIMIT';
  }

  private normalizeAIUrgency(value?: string): 'LOW' | 'MED' | 'HIGH' {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'LOW' || normalized === 'MED' || normalized === 'HIGH') {
      return normalized;
    }
    return 'MED';
  }

  private computePositionTimeInMs(session: SymbolSession, nowMs: number): number {
    const position = session.lastState.position;
    if (!position) return 0;
    const entryTsRaw = Number(position.entryTimestampMs);
    const fallbackTs = Number(session.lastEntryOrAddOnTs || session.lastEventTimestampMs || 0);
    const entryTs = Number.isFinite(entryTsRaw) && entryTsRaw > 0 ? entryTsRaw : fallbackTs;
    if (!(entryTs > 0) || !(nowMs > 0)) return 0;
    return Math.max(0, nowMs - entryTs);
  }

  private isAIAutonomousRun(): boolean {
    const runId = String(this.runId || '').toLowerCase();
    return runId.startsWith('ai-');
  }

  private computeRiskSizing(
    session: SymbolSession,
    price: number,
    regime: StrategyRegime,
    sizeMultiplier = 1,
    options?: { mode?: 'ENTRY' | 'ADD'; incrementalRiskCapPct?: number }
  ): { qty: number; leverage: number } {
    if (!this.config || !(price > 0)) return { qty: 0, leverage: session.dynamicLeverage || 1 };
    const leverage = session.dynamicLeverage || this.config.leverage || 1;

    const normalizedMultiplier = Math.max(0.05, Math.min(2, Number(sizeMultiplier || 1)));
    const baseMarginUsdt = Math.max(1, Number(this.config.initialMarginUsdt || 0));
    const positionNotional = session.lastState.position ? Math.abs(session.lastState.position.qty * price) : 0;
    const targetMargin = baseMarginUsdt * normalizedMultiplier;
    const targetNotional = Math.max(0, targetMargin * leverage);
    const desiredNotional = options?.mode === 'ADD'
      ? targetNotional
      : Math.max(targetNotional, baseMarginUsdt * leverage);
    const openingNotional = Math.max(0, desiredNotional - positionNotional);
    const qty = roundTo(Math.max(0, openingNotional / price), 6);
    return { qty, leverage };
  }

  private getHoldRemainingMs(session: SymbolSession, nowMs: number): number {
    if (!session.lastEntryOrAddOnTs || nowMs <= 0) return 0;
    return Math.max(0, DEFAULT_MIN_HOLD_MS - (nowMs - session.lastEntryOrAddOnTs));
  }

  private buildFlipState(session: SymbolSession, confirmTicks?: number, lastOppositeSide?: 'LONG' | 'SHORT' | null) {
    const state = session.flipGovernor.getState();
    return {
      confirmTicks: Number.isFinite(confirmTicks as number) ? Number(confirmTicks) : state.confirmTicks,
      requiredTicks: DEFAULT_FLIP_CONFIRM_TICKS,
      lastOppositeSide: lastOppositeSide ?? state.lastOppositeSide,
      partialReduced: session.flipState.partialReduced,
    };
  }

  private logAction(session: SymbolSession, payload: {
    reasonCode: DryRunReasonCode;
    timestampMs: number;
    signalType: string | null;
    signalScore: number | null;
    signalSide: 'LONG' | 'SHORT' | null;
    unrealizedPnlPct: number;
    feePaidIncrement: number;
    spreadPct: number | null;
    impactEstimate: number | null;
    addonIndex: number | null;
    flipState: {
      confirmTicks: number;
      requiredTicks: number;
      lastOppositeSide: 'LONG' | 'SHORT' | null;
      partialReduced: boolean;
    } | null;
    holdRemainingMs: number;
  }): void {
    if (!this.tradeLogger || !this.tradeLogEnabled) return;
    this.tradeLogger.log({
      type: 'ACTION',
      runId: this.getRunId(),
      symbol: session.symbol,
      timestampMs: payload.timestampMs,
      reason_code: payload.reasonCode,
      signalType: payload.signalType,
      signalScore: payload.signalScore,
      signalSide: payload.signalSide,
      unrealizedPnlPct: Number(payload.unrealizedPnlPct.toFixed(6)),
      feePaid_increment: Number(payload.feePaidIncrement.toFixed(8)),
      spread_pct: payload.spreadPct == null ? null : Number(payload.spreadPct.toFixed(6)),
      impact_estimate: payload.impactEstimate == null ? null : Number(payload.impactEstimate.toFixed(6)),
      addonIndex: payload.addonIndex,
      flipState: payload.flipState,
      holdRemainingMs: payload.holdRemainingMs,
    });
  }

  private hasPendingAddOn(session: SymbolSession): boolean {
    if (session.addOnState.pendingClientOrderId) return true;
    if (session.manualOrders.some((o) => o.reasonCode === 'ADDON_MAKER')) return true;
    return session.lastState.openLimitOrders.some((o) => o.reasonCode === 'ADDON_MAKER');
  }

  private buildAddOnClientOrderId(session: SymbolSession, addonIndex: number, attempt: number): string {
    return `addon-${this.getRunId()}-${session.symbol}-${addonIndex}-${attempt}`;
  }

  private tryQueueAddOn(
    session: SymbolSession,
    signal: StrategySignal,
    signalTs: number,
    side: 'BUY' | 'SELL',
    orderflow: DryRunOrderflowMetrics,
    market: ReturnType<DryRunSessionService['buildMarketMetrics']>
  ): void {
    const position = session.lastState.position;
    if (!position) return;

    const unrealizedPnlPct = this.computeUnrealizedPnlPct(session, session.latestMarkPrice || position.entryPrice);
    const addonIndex = session.addOnState.count + 1;
    const decision = this.addOnManager.buildAddOnOrder({
      side: position.side,
      positionQty: position.qty,
      markPrice: session.latestMarkPrice || position.entryPrice,
      unrealizedPnlPct,
      signalScore: signal.score,
      book: session.lastOrderBook,
      nowMs: signalTs,
      lastAddOnTs: session.addOnState.lastAddOnTs,
      addonCount: session.addOnState.count,
      addonIndex,
      hasPendingAddOn: this.hasPendingAddOn(session),
    });

    if (!decision) return;
    const clientOrderId = this.buildAddOnClientOrderId(session, decision.addonIndex, 0);
    session.manualOrders.push({
      ...decision.order,
      clientOrderId,
      repriceAttempt: 0,
    });
    session.addOnState.pendingClientOrderId = clientOrderId;
    session.addOnState.pendingAddonIndex = decision.addonIndex;
    session.addOnState.pendingAttempt = 0;

    if (!session.pendingEntry) {
      session.pendingEntry = {
        reason: 'STRATEGY_SIGNAL',
        signalType: signal.signal as string,
        signalScore: signal.score,
        candidate: signal.candidate,
        orderflow,
        boost: signal.boost,
        market,
        timestampMs: signalTs,
        leverage: session.dynamicLeverage,
      };
    }
  }

  private tryFlipInvalidation(
    session: SymbolSession,
    signal: StrategySignal,
    signalTs: number,
    side: 'BUY' | 'SELL',
    orderflow: DryRunOrderflowMetrics,
    market: ReturnType<DryRunSessionService['buildMarketMetrics']>
  ): void {
    const position = session.lastState.position;
    if (!position) return;

    const spreadPct = this.computeSpreadPct(session.lastOrderBook);
    const holdRemainingMs = this.getHoldRemainingMs(session, signalTs);
    if (spreadPct != null && spreadPct > DEFAULT_MAX_SPREAD_PCT) {
      this.logAction(session, {
        reasonCode: 'FLIP_BLOCKED',
        timestampMs: signalTs,
        signalType: signal.signal,
        signalScore: signal.score,
        signalSide: side === 'BUY' ? 'LONG' : 'SHORT',
        unrealizedPnlPct: this.computeUnrealizedPnlPct(session, session.latestMarkPrice || position.entryPrice),
        feePaidIncrement: 0,
        spreadPct,
        impactEstimate: null,
        addonIndex: null,
        flipState: this.buildFlipState(session),
        holdRemainingMs,
      });
      return;
    }

    const flipThreshold = DEFAULT_ENTRY_SIGNAL_MIN + (DEFAULT_FLIP_HYSTERESIS * 100);
    const decision = session.flipGovernor.evaluate({
      minHoldMs: DEFAULT_MIN_HOLD_MS,
      deadbandPct: DEFAULT_FLIP_DEADBAND_PCT,
      confirmTicks: DEFAULT_FLIP_CONFIRM_TICKS,
      flipScoreThreshold: flipThreshold,
    }, {
      nowMs: signalTs,
      lastEntryOrAddOnTs: session.lastEntryOrAddOnTs,
      unrealizedPnlPct: this.computeUnrealizedPnlPct(session, session.latestMarkPrice || position.entryPrice),
      signalScore: signal.score,
      oppositeSide: side === 'BUY' ? 'LONG' : 'SHORT',
    });

    const flipState = this.buildFlipState(session, decision.confirmTicks, decision.lastOppositeSide);
    if (!decision.confirmed) {
      this.logAction(session, {
        reasonCode: 'FLIP_BLOCKED',
        timestampMs: signalTs,
        signalType: signal.signal,
        signalScore: signal.score,
        signalSide: side === 'BUY' ? 'LONG' : 'SHORT',
        unrealizedPnlPct: this.computeUnrealizedPnlPct(session, session.latestMarkPrice || position.entryPrice),
        feePaidIncrement: 0,
        spreadPct,
        impactEstimate: null,
        addonIndex: null,
        flipState,
        holdRemainingMs: decision.holdRemainingMs,
      });
      return;
    }

    this.logAction(session, {
      reasonCode: 'FLIP_CONFIRMED',
      timestampMs: signalTs,
      signalType: signal.signal,
      signalScore: signal.score,
      signalSide: side === 'BUY' ? 'LONG' : 'SHORT',
      unrealizedPnlPct: this.computeUnrealizedPnlPct(session, session.latestMarkPrice || position.entryPrice),
      feePaidIncrement: 0,
      spreadPct,
      impactEstimate: null,
      addonIndex: null,
      flipState,
      holdRemainingMs: 0,
    });

    if (!session.flipState.partialReduced) {
      const reduceQty = roundTo(position.qty * 0.4, 6);
      if (reduceQty > 0) {
        session.manualOrders.push({
          side: position.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'MARKET',
          qty: reduceQty,
          timeInForce: 'IOC',
          reduceOnly: true,
          reasonCode: 'REDUCE_PARTIAL',
        });
        session.flipState.partialReduced = true;
        session.flipState.lastPartialReduceTs = signalTs;
      }
      return;
    }

    const closeQty = roundTo(position.qty, 6);
    if (closeQty > 0) {
      session.manualOrders.push({
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        type: 'MARKET',
        qty: closeQty,
        timeInForce: 'IOC',
        reduceOnly: true,
        reasonCode: 'FLIP_CONFIRMED',
      });
      session.pendingExitReason = 'HARD_INVALIDATION';
      session.pendingFlipEntry = {
        side,
        signalType: signal.signal as string,
        signalScore: signal.score,
        candidate: signal.candidate,
        orderflow,
        boost: signal.boost,
        market,
        timestampMs: signalTs,
        leverage: session.dynamicLeverage,
      };
    }
  }

  private handleOrderActions(
    session: SymbolSession,
    orderResults: DryRunEventLog['orderResults'],
    markPrice: number,
    spreadPct: number | null,
    eventTimestampMs: number
  ): void {
    const holdRemainingMs = this.getHoldRemainingMs(session, eventTimestampMs);
    const unrealizedPnlPct = this.computeUnrealizedPnlPct(session, markPrice);
    const signalType = session.lastSignal?.signalType ?? null;
    const signalScore = session.lastSignal?.score ?? null;
    const signalSide = session.lastSignal?.side ?? null;
    const flipState = this.buildFlipState(session);

    for (const order of orderResults || []) {
      if (order.status === 'NEW') continue;
      const reasonCode = order.reasonCode ?? null;
      if (!reasonCode) continue;
      const feePaidIncrement = Number.isFinite(order.fee) ? Number(order.fee) : 0;
      const impactEstimate = Number.isFinite(order.marketImpactBps as number) ? Number(order.marketImpactBps) : null;
      const addonIndex = Number.isFinite(order.addonIndex as number) ? Number(order.addonIndex) : null;

      this.logAction(session, {
        reasonCode,
        timestampMs: eventTimestampMs,
        signalType,
        signalScore,
        signalSide,
        unrealizedPnlPct,
        feePaidIncrement,
        spreadPct,
        impactEstimate,
        addonIndex,
        flipState,
        holdRemainingMs,
      });

      if (reasonCode === 'ENTRY_MARKET' && Number(order.filledQty) > 0) {
        session.lastEntryOrAddOnTs = eventTimestampMs;
      }

      if (reasonCode === 'ADDON_MAKER' && Number(order.filledQty) > 0) {
        session.lastEntryOrAddOnTs = eventTimestampMs;
        session.addOnState.lastAddOnTs = eventTimestampMs;
        if (order.clientOrderId && !session.addOnState.filledClientOrderIds.has(order.clientOrderId)) {
          session.addOnState.filledClientOrderIds.add(order.clientOrderId);
          session.addOnState.count += 1;
        }
      }

      if (reasonCode === 'LIMIT_TTL_CANCEL') {
        this.repriceAddOnIfEligible(session, order, eventTimestampMs);
      }
    }

    this.syncPendingAddOn(session);
  }

  private repriceAddOnIfEligible(session: SymbolSession, order: DryRunEventLog['orderResults'][number], eventTimestampMs: number): void {
    if (!session.lastState.position) return;
    if (!order.clientOrderId || !(Number.isFinite(order.addonIndex as number))) return;
    if (!(Number(order.remainingQty) > 0)) return;
    const attempt = Number.isFinite(order.repriceAttempt as number) ? Number(order.repriceAttempt) : 0;
    if (attempt >= DEFAULT_ADDON_REPRICE_MAX) return;

    const lastSignal = session.lastSignal;
    if (!lastSignal || lastSignal.score < DEFAULT_ADDON_SIGNAL_MIN) return;
    if (lastSignal.side !== session.lastState.position.side) return;

    const spreadPct = this.computeSpreadPct(session.lastOrderBook);
    if (spreadPct != null && spreadPct > DEFAULT_MAX_SPREAD_PCT) return;

    const bestBid = session.lastOrderBook.bids?.[0]?.price ?? 0;
    const bestAsk = session.lastOrderBook.asks?.[0]?.price ?? 0;
    const limitPrice = session.lastState.position.side === 'LONG' ? bestBid : bestAsk;
    if (!(limitPrice > 0)) return;

    const nextAttempt = attempt + 1;
    const clientOrderId = this.buildAddOnClientOrderId(session, Number(order.addonIndex), nextAttempt);
    session.manualOrders.push({
      side: session.lastState.position.side === 'LONG' ? 'BUY' : 'SELL',
      type: 'LIMIT',
      qty: roundTo(Number(order.remainingQty), 6),
      price: roundTo(limitPrice, 8),
      timeInForce: 'GTC',
      reduceOnly: false,
      postOnly: true,
      ttlMs: DEFAULT_ADDON_TTL_MS,
      reasonCode: 'ADDON_MAKER',
      addonIndex: Number(order.addonIndex),
      repriceAttempt: nextAttempt,
      clientOrderId,
    });

    session.addOnState.pendingClientOrderId = clientOrderId;
    session.addOnState.pendingAddonIndex = Number(order.addonIndex);
    session.addOnState.pendingAttempt = nextAttempt;
    session.addOnState.lastAddOnTs = eventTimestampMs;
  }

  private syncPendingAddOn(session: SymbolSession): void {
    if (!session.addOnState.pendingClientOrderId) return;
    const stillOpen = session.lastState.openLimitOrders.some((o) => o.clientOrderId === session.addOnState.pendingClientOrderId);
    if (!stillOpen) {
      session.addOnState.pendingClientOrderId = null;
      session.addOnState.pendingAddonIndex = null;
      session.addOnState.pendingAttempt = 0;
    }
  }

  private ensureWinnerState(session: SymbolSession, position: NonNullable<DryRunStateSnapshot['position']>, markPrice: number): void {
    if (session.winnerState) return;
    session.winnerState = this.winnerManager.initState({
      entryPrice: position.entryPrice,
      side: position.side,
      atr: session.atr || Math.abs(markPrice - position.entryPrice) * 0.01,
      markPrice,
    });
  }

  private resolveActiveStop(state: WinnerState | null): number | null {
    if (!state) return null;
    const active = state.side === 'LONG'
      ? Math.max(state.profitLockStop ?? -Infinity, state.trailingStop ?? -Infinity)
      : Math.min(state.profitLockStop ?? Infinity, state.trailingStop ?? Infinity);
    return Number.isFinite(active) ? active : null;
  }

  private shouldRiskEmergency(session: SymbolSession, markPrice: number, spreadPct: number | null): boolean {
    const marginHealth = session.lastState.marginHealth;
    if (marginHealth <= 0.05) return true;
    const liquidation = this.computeLiquidationRisk(session, marginHealth);
    if (liquidation.score === 'RED' || liquidation.score === 'CRITICAL') return true;

    const drawdownPct = this.computeUnrealizedPnlPct(session, markPrice);
    if (drawdownPct <= -Math.max(DEFAULT_FLIP_DEADBAND_PCT * 4, 0.012)) return true;

    if (spreadPct != null && spreadPct > DEFAULT_MAX_SPREAD_PCT && session.spreadBreachCount >= 3) {
      return true;
    }
    return false;
  }

  private syncPositionStateAfterEvent(
    session: SymbolSession,
    prevPosition: DryRunStateSnapshot['position'],
    nextPosition: DryRunStateSnapshot['position'],
    eventTimestampMs: number,
    markPrice: number
  ): void {
    if (!prevPosition && nextPosition) {
      session.winnerState = this.winnerManager.initState({
        entryPrice: nextPosition.entryPrice,
        side: nextPosition.side,
        atr: session.atr || Math.abs(markPrice - nextPosition.entryPrice) * 0.01,
        markPrice,
      });
      session.stopLossPrice = this.resolveActiveStop(session.winnerState);
      session.addOnState.count = 0;
      session.addOnState.lastAddOnTs = eventTimestampMs;
      session.addOnState.pendingClientOrderId = null;
      session.addOnState.pendingAddonIndex = null;
      session.addOnState.pendingAttempt = 0;
      session.addOnState.filledClientOrderIds.clear();
      session.lastEntryOrAddOnTs = eventTimestampMs;
      session.flipGovernor.reset();
      session.flipState.partialReduced = false;
      session.flipState.lastPartialReduceTs = 0;
      return;
    }

    if (prevPosition && !nextPosition) {
      session.winnerState = null;
      session.stopLossPrice = null;
      session.addOnState.pendingClientOrderId = null;
      session.addOnState.pendingAddonIndex = null;
      session.addOnState.pendingAttempt = 0;
      session.flipGovernor.reset();
      session.flipState.partialReduced = false;
      session.flipState.lastPartialReduceTs = 0;
      return;
    }

    if (prevPosition && nextPosition && prevPosition.side !== nextPosition.side) {
      session.winnerState = this.winnerManager.initState({
        entryPrice: nextPosition.entryPrice,
        side: nextPosition.side,
        atr: session.atr || Math.abs(markPrice - nextPosition.entryPrice) * 0.01,
        markPrice,
      });
      session.stopLossPrice = this.resolveActiveStop(session.winnerState);
      session.lastEntryOrAddOnTs = eventTimestampMs;
      session.flipGovernor.reset();
      session.flipState.partialReduced = false;
      session.flipState.lastPartialReduceTs = 0;
    }
  }

  private isClosingOrder(prevSide: 'LONG' | 'SHORT', orderSide: 'BUY' | 'SELL'): boolean {
    return (prevSide === 'LONG' && orderSide === 'SELL') || (prevSide === 'SHORT' && orderSide === 'BUY');
  }

  private logTradeEvent(event: DryRunLogEvent): void {
    if (!this.tradeLogger || !this.tradeLogEnabled) return;
    this.tradeLogger.log(event);
  }

  private getRunId(): string {
    return this.runId || 'dryrun';
  }

  private addConsoleLog(
    level: 'INFO' | 'WARN' | 'ERROR',
    symbol: string | null,
    message: string,
    timestampMs: number
  ): void {
    this.consoleSeq += 1;
    const logItem: DryRunConsoleLog = {
      seq: this.consoleSeq,
      timestampMs: timestampMs > 0 ? timestampMs : this.clock.now(),
      symbol,
      level,
      message,
    };
    this.logTail.push(logItem);
    if (this.logTail.length > CONSOLE_LOG_TAIL_LIMIT) {
      this.logTail = this.logTail.slice(this.logTail.length - CONSOLE_LOG_TAIL_LIMIT);
    }
  }
}
