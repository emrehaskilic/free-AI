import { createHash } from 'crypto';
import { DecisionLog } from '../telemetry/DecisionLog';
import { StrategyAction, StrategyActionType, StrategyDecision, StrategyDecisionLog, StrategySide } from '../types/strategy';
import { DryRunSessionService } from '../dryrun/DryRunSessionService';
import { generateContent } from './GoogleAIClient';
import { GuardrailRuntimeContext, SafetyGuardrails, clampPlanNumber } from './SafetyGuardrails';
import {
  AIAddRule,
  AIDecisionIntent,
  AIDecisionPlan,
  AIEntryStyle,
  AIExplanationTag,
  AIForcedAction,
  AIDryRunConfig,
  AIDryRunStatus,
  AITrendStatus,
  AIMetricsSnapshot,
  AIUrgency,
  GuardrailReason,
} from './types';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const DEFAULT_MIN_HOLD_MS = Math.max(5_000, Number(process.env.AI_MIN_HOLD_MS || 180_000));
const DEFAULT_FLIP_COOLDOWN_MS = Math.max(2_000, Number(process.env.AI_FLIP_COOLDOWN_MS || 240_000));
const DEFAULT_MIN_ADD_GAP_MS = Math.max(1_000, Number(process.env.AI_MIN_ADD_GAP_MS || 60_000));
const DEFAULT_MAX_DECISION_INTERVAL_MS = 1_000;
const DEFAULT_MIN_DECISION_INTERVAL_MS = 100;
const DEFAULT_DECISION_INTERVAL_MS = 250;
const AI_UNRESTRICTED_MODE = true;
const DEFAULT_ADD_MARGIN_USAGE_CAP = clamp(Number(process.env.AI_ADD_MARGIN_USAGE_CAP || 0.65), 0.3, 0.98);
const DEFAULT_ADD_MIN_UPNL_PCT = clamp(Number(process.env.AI_ADD_MIN_UPNL_PCT || 0.003), 0, 0.05);
const DEFAULT_PULLBACK_ADD_MAX_ADVERSE_PCT = clamp(Number(process.env.AI_PULLBACK_ADD_MAX_ADVERSE_PCT || 0.0075), 0, 0.05);
const DEFAULT_PULLBACK_ADD_TRIGGER_UPNL_PCT = clamp(Number(process.env.AI_PULLBACK_ADD_TRIGGER_UPNL_PCT || 0.001), -0.02, 0.02);
const DEFAULT_PULLBACK_ADD_EDGE_BPS = clamp(Number(process.env.AI_PULLBACK_ADD_EDGE_BPS || 0.8), -5, 20);
const DEFAULT_PULLBACK_ADD_SIZE_MULT = clamp(Number(process.env.AI_PULLBACK_ADD_SIZE_MULT || 0.5), 0.1, 1.5);
const DEFAULT_TREND_DEFENSE_MIN_SIGNAL = clamp(Number(process.env.AI_TREND_DEFENSE_MIN_SIGNAL || 0.12), 0, 1);
const DEFAULT_ENTRY_FEE_BPS = clamp(Number(process.env.AI_ENTRY_FEE_BPS || 2.2), 0, 30);
const DEFAULT_ENTRY_SLIPPAGE_BPS = clamp(Number(process.env.AI_ENTRY_SLIPPAGE_BPS || 1), 0, 30);
const DEFAULT_EDGE_MIN_BPS = clamp(Number(process.env.AI_EDGE_MIN_BPS || 4.5), -5, 30);
const DEFAULT_PROBE_EDGE_BPS = clamp(Number(process.env.AI_PROBE_EDGE_BPS || 6), -5, 30);
const DEFAULT_PROBE_HOLD_STREAK = Math.max(1, Math.trunc(Number(process.env.AI_PROBE_HOLD_STREAK || 3)));
const DEFAULT_PROBE_SIZE_MULT = clamp(Number(process.env.AI_PROBE_SIZE_MULT || 0.2), 0.1, 1.2);
const DEFAULT_FIRST_ENTRY_EDGE_BPS = clamp(Number(process.env.AI_FIRST_ENTRY_EDGE_BPS || 1.8), -5, 30);
const DEFAULT_FIRST_ENTRY_HOLD_STREAK = Math.max(1, Math.trunc(Number(process.env.AI_FIRST_ENTRY_HOLD_STREAK || 1)));
const DEFAULT_FIRST_ENTRY_MIN_STRENGTH = clamp(Number(process.env.AI_FIRST_ENTRY_MIN_STRENGTH || 0.5), 0, 1);
const DEFAULT_SIDE_ALIGN_STRENGTH = clamp(Number(process.env.AI_SIDE_ALIGN_STRENGTH || 0.62), 0, 1);
const DEFAULT_TREND_ENTRY_SCORE = clamp(Number(process.env.AI_TREND_ENTRY_SCORE || 0.62), 0, 1);
const DEFAULT_TREND_BREAK_SCORE = clamp(Number(process.env.AI_TREND_BREAK_SCORE || 0.38), 0, 1);
const DEFAULT_TREND_SIDE_GAP = clamp(Number(process.env.AI_TREND_SIDE_GAP || 0.12), 0, 0.5);
const DEFAULT_TREND_CONFIRM_TICKS = Math.max(1, Math.trunc(Number(process.env.AI_TREND_CONFIRM_TICKS || 30)));
const DEFAULT_TREND_BREAK_CONFIRM_TICKS = Math.max(1, Math.trunc(Number(process.env.AI_TREND_BREAK_CONFIRM_TICKS || 45)));
const DEFAULT_TREND_TP_MIN_UPNL_PCT = clamp(Number(process.env.AI_TREND_TP_MIN_UPNL_PCT || 0.004), 0, 0.08);
const DEFAULT_TREND_TP_REDUCE_PCT = clamp(Number(process.env.AI_TREND_TP_REDUCE_PCT || 0.15), 0.05, 0.8);
const DEFAULT_TREND_TP_COOLDOWN_MS = Math.max(5_000, Math.trunc(Number(process.env.AI_TREND_TP_COOLDOWN_MS || 90_000)));
const DEFAULT_BOOTSTRAP_PHASE_MS = Math.max(30_000, Math.trunc(Number(process.env.AI_BOOTSTRAP_PHASE_MS || 180_000)));
const DEFAULT_BOOTSTRAP_MIN_STRENGTH = clamp(Number(process.env.AI_BOOTSTRAP_MIN_STRENGTH || 0.56), 0, 1);
const DEFAULT_BOOTSTRAP_MIN_EDGE_BPS = clamp(Number(process.env.AI_BOOTSTRAP_MIN_EDGE_BPS || 6), -5, 30);
const DEFAULT_BOOTSTRAP_WARMUP_MS = Math.max(30_000, Math.trunc(Number(process.env.AI_BOOTSTRAP_WARMUP_MS || 90_000)));
const DEFAULT_FALLBACK_MODELS = String(process.env.AI_FALLBACK_MODELS || 'gemini-2.5-flash-lite,gemini-2.0-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const PLAN_VERSION = 1 as const;

const normalizeSide = (raw?: string | null): StrategySide | null => {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return null;
  if (value === 'LONG' || value === 'BUY') return 'LONG';
  if (value === 'SHORT' || value === 'SELL') return 'SHORT';
  return null;
};

const normalizeJsonCandidate = (value: string): string => {
  return String(value || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, '"')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
};

const ALLOWED_TAGS: ReadonlySet<AIExplanationTag> = new Set([
  'OBI_UP',
  'OBI_DOWN',
  'DELTA_BURST',
  'CVD_TREND_UP',
  'CVD_TREND_DOWN',
  'VWAP_RECLAIM',
  'VWAP_REJECT',
  'OI_EXPANSION',
  'OI_CONTRACTION',
  'ABSORPTION_BUY',
  'ABSORPTION_SELL',
  'SPREAD_WIDE',
  'ACTIVITY_WEAK',
  'RISK_LOCK',
  'COOLDOWN_ACTIVE',
  'INTEGRITY_FAIL',
  'TREND_INTACT',
  'TREND_BROKEN',
]);

type RuntimeState = {
  lastAction: AIDecisionIntent | 'NONE';
  lastActionSide: StrategySide | null;
  lastEntryTs: number;
  lastAddTs: number;
  lastFlipTs: number;
  lastExitSide: StrategySide | null;
  holdStartTs: number;
  trendBias: StrategySide | null;
  trendBiasSinceTs: number;
  trendLongConfirmTicks: number;
  trendShortConfirmTicks: number;
  trendBreakConfirmTicks: number;
  trendLastStrength: number;
  trendIntact: boolean;
  lastTrendTakeProfitTs: number;
  bootstrapSeeded: boolean;
  bootstrapSeedStrength: number;
  bootstrapPhaseUntilTs: number;
  bootstrapWarmupUntilTs: number;
};

type MicroAlphaContext = {
  sideBias: StrategySide | null;
  longVotes: number;
  shortVotes: number;
  signalStrength: number;
  trendIntact: boolean;
  tradableFlow: boolean;
  spreadBps: number;
  expectedMoveBps: number;
  estimatedCostBps: number;
  expectedEdgeBps: number;
};

type TrendStateView = {
  bias: StrategySide | null;
  longScore: number;
  shortScore: number;
  strength: number;
  candidate: StrategySide | null;
  intact: boolean;
  ageMs: number | null;
  breakConfirm: number;
};

type BootstrapTrendSeed = {
  bias: StrategySide | null;
  strength: number;
  asOfMs: number;
};

const toTag = (raw: unknown): AIExplanationTag | null => {
  const value = String(raw || '').trim().toUpperCase() as AIExplanationTag;
  return ALLOWED_TAGS.has(value) ? value : null;
};

export class AIDryRunController {
  private active = false;
  private config: AIDryRunConfig | null = null;
  private symbols = new Set<string>();
  private readonly lastDecisionTs = new Map<string, number>();
  private readonly pending = new Set<string>();
  private readonly holdStreak = new Map<string, number>();
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly bootstrapTrendBySymbol = new Map<string, BootstrapTrendSeed>();
  private readonly guardrails = new SafetyGuardrails();
  private nonceSeq = 0;
  private holdDurationTotalMs = 0;
  private holdDurationSamples = 0;
  private readonly telemetry = {
    invalidLLMResponses: 0,
    repairCalls: 0,
    guardrailBlocks: 0,
    forcedExits: 0,
    flipsCount: 0,
    addsCount: 0,
    probeEntries: 0,
    edgeFilteredEntries: 0,
    holdOverrides: 0,
    avgHoldTimeMs: 0,
    feePct: null as number | null,
  };
  private lastError: string | null = null;

  constructor(
    private readonly dryRunSession: DryRunSessionService,
    private readonly decisionLog?: DecisionLog,
    private readonly log?: (event: string, data?: Record<string, unknown>) => void
  ) { }

  start(input: {
    symbols: string[];
    apiKey?: string;
    model?: string;
    decisionIntervalMs?: number;
    temperature?: number;
    maxOutputTokens?: number;
    localOnly?: boolean;
    bootstrapTrendBySymbol?: Record<string, { bias: 'LONG' | 'SHORT' | null; strength?: number; asOfMs?: number }>;
  }): void {
    const symbols = input.symbols.map((s) => s.toUpperCase()).filter(Boolean);
    const apiKey = String(input.apiKey || '').trim();
    const model = String(input.model || '').trim();
    const localOnly = Boolean(input.localOnly) || !apiKey || !model;
    this.symbols = new Set(symbols);
    this.config = {
      apiKey,
      model,
      decisionIntervalMs: clamp(
        Number(input.decisionIntervalMs ?? DEFAULT_DECISION_INTERVAL_MS),
        DEFAULT_MIN_DECISION_INTERVAL_MS,
        DEFAULT_MAX_DECISION_INTERVAL_MS
      ),
      temperature: Number.isFinite(input.temperature as number) ? Number(input.temperature) : 0,
      maxOutputTokens: Math.max(128, Number(input.maxOutputTokens ?? 512)),
      localOnly,
      minHoldMs: DEFAULT_MIN_HOLD_MS,
      flipCooldownMs: DEFAULT_FLIP_COOLDOWN_MS,
      minAddGapMs: DEFAULT_MIN_ADD_GAP_MS,
    };
    this.active = true;
    this.lastError = null;
    this.pending.clear();
    this.lastDecisionTs.clear();
    this.runtime.clear();
    this.bootstrapTrendBySymbol.clear();
    this.holdStreak.clear();
    this.nonceSeq = 0;
    this.holdDurationTotalMs = 0;
    this.holdDurationSamples = 0;
    this.telemetry.invalidLLMResponses = 0;
    this.telemetry.repairCalls = 0;
    this.telemetry.guardrailBlocks = 0;
    this.telemetry.forcedExits = 0;
    this.telemetry.flipsCount = 0;
    this.telemetry.addsCount = 0;
    this.telemetry.probeEntries = 0;
    this.telemetry.edgeFilteredEntries = 0;
    this.telemetry.holdOverrides = 0;
    this.telemetry.avgHoldTimeMs = 0;
    this.telemetry.feePct = null;
    for (const symbol of symbols) {
      const seed = input.bootstrapTrendBySymbol?.[symbol];
      if (!seed) continue;
      const bias = seed.bias === 'LONG' || seed.bias === 'SHORT' ? seed.bias : null;
      if (!bias) continue;
      this.bootstrapTrendBySymbol.set(symbol, {
        bias,
        strength: clamp(Number(seed.strength ?? 0.5), 0, 1),
        asOfMs: Math.max(0, Number(seed.asOfMs || Date.now())),
      });
    }
    this.log?.('AI_DRY_RUN_START', { symbols, model: this.config.model || null, localOnly });
  }

  stop(): void {
    this.active = false;
    this.symbols.clear();
    this.pending.clear();
    this.holdStreak.clear();
    this.runtime.clear();
    this.bootstrapTrendBySymbol.clear();
    this.log?.('AI_DRY_RUN_STOP', {});
  }

  isActive(): boolean {
    return this.active && !!this.config;
  }

  isTrackingSymbol(symbol: string): boolean {
    return this.isActive() && this.symbols.has(symbol.toUpperCase());
  }

  getStatus(): AIDryRunStatus {
    this.telemetry.avgHoldTimeMs = this.holdDurationSamples > 0
      ? Number((this.holdDurationTotalMs / this.holdDurationSamples).toFixed(2))
      : 0;
    return {
      active: this.isActive(),
      model: this.config?.model ? this.config.model : null,
      decisionIntervalMs: this.config?.decisionIntervalMs ?? 0,
      temperature: this.config?.temperature ?? 0,
      maxOutputTokens: this.config?.maxOutputTokens ?? 0,
      apiKeySet: Boolean(this.config?.apiKey),
      localOnly: Boolean(this.config?.localOnly),
      lastError: this.lastError,
      symbols: [...this.symbols],
      telemetry: { ...this.telemetry },
    };
  }

  getTrendStatus(symbol: string, nowMs = Date.now()): AITrendStatus | null {
    const normalized = String(symbol || '').toUpperCase();
    if (!this.isTrackingSymbol(normalized)) return null;

    const runtime = this.runtime.get(normalized);
    if (runtime) {
      const ageMs = runtime.trendBiasSinceTs > 0 ? Math.max(0, nowMs - runtime.trendBiasSinceTs) : null;
      return {
        side: runtime.trendBias,
        score: clamp(Number(runtime.trendLastStrength || 0), 0, 1),
        intact: Boolean(runtime.trendIntact),
        ageMs,
        breakConfirm: Math.max(0, Math.trunc(Number(runtime.trendBreakConfirmTicks || 0))),
        source: 'runtime',
      };
    }

    const seed = this.bootstrapTrendBySymbol.get(normalized);
    if (!seed) return null;
    return {
      side: seed.bias,
      score: clamp(Number(seed.strength || 0), 0, 1),
      intact: Boolean(seed.bias),
      ageMs: seed.asOfMs > 0 ? Math.max(0, nowMs - seed.asOfMs) : null,
      breakConfirm: 0,
      source: 'bootstrap',
    };
  }

  async onMetrics(snapshot: AIMetricsSnapshot): Promise<void> {
    if (!this.isActive() || !this.config) return;
    if (!this.isTrackingSymbol(snapshot.symbol)) return;

    const nowMs = Number(snapshot.timestampMs || Date.now());
    const intervalMs = this.computeAdaptiveDecisionInterval(snapshot);
    const lastTs = this.lastDecisionTs.get(snapshot.symbol) || 0;
    if (nowMs - lastTs < intervalMs) return;
    if (this.pending.has(snapshot.symbol)) return;

    const runtime = this.getRuntimeState(snapshot.symbol, nowMs);
    const runtimeContext = this.buildRuntimeContext(snapshot, runtime, nowMs);
    const preGuard = AI_UNRESTRICTED_MODE
      ? this.emptyGuardrailResult()
      : this.guardrails.evaluate(snapshot, runtimeContext, null);
    const blockedReasons = AI_UNRESTRICTED_MODE
      ? [...new Set([...(snapshot.blockedReasons || [])])]
      : [...new Set([...(snapshot.blockedReasons || []), ...preGuard.blockedReasons])];
    const microAlpha = this.computeMicroAlphaContext(snapshot);
    const trend = this.updateTrendState(runtime, snapshot, microAlpha, nowMs);
    const enrichedSnapshot = this.enrichSnapshot(snapshot, runtime, blockedReasons, runtimeContext, trend);
    const promptNonce = this.generatePromptNonce(snapshot.symbol, nowMs);
    const snapshotHash = this.hashSnapshot(enrichedSnapshot, promptNonce);

    this.log?.('AI_DECISION_START', {
      symbol: snapshot.symbol,
      gatePassed: snapshot.decision.gatePassed,
      nowMs,
      lastTs,
      interval: intervalMs,
      promptNonce,
      blockedReasons,
      sideBias: microAlpha.sideBias,
      signalStrength: Number(microAlpha.signalStrength.toFixed(4)),
      expectedEdgeBps: Number(microAlpha.expectedEdgeBps.toFixed(4)),
      tradableFlow: microAlpha.tradableFlow,
      trendBias: trend.bias,
      trendLongScore: Number(trend.longScore.toFixed(4)),
      trendShortScore: Number(trend.shortScore.toFixed(4)),
      trendStrength: Number(trend.strength.toFixed(4)),
      trendIntact: trend.intact,
      snapshotHash,
    });

    this.pending.add(snapshot.symbol);
    try {
      let proposedPlan: AIDecisionPlan;
      const canCallModel = !this.config.localOnly && Boolean(this.config.apiKey) && Boolean(this.config.model);
      if (!canCallModel) {
        proposedPlan = this.buildAutonomousMetricsPlan(enrichedSnapshot, promptNonce, microAlpha);
        this.lastError = null;
      } else {
        const prompt = this.buildPrompt(enrichedSnapshot, promptNonce, microAlpha);
        const resolved = await this.resolvePlanWithFallback(prompt, promptNonce, snapshot.symbol);
        const plan = resolved.plan;
        if (!plan) {
          this.telemetry.invalidLLMResponses += 1;
          this.lastError = resolved.error || 'ai_invalid_or_unparseable_response';
          proposedPlan = this.buildAutonomousMetricsPlan(enrichedSnapshot, promptNonce, microAlpha);
        } else {
          proposedPlan = plan;
          this.lastError = null;
        }
      }

      const orchestratedPlan = this.orchestratePlan(enrichedSnapshot, proposedPlan, microAlpha, trend, runtime);
      const postGuard = AI_UNRESTRICTED_MODE
        ? this.emptyGuardrailResult()
        : this.guardrails.evaluate(enrichedSnapshot, runtimeContext, orchestratedPlan);
      const resolvedPlan = AI_UNRESTRICTED_MODE
        ? orchestratedPlan
        : this.applyGuardrails(enrichedSnapshot, orchestratedPlan, postGuard);
      const decision = this.buildDecision(enrichedSnapshot, resolvedPlan, {
        promptNonce,
        blockedReasons: postGuard.blockedReasons,
        forcedAction: postGuard.forcedAction,
        microAlpha,
        snapshotHash,
      });

      const positionBefore = enrichedSnapshot.position ? { ...enrichedSnapshot.position } : null;
      const orders = this.dryRunSession.submitStrategyDecision(snapshot.symbol, decision, snapshot.timestampMs);
      const positionAfter = this.dryRunSession.getStrategyPosition(snapshot.symbol);
      const orderDetails = Array.isArray(orders)
        ? orders.map((order: any) => ({
          type: String(order?.type || ''),
          side: String(order?.side || ''),
          qty: Number(order?.qty || 0),
          price: Number.isFinite(Number(order?.price)) ? Number(order?.price) : null,
          reduceOnly: Boolean(order?.reduceOnly),
          postOnly: Boolean(order?.postOnly),
        }))
        : [];
      this.updateRuntime(enrichedSnapshot, runtime, resolvedPlan, nowMs, postGuard.forcedAction);
      this.lastDecisionTs.set(snapshot.symbol, nowMs);

      this.log?.('AI_DECISION_RESULT', {
        symbol: snapshot.symbol,
        promptNonce,
        proposedIntent: proposedPlan.intent,
        orchestratedIntent: orchestratedPlan.intent,
        intent: resolvedPlan.intent,
        confidence: resolvedPlan.confidence,
        tags: resolvedPlan.explanationTags,
        blockedReasons: postGuard.blockedReasons,
        forcedAction: postGuard.forcedAction,
        sideBias: microAlpha.sideBias,
        signalStrength: Number(microAlpha.signalStrength.toFixed(4)),
        expectedEdgeBps: Number(microAlpha.expectedEdgeBps.toFixed(4)),
        tradableFlow: microAlpha.tradableFlow,
        trendBias: trend.bias,
        trendStrength: Number(trend.strength.toFixed(4)),
        trendIntact: trend.intact,
        ordersCreated: orderDetails.length,
        orders: orderDetails,
        positionBefore,
        positionAfter,
        snapshotHash,
      });
    } catch (error: any) {
      this.lastError = error?.message || 'ai_decision_failed';
      this.telemetry.invalidLLMResponses += 1;
      this.log?.('AI_DRY_RUN_ERROR', { symbol: snapshot.symbol, error: this.lastError });
      const fallbackPlan = this.buildAutonomousMetricsPlan(enrichedSnapshot, promptNonce, microAlpha);
      const safeDecision = this.buildDecision(enrichedSnapshot, fallbackPlan, {
        promptNonce,
        blockedReasons: [],
        forcedAction: null,
        microAlpha,
        snapshotHash,
      });
      this.dryRunSession.submitStrategyDecision(snapshot.symbol, safeDecision, snapshot.timestampMs);
      this.lastDecisionTs.set(snapshot.symbol, nowMs);
    } finally {
      this.pending.delete(snapshot.symbol);
    }
  }

  private async resolvePlanWithFallback(
    prompt: string,
    promptNonce: string,
    symbol: string
  ): Promise<{ plan: AIDecisionPlan | null; error: string | null }> {
    if (!this.config || !this.config.apiKey || !this.config.model) {
      return { plan: null, error: 'ai_config_missing' };
    }

    const modelSequence = this.buildModelSequence(this.config.model);
    let lastError: string | null = null;

    for (const model of modelSequence) {
      try {
        this.log?.('AI_CALLING_GEMINI', { symbol, promptLen: prompt.length, promptNonce, model });
        const response = await generateContent({
          apiKey: this.config.apiKey,
          model,
          temperature: this.config.temperature,
          maxOutputTokens: this.config.maxOutputTokens,
          responseSchema: this.buildResponseSchema(),
        }, prompt);
        this.log?.('AI_GEMINI_RESPONSE', {
          symbol,
          model,
          promptNonce,
          finishReason: response.meta?.finishReason || null,
          blockReason: response.meta?.blockReason || null,
          hasText: Boolean(response.text),
          textLen: response.text ? response.text.length : 0,
        });

        let plan = this.parsePlan(response.text, promptNonce);
        if (!plan && response.text) {
          plan = await this.retryParsePlan(promptNonce, response.text, model);
        }
        if (plan) {
          return { plan, error: null };
        }

        lastError = 'ai_invalid_or_unparseable_response';
        this.log?.('AI_PARSE_FAILED', { symbol, model, promptNonce });
      } catch (error: any) {
        const message = String(error?.message || 'ai_decision_failed');
        lastError = message;
        this.log?.('AI_MODEL_CALL_FAILED', { symbol, model, promptNonce, error: message });
        if (!this.shouldTryNextModel(message)) {
          break;
        }
      }
    }

    return { plan: null, error: lastError || 'ai_invalid_or_unparseable_response' };
  }

  private buildModelSequence(primaryModel: string): string[] {
    const normalizedPrimary = String(primaryModel || '').trim();
    const sequence: string[] = [];
    if (normalizedPrimary) {
      sequence.push(normalizedPrimary);
    }
    for (const fallback of DEFAULT_FALLBACK_MODELS) {
      if (!fallback) continue;
      if (!sequence.some((item) => item.toLowerCase() === fallback.toLowerCase())) {
        sequence.push(fallback);
      }
    }
    return sequence;
  }

  private shouldTryNextModel(errorMessage: string): boolean {
    const msg = String(errorMessage || '').toLowerCase();
    if (!msg) return true;
    return (
      msg.includes('ai_http_429')
      || msg.includes('ai_http_500')
      || msg.includes('ai_http_502')
      || msg.includes('ai_http_503')
      || msg.includes('ai_http_504')
      || msg.includes('ai_http_404')
      || msg.includes('not found')
      || msg.includes('unavailable')
      || msg.includes('resource exhausted')
      || msg.includes('deadline exceeded')
    );
  }

  private buildPrompt(snapshot: AIMetricsSnapshot, nonce: string, microAlpha: MicroAlphaContext): string {
    const payload = {
      nonce,
      symbol: snapshot.symbol,
      timestampMs: snapshot.timestampMs,
      regime: snapshot.decision.regime,
      gatePassed: snapshot.decision.gatePassed,
      blockedReasons: snapshot.blockedReasons,
      riskState: snapshot.riskState,
      executionState: snapshot.executionState,
      market: snapshot.market,
      trades: snapshot.trades,
      openInterest: snapshot.openInterest,
      absorption: snapshot.absorption,
      volatility: snapshot.volatility,
      position: snapshot.position,
      microAlpha,
    };

    return [
      'You are an autonomous futures paper-trading decision engine.',
      'Return exactly one JSON object and no markdown.',
      'Act immediately from the current snapshot and live orderflow metrics.',
      'If flat, prefer ENTER right now instead of waiting.',
      'If in position, continuously decide MANAGE (add/reduce) or EXIT using metrics only.',
      'Use LIMIT order style only.',
      '',
      'Hard output rules:',
      '- Echo the nonce exactly.',
      '- version must be 1.',
      '- intent must be one of HOLD, ENTER, MANAGE, EXIT.',
      '- ENTER requires side LONG or SHORT.',
      '- side must be null only for HOLD.',
      '- sizeMultiplier in [0.1, 2.0].',
      '- maxAdds in [0, 5].',
      '- reducePct is null or in [0.1, 1.0].',
      '- explanationTags max length is 5.',
      '- Keep numeric values short (max 4 decimals).',
      '',
      'JSON schema fields:',
      '{"version":1,"nonce":"...","intent":"HOLD|ENTER|MANAGE|EXIT","side":"LONG|SHORT|null","urgency":"LOW|MED|HIGH","entryStyle":"LIMIT","sizeMultiplier":0.1,"maxAdds":0,"addRule":"WINNER_ONLY|TREND_INTACT|NEVER","addTrigger":{"minUnrealizedPnlPct":0.003,"trendIntact":true,"obiSupportMin":0.1,"deltaConfirm":true},"reducePct":null,"invalidationHint":"VWAP|ATR|OBI_FLIP|ABSORPTION_BREAK|NONE","explanationTags":["TREND_INTACT"],"confidence":0.0}',
      '',
      'Snapshot:',
      JSON.stringify(payload),
    ].join('\n');
  }

  private buildResponseSchema(): Record<string, unknown> {
    return {
      type: 'OBJECT',
      required: ['version', 'nonce', 'intent'],
      properties: {
        // Gemini schema validator expects string enums; keep version numeric and validate value in parser.
        version: { type: 'NUMBER' },
        nonce: { type: 'STRING' },
        intent: { type: 'STRING', enum: ['HOLD', 'ENTER', 'MANAGE', 'EXIT'] },
        side: { type: 'STRING', enum: ['LONG', 'SHORT'] },
        urgency: { type: 'STRING', enum: ['LOW', 'MED', 'HIGH'] },
        entryStyle: { type: 'STRING', enum: ['LIMIT'] },
        sizeMultiplier: { type: 'NUMBER' },
        maxAdds: { type: 'NUMBER' },
        addRule: { type: 'STRING', enum: ['WINNER_ONLY', 'TREND_INTACT', 'NEVER'] },
        addTrigger: {
          type: 'OBJECT',
          required: ['minUnrealizedPnlPct', 'trendIntact', 'obiSupportMin', 'deltaConfirm'],
          properties: {
            minUnrealizedPnlPct: { type: 'NUMBER' },
            trendIntact: { type: 'BOOLEAN' },
            obiSupportMin: { type: 'NUMBER' },
            deltaConfirm: { type: 'BOOLEAN' },
          },
        },
        reducePct: { type: 'NUMBER' },
        invalidationHint: { type: 'STRING', enum: ['VWAP', 'ATR', 'OBI_FLIP', 'ABSORPTION_BREAK', 'NONE'] },
        explanationTags: { type: 'ARRAY', items: { type: 'STRING' } },
        confidence: { type: 'NUMBER' },
      },
    };
  }

  private parsePlan(text: string | null, expectedNonce: string): AIDecisionPlan | null {
    const raw = this.extractJsonObject(text);
    if (!raw) {
      return this.parseLoosePlan(text, expectedNonce);
    }

    let parsed: Record<string, unknown>;
    try {
      const json = JSON.parse(raw);
      if (!json || typeof json !== 'object') {
        return this.parseLoosePlan(text, expectedNonce);
      }
      if (Array.isArray(json)) {
        const firstObject = json.find((item) => item && typeof item === 'object' && !Array.isArray(item));
        if (!firstObject || typeof firstObject !== 'object') {
          return this.parseLoosePlan(text, expectedNonce);
        }
        parsed = firstObject as Record<string, unknown>;
      } else {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      return this.parseLoosePlan(text, expectedNonce);
    }

    const version = Number(parsed.version ?? PLAN_VERSION);
    if (version !== PLAN_VERSION) return null;

    const nonceRaw = String(parsed.nonce || '').trim();
    const nonce = nonceRaw || expectedNonce;
    if (nonce !== expectedNonce) return null;

    const actionLike = parsed.intent ?? parsed.action ?? parsed.decision ?? parsed.tradeAction ?? parsed.type;
    const intent = this.parseIntent(actionLike);
    if (!intent) return null;

    const sideFromFields = normalizeSide(
      String(parsed.side ?? parsed.direction ?? parsed.positionSide ?? '')
    ) as 'LONG' | 'SHORT' | null;
    const sideFromAction = normalizeSide(String(actionLike || '')) as 'LONG' | 'SHORT' | null;
    const side = sideFromFields ?? sideFromAction;
    if (intent === 'ENTER' && !side) return null;

    const urgency = this.parseUrgency(parsed.urgency);
    const entryStyle = this.parseEntryStyle(parsed.entryStyle);
    const addRule = this.parseAddRule(parsed.addRule);
    const invalidationHint = this.parseInvalidationHint(parsed.invalidationHint);
    const confidence = clampPlanNumber(Number(parsed.confidence ?? 0.35), 0, 1);
    const sizeMultiplier = clampPlanNumber(Number(parsed.sizeMultiplier ?? 1), 0.1, 2);
    const maxAdds = clamp(Math.trunc(Number(parsed.maxAdds ?? 0)), 0, 5);

    const addTriggerInput = parsed.addTrigger && typeof parsed.addTrigger === 'object'
      ? parsed.addTrigger as Record<string, unknown>
      : {};
    const addTrigger = {
      minUnrealizedPnlPct: clampPlanNumber(Number(addTriggerInput.minUnrealizedPnlPct ?? DEFAULT_ADD_MIN_UPNL_PCT), -0.05, 0.05),
      trendIntact: Boolean(addTriggerInput.trendIntact),
      obiSupportMin: clampPlanNumber(Number(addTriggerInput.obiSupportMin ?? 0.1), -1, 1),
      deltaConfirm: Boolean(addTriggerInput.deltaConfirm),
    };

    const reduceRaw = parsed.reducePct;
    const reducePct = reduceRaw == null
      ? null
      : clampPlanNumber(Number(reduceRaw), 0.1, 1);

    const explanationTags = Array.isArray(parsed.explanationTags)
      ? parsed.explanationTags.map(toTag).filter((v): v is AIExplanationTag => Boolean(v)).slice(0, 5)
      : typeof parsed.explanationTags === 'string'
        ? String(parsed.explanationTags).split(',').map((tag) => toTag(tag)).filter((v): v is AIExplanationTag => Boolean(v)).slice(0, 5)
        : [];

    return {
      version: PLAN_VERSION,
      nonce,
      intent,
      side: side ?? null,
      urgency,
      entryStyle,
      sizeMultiplier,
      maxAdds,
      addRule,
      addTrigger,
      reducePct,
      invalidationHint,
      explanationTags,
      confidence,
    };
  }

  private extractJsonObject(text: string | null): string | null {
    const trimmed = normalizeJsonCandidate(String(text || '').trim());
    if (!trimmed) return null;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced && fenced[1] ? normalizeJsonCandidate(fenced[1]) : trimmed;

    const direct = this.tryParseJsonObject(candidate);
    if (direct) return direct;

    const balanced = this.extractBalancedJsonObject(candidate);
    if (balanced) return balanced;

    return null;
  }

  private tryParseJsonObject(candidate: string): string | null {
    const normalized = normalizeJsonCandidate(candidate);
    if (!normalized) return null;
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed)) {
          const firstObject = parsed.find((item) => item && typeof item === 'object' && !Array.isArray(item));
          if (!firstObject || typeof firstObject !== 'object') return null;
          return JSON.stringify(firstObject);
        }
        return JSON.stringify(parsed);
      }
    } catch {
      // ignore and continue to balanced extraction
    }
    return null;
  }

  private extractBalancedJsonObject(text: string): string | null {
    const source = String(text || '');
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] !== '{') continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let j = i; j < source.length; j += 1) {
        const ch = source[j];
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === '\\') {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') {
          depth += 1;
          continue;
        }
        if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            const candidate = normalizeJsonCandidate(source.slice(i, j + 1));
            const parsed = this.tryParseJsonObject(candidate);
            if (parsed) return parsed;
            break;
          }
        }
      }
    }
    return null;
  }

  private parseLoosePlan(text: string | null, expectedNonce: string): AIDecisionPlan | null {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const upper = raw.toUpperCase();
    const intent =
      upper.includes('ENTER') || upper.includes('ENTRY') || upper.includes('"ACTION":"BUY"') || upper.includes('"ACTION":"SELL"')
        ? 'ENTER'
        : upper.includes('ADD') || upper.includes('REDUCE') || upper.includes('MANAGE')
          ? 'MANAGE'
          : upper.includes('EXIT') || upper.includes('CLOSE')
            ? 'EXIT'
            : upper.includes('HOLD') || upper.includes('WAIT') || upper.includes('NOOP')
              ? 'HOLD'
              : null;
    if (!intent) return null;

    const side = intent === 'ENTER'
      ? (normalizeSide(upper.includes('SHORT') || upper.includes('SELL') ? 'SHORT' : upper.includes('LONG') || upper.includes('BUY') ? 'LONG' : '') as 'LONG' | 'SHORT' | null)
      : null;
    if (intent === 'ENTER' && !side) return null;

    return {
      version: PLAN_VERSION,
      nonce: expectedNonce,
      intent,
      side,
      urgency: 'MED',
      entryStyle: 'LIMIT',
      sizeMultiplier: 0.5,
      maxAdds: 1,
      addRule: 'WINNER_ONLY',
      addTrigger: {
        minUnrealizedPnlPct: DEFAULT_ADD_MIN_UPNL_PCT,
        trendIntact: false,
        obiSupportMin: 0.1,
        deltaConfirm: false,
      },
      reducePct: intent === 'MANAGE' && upper.includes('REDUCE') ? 0.5 : null,
      invalidationHint: 'NONE',
      explanationTags: [],
      confidence: 0.25,
    };
  }

  private async retryParsePlan(expectedNonce: string, rawText: string, modelOverride?: string): Promise<AIDecisionPlan | null> {
    if (!this.config || !this.config.apiKey || !this.config.model) return null;
    this.telemetry.repairCalls += 1;
    const retryPrompt = [
      'Return one valid JSON object only.',
      'Do not include markdown or explanation.',
      `Nonce must be exactly: ${expectedNonce}`,
      'version must be 1.',
      'intent must be HOLD, ENTER, MANAGE, or EXIT.',
      'Optional fields may be omitted.',
      'Use short numeric values.',
      `Minimal valid example: {"version":1,"nonce":"${expectedNonce}","intent":"HOLD","confidence":0.2}`,
      'Input:',
      rawText.slice(0, 4000),
    ].join('\n');
    try {
      const retryResponse = await generateContent({
        apiKey: this.config.apiKey,
        model: modelOverride || this.config.model,
        temperature: 0,
        maxOutputTokens: this.config.maxOutputTokens,
        responseSchema: this.buildResponseSchema(),
      }, retryPrompt);
      return this.parsePlan(retryResponse.text, expectedNonce);
    } catch {
      return null;
    }
  }

  private computeMicroAlphaContext(snapshot: AIMetricsSnapshot): MicroAlphaContext {
    const deltaSignal = Number(snapshot.market.delta1s || 0) + Number(snapshot.market.delta5s || 0);
    const cvdSignal = Number(snapshot.market.cvdSlope || 0);
    const obiSignal = Number(snapshot.market.obiDeep || 0);
    const absorptionSide = snapshot.absorption.side;
    const absorptionValue = Math.max(0, Number(snapshot.absorption.value || 0));

    const longVotes =
      (deltaSignal > 0 ? 1 : 0) +
      (cvdSignal > 0 ? 1 : 0) +
      (obiSignal > 0 ? 1 : 0) +
      (absorptionSide === 'buy' ? 1 : 0);
    const shortVotes =
      (deltaSignal < 0 ? 1 : 0) +
      (cvdSignal < 0 ? 1 : 0) +
      (obiSignal < 0 ? 1 : 0) +
      (absorptionSide === 'sell' ? 1 : 0);

    const sideBias: StrategySide | null =
      longVotes >= 2 && longVotes > shortVotes
        ? 'LONG'
        : shortVotes >= 2 && shortVotes > longVotes
          ? 'SHORT'
          : null;

    const deltaNorm = Math.abs(Math.tanh(deltaSignal / 4_000));
    const cvdNorm = Math.abs(Math.tanh(cvdSignal / 300_000));
    const obiNorm = clamp(Math.abs(obiSignal), 0, 1);
    const burstNorm = clamp(Number(snapshot.trades.burstCount || 0) / 6, 0, 1);
    const absorptionNorm = absorptionSide ? clamp(absorptionValue, 0, 1) : 0;
    const signalStrength = clamp(
      (deltaNorm * 0.34)
      + (cvdNorm * 0.24)
      + (obiNorm * 0.24)
      + (burstNorm * 0.12)
      + (absorptionNorm * 0.06),
      0,
      1
    );

    const trendIntact = sideBias != null
      ? (sideBias === 'LONG'
        ? (deltaSignal >= 0 && cvdSignal >= 0)
        : (deltaSignal <= 0 && cvdSignal <= 0))
      : false;

    const spreadPctRaw = Number(snapshot.market.spreadPct ?? 0);
    const spreadPct = Number.isFinite(spreadPctRaw) ? Math.abs(spreadPctRaw) : 0;
    const spreadBps = spreadPct * 100;
    const estimatedCostBps = (spreadBps * 0.5) + DEFAULT_ENTRY_FEE_BPS + DEFAULT_ENTRY_SLIPPAGE_BPS;
    const regimeBonus = snapshot.decision.regime === 'TR' ? 1.4 : snapshot.decision.regime === 'MR' ? 0.4 : 0.2;
    const flowBonus = clamp(Number(snapshot.trades.printsPerSecond || 0) / 12, 0, 1) * 1.4;
    const expectedMoveBps = 1.6 + (signalStrength * 10.5) + regimeBonus + flowBonus;
    const expectedEdgeBps = Number((expectedMoveBps - estimatedCostBps).toFixed(4));
    const tradableFlow =
      Number(snapshot.trades.printsPerSecond || 0) >= 0.5
      && Number(snapshot.trades.tradeCount || 0) >= 6
      && spreadPct <= 0.55
      && Boolean(snapshot.decision.gatePassed);

    return {
      sideBias,
      longVotes,
      shortVotes,
      signalStrength,
      trendIntact,
      tradableFlow,
      spreadBps,
      expectedMoveBps: Number(expectedMoveBps.toFixed(4)),
      estimatedCostBps: Number(estimatedCostBps.toFixed(4)),
      expectedEdgeBps,
    };
  }

  private updateTrendState(
    runtime: RuntimeState,
    snapshot: AIMetricsSnapshot,
    microAlpha: MicroAlphaContext,
    nowMs: number
  ): TrendStateView {
    const price = Number(snapshot.market.price || 0);
    const vwap = Number(snapshot.market.vwap || price || 1);
    const vwapGap = vwap > 0 ? (price - vwap) / vwap : 0;
    const vwapNorm = clamp(Math.tanh(vwapGap * 320), -1, 1);
    const deltaNorm = clamp(Math.tanh((Number(snapshot.market.delta1s || 0) + Number(snapshot.market.delta5s || 0)) / 4000), -1, 1);
    const cvdNorm = clamp(Math.tanh(Number(snapshot.market.cvdSlope || 0) / 250_000), -1, 1);
    const obiNorm = clamp(Number(snapshot.market.obiDeep || 0), -1, 1);
    const oiNorm = clamp(Number(snapshot.openInterest.oiChangePct || 0) / 1.2, -1, 1);
    const absorptionNorm = snapshot.absorption.side === 'buy'
      ? clamp(Number(snapshot.absorption.value || 0), 0, 1)
      : snapshot.absorption.side === 'sell'
        ? -clamp(Number(snapshot.absorption.value || 0), 0, 1)
        : 0;

    const directional = clamp(
      (vwapNorm * 0.28)
      + (deltaNorm * 0.22)
      + (cvdNorm * 0.2)
      + (obiNorm * 0.18)
      + (oiNorm * 0.07)
      + (absorptionNorm * 0.05),
      -1,
      1
    );

    const longScore = clamp((((directional + 1) * 0.5) * 0.75) + (microAlpha.signalStrength * 0.25), 0, 1);
    const shortScore = clamp(((((-directional) + 1) * 0.5) * 0.75) + (microAlpha.signalStrength * 0.25), 0, 1);
    const strength = Math.max(longScore, shortScore);
    const candidate: StrategySide | null =
      longScore >= DEFAULT_TREND_ENTRY_SCORE && (longScore - shortScore) >= DEFAULT_TREND_SIDE_GAP
        ? 'LONG'
        : shortScore >= DEFAULT_TREND_ENTRY_SCORE && (shortScore - longScore) >= DEFAULT_TREND_SIDE_GAP
          ? 'SHORT'
          : null;
    const inBootstrapPhase =
      runtime.bootstrapSeeded
      && runtime.bootstrapPhaseUntilTs > nowMs
      && runtime.trendBias != null;
    const breakScoreThreshold = inBootstrapPhase
      ? Math.max(0, DEFAULT_TREND_BREAK_SCORE - 0.06)
      : DEFAULT_TREND_BREAK_SCORE;
    const breakGapThreshold = inBootstrapPhase
      ? -DEFAULT_TREND_SIDE_GAP
      : (-DEFAULT_TREND_SIDE_GAP * 0.5);
    const breakConfirmRequired = inBootstrapPhase
      ? Math.max(DEFAULT_TREND_BREAK_CONFIRM_TICKS, Math.round(DEFAULT_TREND_BREAK_CONFIRM_TICKS * 1.8))
      : DEFAULT_TREND_BREAK_CONFIRM_TICKS;

    if (candidate === 'LONG') {
      runtime.trendLongConfirmTicks += 1;
      runtime.trendShortConfirmTicks = 0;
    } else if (candidate === 'SHORT') {
      runtime.trendShortConfirmTicks += 1;
      runtime.trendLongConfirmTicks = 0;
    } else {
      runtime.trendLongConfirmTicks = Math.max(0, runtime.trendLongConfirmTicks - 1);
      runtime.trendShortConfirmTicks = Math.max(0, runtime.trendShortConfirmTicks - 1);
    }

    const prevBias = runtime.trendBias;
    if (!runtime.trendBias) {
      if (runtime.trendLongConfirmTicks >= DEFAULT_TREND_CONFIRM_TICKS) {
        runtime.trendBias = 'LONG';
        runtime.trendBiasSinceTs = nowMs;
        runtime.trendBreakConfirmTicks = 0;
      } else if (runtime.trendShortConfirmTicks >= DEFAULT_TREND_CONFIRM_TICKS) {
        runtime.trendBias = 'SHORT';
        runtime.trendBiasSinceTs = nowMs;
        runtime.trendBreakConfirmTicks = 0;
      }
    } else {
      const sameScore = runtime.trendBias === 'LONG' ? longScore : shortScore;
      const oppositeScore = runtime.trendBias === 'LONG' ? shortScore : longScore;
      const intactNow =
        sameScore >= breakScoreThreshold
        && (sameScore - oppositeScore) >= breakGapThreshold;
      if (intactNow) {
        runtime.trendBreakConfirmTicks = 0;
        runtime.trendIntact = true;
      } else {
        runtime.trendBreakConfirmTicks += 1;
      }
      if (runtime.trendBreakConfirmTicks >= breakConfirmRequired) {
        if (candidate && candidate !== runtime.trendBias) {
          runtime.trendBias = candidate;
          runtime.trendBiasSinceTs = nowMs;
          runtime.trendBreakConfirmTicks = 0;
          runtime.trendIntact = true;
        } else {
          runtime.trendBias = null;
          runtime.trendBiasSinceTs = 0;
          runtime.trendIntact = false;
          runtime.trendBreakConfirmTicks = 0;
        }
      }
    }

    if (runtime.trendBias) {
      const sameScore = runtime.trendBias === 'LONG' ? longScore : shortScore;
      const oppositeScore = runtime.trendBias === 'LONG' ? shortScore : longScore;
      runtime.trendIntact =
        sameScore >= breakScoreThreshold
        && (sameScore - oppositeScore) >= breakGapThreshold;
    } else {
      runtime.trendIntact = false;
    }

    runtime.trendLastStrength = strength;
    if (prevBias !== runtime.trendBias) {
      this.log?.('AI_TREND_BIAS_CHANGE', {
        symbol: snapshot.symbol,
        previousBias: prevBias,
        nextBias: runtime.trendBias,
        longScore: Number(longScore.toFixed(4)),
        shortScore: Number(shortScore.toFixed(4)),
        strength: Number(strength.toFixed(4)),
      });
    }

    return {
      bias: runtime.trendBias,
      longScore,
      shortScore,
      strength,
      candidate,
      intact: runtime.trendIntact,
      ageMs: runtime.trendBiasSinceTs > 0 ? Math.max(0, nowMs - runtime.trendBiasSinceTs) : null,
      breakConfirm: runtime.trendBreakConfirmTicks,
    };
  }

  private orchestratePlan(
    snapshot: AIMetricsSnapshot,
    plan: AIDecisionPlan,
    microAlpha: MicroAlphaContext,
    trend: TrendStateView,
    runtime: RuntimeState
  ): AIDecisionPlan {
    if (AI_UNRESTRICTED_MODE) {
      return this.orchestrateUnrestrictedPlan(snapshot, plan, microAlpha);
    }

    const flat = !snapshot.position;
    const holdStreak = Number(snapshot.executionState.holdStreak || 0);
    const blocked = Array.isArray(snapshot.blockedReasons) && snapshot.blockedReasons.length > 0;
    const trendBias = trend.bias;
    const trendIntact = trend.intact;
    const trendStrength = Number(trend.strength || 0);
    const position = snapshot.position;
    const nowMs = Number(snapshot.timestampMs || Date.now());
    const bootstrapPhaseMsRemaining = runtime.bootstrapPhaseUntilTs > nowMs
      ? Math.max(0, runtime.bootstrapPhaseUntilTs - nowMs)
      : 0;
    const bootstrapWarmupMsRemaining = runtime.bootstrapWarmupUntilTs > nowMs
      ? Math.max(0, runtime.bootstrapWarmupUntilTs - nowMs)
      : 0;
    const warmupComplete = bootstrapWarmupMsRemaining <= 0;
    const bootstrapPhaseActive =
      flat
      && runtime.bootstrapSeeded
      && runtime.bootstrapSeedStrength >= DEFAULT_BOOTSTRAP_MIN_STRENGTH
      && bootstrapPhaseMsRemaining > 0
      && Boolean(trendBias)
      && warmupComplete;

    if (plan.intent === 'ENTER' && flat && !warmupComplete) {
      this.log?.('AI_ENTRY_DELAYED_WARMUP', {
        symbol: snapshot.symbol,
        warmupMsRemaining: bootstrapWarmupMsRemaining,
      });
      return this.buildSafeHoldPlan(plan.nonce, 'COOLDOWN_ACTIVE');
    }

    if (trendBias && plan.intent === 'ENTER') {
      const currentSide = plan.side ? (plan.side as StrategySide) : null;
      if (!currentSide || currentSide !== trendBias) {
        const aligned: AIDecisionPlan = {
          ...plan,
          side: trendBias,
          explanationTags: this.pushTag(plan.explanationTags, 'TREND_INTACT'),
          confidence: clampPlanNumber(Math.max(Number(plan.confidence || 0), 0.35 + (trendStrength * 0.4)), 0, 1),
        };
        this.log?.('AI_TREND_SIDE_LOCK', {
          symbol: snapshot.symbol,
          originalSide: currentSide,
          alignedSide: trendBias,
          trendStrength: Number(trendStrength.toFixed(4)),
        });
        plan = aligned;
      }
    }

    if ((plan.intent === 'EXIT' || (plan.intent === 'MANAGE' && plan.reducePct != null)) && position) {
      const oppositeTrend: StrategySide = position.side === 'LONG' ? 'SHORT' : 'LONG';
      const oppositeTrendConfirmed = Boolean(trendBias && trendIntact && trendBias === oppositeTrend);

      if (!oppositeTrendConfirmed) {
        const upnl = Number(position.unrealizedPnlPct || 0);
        const trendAligned = Boolean(trendBias && trendBias === position.side && trendIntact);
        const defensiveAddEligible =
          trendAligned
          && upnl <= DEFAULT_PULLBACK_ADD_TRIGGER_UPNL_PCT
          && upnl >= -DEFAULT_PULLBACK_ADD_MAX_ADVERSE_PCT
          && snapshot.decision.gatePassed
          && !blocked
          && (microAlpha.tradableFlow || microAlpha.signalStrength >= DEFAULT_TREND_DEFENSE_MIN_SIGNAL);

        if (defensiveAddEligible) {
          this.log?.('AI_CLOSE_BLOCKED_TO_TREND_PULLBACK_ADD', {
            symbol: snapshot.symbol,
            positionSide: position.side,
            trendBias,
            trendIntact,
            upnlPct: Number(upnl.toFixed(6)),
            signalStrength: Number(microAlpha.signalStrength.toFixed(4)),
          });
          return {
            ...plan,
            intent: 'MANAGE',
            side: position.side,
            reducePct: null,
            sizeMultiplier: clampPlanNumber(
              Math.max(Number(plan.sizeMultiplier || 0), DEFAULT_PULLBACK_ADD_SIZE_MULT + (microAlpha.signalStrength * 0.25)),
              0.15,
              1.4
            ),
            maxAdds: Math.max(Number(plan.maxAdds || 0), 4),
            addRule: 'TREND_INTACT',
            addTrigger: {
              minUnrealizedPnlPct: -DEFAULT_PULLBACK_ADD_MAX_ADVERSE_PCT,
              trendIntact: true,
              obiSupportMin: 0,
              deltaConfirm: false,
            },
            explanationTags: this.pushTag(plan.explanationTags, 'TREND_INTACT'),
            confidence: clampPlanNumber(Math.max(Number(plan.confidence || 0), 0.45 + (trendStrength * 0.3)), 0, 1),
          };
        }

        this.log?.('AI_CLOSE_BLOCKED_TREND_LOCK', {
          symbol: snapshot.symbol,
          positionSide: position.side,
          trendBias,
          trendIntact,
          oppositeTrendRequired: oppositeTrend,
        });
        return {
          ...plan,
          intent: 'HOLD',
          side: null,
          reducePct: null,
          explanationTags: this.pushTag(plan.explanationTags, trendAligned ? 'TREND_INTACT' : 'TREND_BROKEN'),
          confidence: clampPlanNumber(Math.max(Number(plan.confidence || 0), 0.4), 0, 1),
        };
      }
    }

    if (
      trendBias
      && position
      && position.side === trendBias
      && trendIntact
      && plan.intent === 'HOLD'
    ) {
      const upnl = Number(position.unrealizedPnlPct || 0);

      const pullbackEligible =
        upnl <= DEFAULT_PULLBACK_ADD_TRIGGER_UPNL_PCT
        && upnl >= -DEFAULT_PULLBACK_ADD_MAX_ADVERSE_PCT
        && snapshot.decision.gatePassed
        && !blocked
        && microAlpha.tradableFlow
        && microAlpha.expectedEdgeBps >= DEFAULT_PULLBACK_ADD_EDGE_BPS;
      if (pullbackEligible) {
        this.telemetry.holdOverrides += 1;
        this.log?.('AI_HOLD_OVERRIDE_TO_PULLBACK_ADD', {
          symbol: snapshot.symbol,
          upnlPct: Number(upnl.toFixed(6)),
          edgeBps: Number(microAlpha.expectedEdgeBps.toFixed(4)),
          trendBias,
          trendStrength: Number(trendStrength.toFixed(4)),
        });
        return {
          ...plan,
          intent: 'MANAGE',
          side: position.side,
          reducePct: null,
          sizeMultiplier: clampPlanNumber(
            Math.max(Number(plan.sizeMultiplier || 0), DEFAULT_PULLBACK_ADD_SIZE_MULT + (microAlpha.signalStrength * 0.2)),
            0.1,
            1.3
          ),
          maxAdds: Math.max(Number(plan.maxAdds || 0), 3),
          addRule: 'TREND_INTACT',
          addTrigger: {
            minUnrealizedPnlPct: -DEFAULT_PULLBACK_ADD_MAX_ADVERSE_PCT,
            trendIntact: true,
            obiSupportMin: 0.06,
            deltaConfirm: true,
          },
          explanationTags: this.pushTag(plan.explanationTags, 'TREND_INTACT'),
          confidence: clampPlanNumber(Math.max(Number(plan.confidence || 0), 0.5 + (microAlpha.signalStrength * 0.22)), 0, 1),
        };
      }
    }

    if (plan.intent === 'HOLD') {
      const firstEntrySide = (trendBias || microAlpha.sideBias) as StrategySide | null;
      const firstEntryStrength = trendBias ? trendStrength : microAlpha.signalStrength;
      const firstEntryIntact = trendBias ? trendIntact : microAlpha.trendIntact;
      const isFirstEntryPending = flat && runtime.lastEntryTs <= 0;
      const shouldForceFirstEntry =
        isFirstEntryPending
        && snapshot.decision.gatePassed
        && !blocked
        && warmupComplete
        && microAlpha.tradableFlow
        && Boolean(firstEntrySide)
        && firstEntryIntact
        && firstEntryStrength >= DEFAULT_FIRST_ENTRY_MIN_STRENGTH
        && holdStreak >= DEFAULT_FIRST_ENTRY_HOLD_STREAK
        && microAlpha.expectedEdgeBps >= DEFAULT_FIRST_ENTRY_EDGE_BPS;
      if (shouldForceFirstEntry) {
        this.telemetry.holdOverrides += 1;
        this.telemetry.probeEntries += 1;
        const firstEntry = this.buildProbeEnterPlan(plan.nonce, microAlpha, firstEntrySide);
        const tunedFirstEntry: AIDecisionPlan = {
          ...firstEntry,
          sizeMultiplier: clampPlanNumber(
            Math.max(Number(firstEntry.sizeMultiplier || 0.25), 0.3 + (firstEntryStrength * 0.35)),
            0.2,
            1.1
          ),
          confidence: clampPlanNumber(Math.max(Number(firstEntry.confidence || 0), 0.5 + (firstEntryStrength * 0.3)), 0, 1),
          explanationTags: this.pushTag(firstEntry.explanationTags, 'TREND_INTACT'),
        };
        this.log?.('AI_HOLD_OVERRIDE_TO_FIRST_ENTRY', {
          symbol: snapshot.symbol,
          holdStreak,
          side: tunedFirstEntry.side,
          expectedEdgeBps: Number(microAlpha.expectedEdgeBps.toFixed(4)),
          strength: Number(firstEntryStrength.toFixed(4)),
          thresholdEdgeBps: DEFAULT_FIRST_ENTRY_EDGE_BPS,
        });
        return tunedFirstEntry;
      }

      const shouldBootstrapEnter =
        bootstrapPhaseActive
        && snapshot.decision.gatePassed
        && !blocked
        && microAlpha.tradableFlow
        && microAlpha.expectedEdgeBps >= DEFAULT_BOOTSTRAP_MIN_EDGE_BPS;
      if (shouldBootstrapEnter) {
        this.telemetry.holdOverrides += 1;
        const bootstrapEnter = this.buildBootstrapEnterPlan(plan.nonce, microAlpha, trendBias as StrategySide, runtime.bootstrapSeedStrength);
        this.log?.('AI_BOOTSTRAP_ENTER', {
          symbol: snapshot.symbol,
          side: bootstrapEnter.side,
          edgeBps: Number(microAlpha.expectedEdgeBps.toFixed(4)),
          seedStrength: Number(runtime.bootstrapSeedStrength.toFixed(4)),
          bootstrapPhaseMsRemaining,
        });
        return bootstrapEnter;
      }
      const shouldProbe =
        flat
        && snapshot.decision.gatePassed
        && !blocked
        && warmupComplete
        && microAlpha.tradableFlow
        && (trendBias != null || microAlpha.sideBias != null)
        && holdStreak >= DEFAULT_PROBE_HOLD_STREAK
        && microAlpha.expectedEdgeBps >= DEFAULT_PROBE_EDGE_BPS;
      if (shouldProbe) {
        this.telemetry.holdOverrides += 1;
        this.telemetry.probeEntries += 1;
        const probe = this.buildProbeEnterPlan(plan.nonce, microAlpha, trendBias);
        this.log?.('AI_HOLD_OVERRIDE_TO_PROBE', {
          symbol: snapshot.symbol,
          holdStreak,
          expectedEdgeBps: Number(microAlpha.expectedEdgeBps.toFixed(4)),
          side: probe.side,
          urgency: probe.urgency,
          entryStyle: probe.entryStyle,
          sizeMultiplier: probe.sizeMultiplier,
        });
        return probe;
      }
      return plan;
    }

    if (plan.intent === 'ENTER') {
      if (!microAlpha.tradableFlow || microAlpha.expectedEdgeBps < DEFAULT_EDGE_MIN_BPS) {
        this.telemetry.edgeFilteredEntries += 1;
        this.log?.('AI_ENTRY_DEMOTED_EDGE', {
          symbol: snapshot.symbol,
          expectedEdgeBps: Number(microAlpha.expectedEdgeBps.toFixed(4)),
          tradableFlow: microAlpha.tradableFlow,
          threshold: DEFAULT_EDGE_MIN_BPS,
        });
        return this.buildSafeHoldPlan(plan.nonce, 'EDGE_TOO_WEAK');
      }

      const tuned: AIDecisionPlan = { ...plan };
      if (!tuned.side && (trendBias || microAlpha.sideBias)) {
        tuned.side = (trendBias || microAlpha.sideBias) as 'LONG' | 'SHORT';
      }
      if (trendBias && tuned.side && tuned.side !== trendBias) {
        tuned.side = trendBias;
      } else if (microAlpha.sideBias && tuned.side && tuned.side !== microAlpha.sideBias && microAlpha.signalStrength >= DEFAULT_SIDE_ALIGN_STRENGTH) {
        tuned.side = microAlpha.sideBias;
      }
      tuned.urgency = this.deriveUrgencyFromEdge(microAlpha.expectedEdgeBps);
      tuned.entryStyle = this.deriveEntryStyle(microAlpha.expectedEdgeBps, microAlpha.spreadBps);
      const baseSize = clampPlanNumber(Number(tuned.sizeMultiplier ?? 1), 0.1, 2);
      const edgeScaled = clamp(0.35 + (microAlpha.signalStrength * 0.9), 0.25, 1.6);
      tuned.sizeMultiplier = clampPlanNumber((baseSize * 0.5) + (edgeScaled * 0.5), 0.1, 2);
      tuned.confidence = clampPlanNumber(Math.max(Number(tuned.confidence || 0), 0.2 + (microAlpha.signalStrength * 0.6)), 0, 1);
      tuned.addTrigger = {
        ...tuned.addTrigger,
        trendIntact: tuned.addTrigger.trendIntact || microAlpha.trendIntact,
      };
      tuned.explanationTags = this.pushTag(tuned.explanationTags, microAlpha.trendIntact ? 'TREND_INTACT' : 'TREND_BROKEN');
      return tuned;
    }

    if (plan.intent === 'MANAGE' && this.planImpliesAdd(plan) && microAlpha.expectedEdgeBps < Math.max(-0.2, DEFAULT_EDGE_MIN_BPS * 0.25)) {
      this.log?.('AI_ADD_DEMOTED_EDGE', {
        symbol: snapshot.symbol,
        expectedEdgeBps: Number(microAlpha.expectedEdgeBps.toFixed(4)),
      });
      return this.buildSafeHoldPlan(plan.nonce, 'EDGE_TOO_WEAK');
    }

    return plan;
  }

  private resolveMetricsSide(snapshot: AIMetricsSnapshot, microAlpha: MicroAlphaContext): 'LONG' | 'SHORT' {
    if (microAlpha.sideBias) {
      return microAlpha.sideBias;
    }
    const directional =
      Number(snapshot.market.delta1s || 0)
      + Number(snapshot.market.delta5s || 0)
      + Number(snapshot.market.cvdSlope || 0)
      + Number(snapshot.market.obiDeep || 0);
    return directional >= 0 ? 'LONG' : 'SHORT';
  }

  private buildAutonomousMetricsPlan(
    snapshot: AIMetricsSnapshot,
    nonce: string,
    microAlpha: MicroAlphaContext
  ): AIDecisionPlan {
    const signalSide = this.resolveMetricsSide(snapshot, microAlpha);
    const signalStrength = clamp(Number(microAlpha.signalStrength || 0), 0, 1);
    const upnl = Number(snapshot.position?.unrealizedPnlPct || 0);
    const position = snapshot.position;

    if (!position) {
      return {
        version: PLAN_VERSION,
        nonce,
        intent: 'ENTER',
        side: signalSide,
        urgency: signalStrength >= 0.65 ? 'HIGH' : signalStrength >= 0.35 ? 'MED' : 'LOW',
        entryStyle: 'LIMIT',
        sizeMultiplier: clampPlanNumber(0.8 + (signalStrength * 0.7), 0.2, 2),
        maxAdds: 5,
        addRule: 'TREND_INTACT',
        addTrigger: {
          minUnrealizedPnlPct: -0.02,
          trendIntact: true,
          obiSupportMin: 0,
          deltaConfirm: false,
        },
        reducePct: null,
        invalidationHint: 'NONE',
        explanationTags: [signalSide === 'LONG' ? 'OBI_UP' : 'OBI_DOWN', 'DELTA_BURST'],
        confidence: clampPlanNumber(0.4 + (signalStrength * 0.5), 0.2, 0.99),
      };
    }

    const sameSide = position.side === signalSide;
    if (sameSide) {
      const shouldTakeProfit = upnl >= 0.004 && signalStrength < 0.2;
      if (shouldTakeProfit) {
        return {
          version: PLAN_VERSION,
          nonce,
          intent: 'MANAGE',
          side: position.side,
          urgency: 'MED',
          entryStyle: 'LIMIT',
          sizeMultiplier: 0.2,
          maxAdds: 0,
          addRule: 'NEVER',
          addTrigger: {
            minUnrealizedPnlPct: 0,
            trendIntact: false,
            obiSupportMin: 0,
            deltaConfirm: false,
          },
          reducePct: 0.35,
          invalidationHint: 'NONE',
          explanationTags: ['TREND_BROKEN'],
          confidence: 0.8,
        };
      }

      const shouldAdd = signalStrength >= 0.25;
      if (shouldAdd) {
        return {
          version: PLAN_VERSION,
          nonce,
          intent: 'MANAGE',
          side: position.side,
          urgency: signalStrength >= 0.65 ? 'HIGH' : 'MED',
          entryStyle: 'LIMIT',
          sizeMultiplier: clampPlanNumber(0.45 + (signalStrength * 0.6), 0.2, 1.6),
          maxAdds: 5,
          addRule: 'TREND_INTACT',
          addTrigger: {
            minUnrealizedPnlPct: -0.02,
            trendIntact: true,
            obiSupportMin: 0,
            deltaConfirm: false,
          },
          reducePct: null,
          invalidationHint: 'NONE',
          explanationTags: ['TREND_INTACT'],
          confidence: clampPlanNumber(0.45 + (signalStrength * 0.45), 0.2, 0.95),
        };
      }

      return {
        version: PLAN_VERSION,
        nonce,
        intent: 'HOLD',
        side: null,
        urgency: 'LOW',
        entryStyle: 'LIMIT',
        sizeMultiplier: 0.1,
        maxAdds: 0,
        addRule: 'NEVER',
        addTrigger: {
          minUnrealizedPnlPct: 0,
          trendIntact: false,
          obiSupportMin: 0,
          deltaConfirm: false,
        },
        reducePct: null,
        invalidationHint: 'NONE',
        explanationTags: ['TREND_INTACT'],
        confidence: 0.35,
      };
    }

    if (upnl > 0 || signalStrength >= 0.35) {
      return {
        version: PLAN_VERSION,
        nonce,
        intent: 'EXIT',
        side: null,
        urgency: signalStrength >= 0.65 ? 'HIGH' : 'MED',
        entryStyle: 'LIMIT',
        sizeMultiplier: 0.1,
        maxAdds: 0,
        addRule: 'NEVER',
        addTrigger: {
          minUnrealizedPnlPct: 0,
          trendIntact: false,
          obiSupportMin: 0,
          deltaConfirm: false,
        },
        reducePct: null,
        invalidationHint: 'NONE',
        explanationTags: ['TREND_BROKEN'],
        confidence: 0.9,
      };
    }

    return {
      version: PLAN_VERSION,
      nonce,
      intent: 'MANAGE',
      side: position.side,
      urgency: 'MED',
      entryStyle: 'LIMIT',
      sizeMultiplier: 0.2,
      maxAdds: 0,
      addRule: 'NEVER',
      addTrigger: {
        minUnrealizedPnlPct: 0,
        trendIntact: false,
        obiSupportMin: 0,
        deltaConfirm: false,
      },
      reducePct: 0.5,
      invalidationHint: 'NONE',
      explanationTags: ['TREND_BROKEN'],
      confidence: 0.7,
    };
  }

  private orchestrateUnrestrictedPlan(
    snapshot: AIMetricsSnapshot,
    plan: AIDecisionPlan,
    microAlpha: MicroAlphaContext
  ): AIDecisionPlan {
    const fallback = this.buildAutonomousMetricsPlan(snapshot, plan.nonce, microAlpha);
    const normalized: AIDecisionPlan = {
      ...plan,
      entryStyle: 'LIMIT',
      urgency: plan.urgency || 'MED',
      sizeMultiplier: clampPlanNumber(Number(plan.sizeMultiplier ?? 1), 0.1, 2),
      maxAdds: clamp(Math.trunc(Number(plan.maxAdds ?? 0)), 0, 5),
      addRule: plan.addRule || 'TREND_INTACT',
      addTrigger: {
        minUnrealizedPnlPct: clampPlanNumber(Number(plan.addTrigger?.minUnrealizedPnlPct ?? -0.02), -0.05, 0.05),
        trendIntact: Boolean(plan.addTrigger?.trendIntact ?? true),
        obiSupportMin: clampPlanNumber(Number(plan.addTrigger?.obiSupportMin ?? 0), -1, 1),
        deltaConfirm: Boolean(plan.addTrigger?.deltaConfirm ?? false),
      },
      reducePct: plan.reducePct == null ? null : clampPlanNumber(Number(plan.reducePct), 0.1, 1),
      explanationTags: Array.isArray(plan.explanationTags) ? plan.explanationTags.slice(0, 5) : [],
      confidence: clampPlanNumber(Number(plan.confidence ?? 0.5), 0, 1),
    };

    if (!snapshot.position) {
      if (normalized.intent !== 'ENTER') {
        return fallback;
      }
      if (!normalized.side) {
        normalized.side = this.resolveMetricsSide(snapshot, microAlpha);
      }
      if (!normalized.side) {
        return fallback;
      }
      normalized.maxAdds = Math.max(3, normalized.maxAdds);
      normalized.entryStyle = 'LIMIT';
      return normalized;
    }

    if (normalized.intent === 'MANAGE' && normalized.reducePct == null) {
      normalized.maxAdds = Math.max(3, normalized.maxAdds);
    }

    if (normalized.intent === 'HOLD') {
      return fallback;
    }

    if (normalized.intent === 'ENTER' && normalized.side) {
      if (snapshot.position.side === normalized.side) {
        return {
          ...normalized,
          intent: 'MANAGE',
          side: snapshot.position.side,
          reducePct: null,
          addRule: 'TREND_INTACT',
          maxAdds: Math.max(1, normalized.maxAdds),
          entryStyle: 'LIMIT',
        };
      }
      return {
        ...normalized,
        intent: 'EXIT',
        side: null,
        reducePct: null,
        addRule: 'NEVER',
        maxAdds: 0,
        entryStyle: 'LIMIT',
      };
    }

    if (normalized.intent === 'ENTER' && !normalized.side) {
      return fallback;
    }

    return normalized;
  }

  private buildProbeEnterPlan(nonce: string, microAlpha: MicroAlphaContext, forcedSide?: StrategySide | null): AIDecisionPlan {
    const side: 'LONG' | 'SHORT' = forcedSide === 'SHORT' || microAlpha.sideBias === 'SHORT' ? 'SHORT' : 'LONG';
    const sizeMultiplier = clampPlanNumber(DEFAULT_PROBE_SIZE_MULT + (microAlpha.signalStrength * 0.35), 0.1, 1.2);
    const firstTag = side === 'LONG' ? 'OBI_UP' : 'OBI_DOWN';
    return {
      version: PLAN_VERSION,
      nonce,
      intent: 'ENTER',
      side,
      urgency: this.deriveUrgencyFromEdge(microAlpha.expectedEdgeBps),
      entryStyle: this.deriveEntryStyle(microAlpha.expectedEdgeBps, microAlpha.spreadBps),
      sizeMultiplier,
      maxAdds: 2,
      addRule: 'TREND_INTACT',
      addTrigger: {
        minUnrealizedPnlPct: -Math.min(DEFAULT_PULLBACK_ADD_MAX_ADVERSE_PCT, 0.003),
        trendIntact: microAlpha.trendIntact,
        obiSupportMin: 0.08,
        deltaConfirm: true,
      },
      reducePct: null,
      invalidationHint: 'VWAP',
      explanationTags: [firstTag, 'DELTA_BURST', microAlpha.trendIntact ? 'TREND_INTACT' : 'TREND_BROKEN']
        .filter((tag): tag is AIExplanationTag => ALLOWED_TAGS.has(tag as AIExplanationTag))
        .slice(0, 5),
      confidence: clampPlanNumber(0.45 + (microAlpha.signalStrength * 0.4), 0, 0.95),
    };
  }

  private buildBootstrapEnterPlan(
    nonce: string,
    microAlpha: MicroAlphaContext,
    trendBias: StrategySide,
    seedStrength: number
  ): AIDecisionPlan {
    const side: 'LONG' | 'SHORT' = trendBias === 'SHORT' ? 'SHORT' : 'LONG';
    const sizeMultiplier = clampPlanNumber(
      0.35 + (clamp(seedStrength, 0, 1) * 0.35) + (clamp(microAlpha.signalStrength, 0, 1) * 0.2),
      0.25,
      0.95
    );
    const firstTag: AIExplanationTag = side === 'LONG' ? 'OBI_UP' : 'OBI_DOWN';
    return {
      version: PLAN_VERSION,
      nonce,
      intent: 'ENTER',
      side,
      urgency: this.deriveUrgencyFromEdge(Math.max(microAlpha.expectedEdgeBps, DEFAULT_BOOTSTRAP_MIN_EDGE_BPS)),
      entryStyle: 'LIMIT',
      sizeMultiplier,
      maxAdds: 2,
      addRule: 'TREND_INTACT',
      addTrigger: {
        minUnrealizedPnlPct: -Math.min(DEFAULT_PULLBACK_ADD_MAX_ADVERSE_PCT, 0.0035),
        trendIntact: true,
        obiSupportMin: 0.12,
        deltaConfirm: true,
      },
      reducePct: null,
      invalidationHint: 'VWAP',
      explanationTags: [firstTag, 'TREND_INTACT'],
      confidence: clampPlanNumber(0.5 + (clamp(seedStrength, 0, 1) * 0.3) + (clamp(microAlpha.signalStrength, 0, 1) * 0.2), 0, 0.96),
    };
  }

  private deriveUrgencyFromEdge(expectedEdgeBps: number): AIUrgency {
    if (expectedEdgeBps >= 6) return 'HIGH';
    if (expectedEdgeBps >= 2) return 'MED';
    return 'LOW';
  }

  private deriveEntryStyle(expectedEdgeBps: number, spreadBps: number): AIEntryStyle {
    return 'LIMIT';
  }

  private pushTag(tags: AIExplanationTag[] | undefined, tag: AIExplanationTag): AIExplanationTag[] {
    const next = Array.isArray(tags) ? [...tags] : [];
    if (!ALLOWED_TAGS.has(tag)) return next.slice(0, 5);
    if (!next.includes(tag)) next.push(tag);
    return next.slice(0, 5);
  }

  private emptyGuardrailResult(): ReturnType<SafetyGuardrails['evaluate']> {
    return {
      blockedReasons: [],
      blockEntry: false,
      blockAdd: false,
      blockFlip: false,
      forcedAction: null,
    };
  }

  private applyGuardrails(
    snapshot: AIMetricsSnapshot,
    plan: AIDecisionPlan,
    guardrails: ReturnType<SafetyGuardrails['evaluate']>
  ): AIDecisionPlan {
    if (AI_UNRESTRICTED_MODE) {
      return { ...plan, entryStyle: 'LIMIT' };
    }

    if (guardrails.forcedAction) {
      if (guardrails.forcedAction.intent === 'EXIT') {
        this.telemetry.forcedExits += 1;
      } else {
        this.telemetry.guardrailBlocks += 1;
      }
      return this.planFromForcedAction(plan.nonce, guardrails.forcedAction);
    }

    if (plan.intent === 'ENTER') {
      if (guardrails.blockEntry) {
        this.telemetry.guardrailBlocks += 1;
        return this.buildSafeHoldPlan(plan.nonce, 'RISK_LOCK');
      }
      if (snapshot.position && plan.side && snapshot.position.side !== plan.side && guardrails.blockFlip) {
        this.telemetry.guardrailBlocks += 1;
        return this.buildSafeHoldPlan(plan.nonce, 'FLIP_COOLDOWN_ACTIVE');
      }
    }

    if (plan.intent === 'MANAGE') {
      const isAddIntent = this.planImpliesAdd(plan);
      if (isAddIntent && guardrails.blockAdd) {
        this.telemetry.guardrailBlocks += 1;
        return this.buildSafeHoldPlan(plan.nonce, 'ADD_GAP_ACTIVE');
      }
    }

    if (plan.intent === 'EXIT' && guardrails.blockFlip) {
      this.telemetry.guardrailBlocks += 1;
      return this.buildSafeHoldPlan(plan.nonce, 'MIN_HOLD_ACTIVE');
    }

    return plan;
  }

  private buildDecision(
    snapshot: AIMetricsSnapshot,
    plan: AIDecisionPlan,
    context: {
      promptNonce: string;
      blockedReasons: GuardrailReason[];
      forcedAction: AIForcedAction | null;
      microAlpha: MicroAlphaContext;
      snapshotHash: string;
    }
  ): StrategyDecision {
    const actions: StrategyAction[] = [];
    const side = plan.side ? (plan.side as StrategySide) : null;

    if (plan.intent === 'HOLD') {
      actions.push({
        type: StrategyActionType.NOOP,
        reason: 'NOOP',
        metadata: { ai: true, plan, context },
      });
    } else if (plan.intent === 'ENTER' && side) {
      actions.push({
        type: StrategyActionType.ENTRY,
        side,
        reason: 'ENTRY_TR',
        expectedPrice: snapshot.market.price,
        sizeMultiplier: clampPlanNumber(Number(plan.sizeMultiplier ?? 1), 0.1, 2),
        metadata: { ai: true, plan, context },
      });
    } else if (plan.intent === 'MANAGE') {
      if (plan.reducePct != null) {
        actions.push({
          type: StrategyActionType.REDUCE,
          reason: 'REDUCE_SOFT',
          reducePct: clampPlanNumber(plan.reducePct, 0.1, 1),
          metadata: { ai: true, plan, context },
        });
      } else if (this.shouldAllowAdd(snapshot, plan)) {
        actions.push({
          type: StrategyActionType.ADD,
          side: snapshot.position?.side,
          reason: 'AI_ADD',
          expectedPrice: snapshot.market.price,
          sizeMultiplier: clampPlanNumber(Number(plan.sizeMultiplier ?? 0.5), 0.1, 2),
          metadata: { ai: true, plan, context },
        });
      } else {
        actions.push({
          type: StrategyActionType.NOOP,
          reason: 'NOOP',
          metadata: { ai: true, plan, context, note: 'manage_add_conditions_not_met' },
        });
      }
    } else if (plan.intent === 'EXIT') {
      if (plan.reducePct != null && plan.reducePct < 1) {
        actions.push({
          type: StrategyActionType.REDUCE,
          reason: 'REDUCE_SOFT',
          reducePct: clampPlanNumber(plan.reducePct, 0.1, 1),
          metadata: { ai: true, plan, context },
        });
      } else {
        actions.push({
          type: StrategyActionType.EXIT,
          reason: 'EXIT_HARD',
          metadata: { ai: true, plan, context },
        });
      }
    }

    if (actions.length === 0) {
      actions.push({
        type: StrategyActionType.NOOP,
        reason: 'NOOP',
        metadata: { ai: true, plan, context, note: 'empty_action_fallback' },
      });
    }

    const reasons = actions.map((a) => a.reason);
    const log: StrategyDecisionLog = {
      timestampMs: snapshot.timestampMs,
      symbol: snapshot.symbol,
      regime: snapshot.decision.regime,
      gate: {
        passed: snapshot.decision.gatePassed,
        reason: null,
        details: {
          ai: true,
          promptNonce: context.promptNonce,
          blockedReasons: context.blockedReasons,
          forcedAction: context.forcedAction,
          microAlpha: {
            sideBias: context.microAlpha.sideBias,
            signalStrength: Number(context.microAlpha.signalStrength.toFixed(4)),
            expectedEdgeBps: Number(context.microAlpha.expectedEdgeBps.toFixed(4)),
            tradableFlow: context.microAlpha.tradableFlow,
          },
          snapshotHash: context.snapshotHash,
        },
      },
      dfs: snapshot.decision.dfs,
      dfsPercentile: snapshot.decision.dfsPercentile,
      volLevel: snapshot.decision.volLevel,
      thresholds: snapshot.decision.thresholds,
      reasons,
      actions,
      stats: {
        aiDecision: 1,
        aiConfidence: plan.confidence,
        expectedEdgeBps: Number(context.microAlpha.expectedEdgeBps.toFixed(4)),
        signalStrength: Number(context.microAlpha.signalStrength.toFixed(4)),
        tradableFlow: context.microAlpha.tradableFlow ? 1 : 0,
      },
    };

    const decision: StrategyDecision = {
      symbol: snapshot.symbol,
      timestampMs: snapshot.timestampMs,
      regime: snapshot.decision.regime,
      dfs: snapshot.decision.dfs,
      dfsPercentile: snapshot.decision.dfsPercentile,
      volLevel: snapshot.decision.volLevel,
      gatePassed: snapshot.decision.gatePassed,
      actions,
      reasons,
      log,
    };

    this.recordDecisionLog(decision, plan.intent);
    return decision;
  }

  private shouldAllowAdd(snapshot: AIMetricsSnapshot, plan: AIDecisionPlan): boolean {
    const position = snapshot.position;
    if (!position) return false;
    if (plan.addRule === 'NEVER') return false;
    if (AI_UNRESTRICTED_MODE) {
      const maxAdds = Math.max(0, Math.trunc(Number(plan.maxAdds || 0)));
      return position.addsUsed < maxAdds;
    }
    if (position.addsUsed >= plan.maxAdds) return false;
    if (!snapshot.decision.gatePassed) return false;

    const marginUsage = snapshot.riskState.equity > 0
      ? snapshot.riskState.marginInUse / snapshot.riskState.equity
      : 0;
    if (marginUsage >= DEFAULT_ADD_MARGIN_USAGE_CAP) return false;

    const minUpnl = clampPlanNumber(plan.addTrigger.minUnrealizedPnlPct, -0.05, 0.05);
    const upnl = Number(position.unrealizedPnlPct || 0);
    const sideSign = position.side === 'LONG' ? 1 : -1;
    const executionTrendIntact = typeof snapshot.executionState.trendIntact === 'boolean'
      ? snapshot.executionState.trendIntact
      : plan.addTrigger.trendIntact;
    const trendIntactNow = Boolean(plan.addTrigger.trendIntact) && Boolean(executionTrendIntact);

    const deltaAligned = plan.addTrigger.deltaConfirm
      ? sideSign * (snapshot.market.delta5s + snapshot.market.delta1s) > 0
      : true;

    const obiSupport = plan.addTrigger.obiSupportMin <= 0
      ? true
      : sideSign > 0
        ? snapshot.market.obiDeep >= plan.addTrigger.obiSupportMin
        : snapshot.market.obiDeep <= -Math.abs(plan.addTrigger.obiSupportMin);

    if (!deltaAligned || !obiSupport) return false;

    if (plan.addRule === 'WINNER_ONLY') {
      return upnl >= Math.max(minUpnl, DEFAULT_ADD_MIN_UPNL_PCT) && trendIntactNow;
    }

    if (plan.addRule === 'TREND_INTACT') {
      const pullbackFloor = Math.max(-DEFAULT_PULLBACK_ADD_MAX_ADVERSE_PCT, minUpnl);
      return trendIntactNow && upnl >= pullbackFloor;
    }

    return false;
  }

  private updateRuntime(
    snapshot: AIMetricsSnapshot,
    runtime: RuntimeState,
    plan: AIDecisionPlan,
    nowMs: number,
    forcedAction: AIForcedAction | null
  ): void {
    const previousAction = runtime.lastAction;
    if (plan.intent === 'HOLD') {
      this.holdStreak.set(snapshot.symbol, (this.holdStreak.get(snapshot.symbol) || 0) + 1);
      if (runtime.holdStartTs <= 0) {
        runtime.holdStartTs = nowMs;
      }
    } else {
      this.holdStreak.set(snapshot.symbol, 0);
      if (runtime.holdStartTs > 0) {
        const holdDuration = Math.max(0, nowMs - runtime.holdStartTs);
        this.holdDurationTotalMs += holdDuration;
        this.holdDurationSamples += 1;
        runtime.holdStartTs = 0;
      }
    }

    if (plan.intent === 'ENTER' && plan.side) {
      const targetSide = plan.side as StrategySide;
      if (snapshot.position && snapshot.position.side !== targetSide) {
        runtime.lastFlipTs = nowMs;
        runtime.lastExitSide = snapshot.position.side;
        this.telemetry.flipsCount += 1;
      }
      runtime.lastEntryTs = nowMs;
      runtime.lastActionSide = targetSide;
    }

    if (plan.intent === 'MANAGE' && this.planImpliesAdd(plan) && this.shouldAllowAdd(snapshot, plan)) {
      runtime.lastAddTs = nowMs;
      this.telemetry.addsCount += 1;
    }

    if (plan.intent === 'MANAGE' && plan.reducePct != null) {
      runtime.lastTrendTakeProfitTs = nowMs;
    }

    if (plan.intent === 'EXIT' && snapshot.position) {
      runtime.lastFlipTs = nowMs;
      runtime.lastExitSide = snapshot.position.side;
    }

    if (forcedAction && forcedAction.intent === 'EXIT') {
      runtime.lastFlipTs = nowMs;
      if (snapshot.position) {
        runtime.lastExitSide = snapshot.position.side;
      }
    }

    runtime.lastAction = plan.intent;
    if (previousAction === 'HOLD' && plan.intent !== 'HOLD' && runtime.holdStartTs > 0) {
      const holdDuration = Math.max(0, nowMs - runtime.holdStartTs);
      this.holdDurationTotalMs += holdDuration;
      this.holdDurationSamples += 1;
      runtime.holdStartTs = 0;
    }
  }

  private buildSafeHoldPlan(nonce: string, tag: GuardrailReason | 'LOCAL_ONLY' | 'INVALID_AI_RESPONSE'): AIDecisionPlan {
    return {
      version: PLAN_VERSION,
      nonce,
      intent: 'HOLD',
      side: null,
      urgency: 'LOW',
      entryStyle: 'LIMIT',
      sizeMultiplier: 0.1,
      maxAdds: 0,
      addRule: 'NEVER',
      addTrigger: {
        minUnrealizedPnlPct: DEFAULT_ADD_MIN_UPNL_PCT,
        trendIntact: false,
        obiSupportMin: 0,
        deltaConfirm: false,
      },
      reducePct: null,
      invalidationHint: 'NONE',
      explanationTags: [tag === 'INVALID_AI_RESPONSE' ? 'RISK_LOCK' : 'COOLDOWN_ACTIVE'],
      confidence: 0,
    };
  }

  private planFromForcedAction(nonce: string, forced: AIForcedAction): AIDecisionPlan {
    if (forced.intent === 'EXIT') {
      return {
        ...this.buildSafeHoldPlan(nonce, forced.reason),
        intent: 'EXIT',
        confidence: 1,
      };
    }
    if (forced.intent === 'MANAGE') {
      return {
        ...this.buildSafeHoldPlan(nonce, forced.reason),
        intent: 'MANAGE',
        reducePct: clampPlanNumber(Number(forced.reducePct ?? 0.5), 0.1, 1),
        confidence: 1,
      };
    }
    return this.buildSafeHoldPlan(nonce, forced.reason);
  }

  private planImpliesAdd(plan: AIDecisionPlan): boolean {
    return plan.intent === 'MANAGE' && plan.reducePct == null && plan.addRule !== 'NEVER';
  }

  private parseIntent(raw: unknown): AIDecisionIntent | null {
    const value = String(raw || '').trim().toUpperCase();
    if (value === 'HOLD' || value === 'WAIT' || value === 'NOOP') return 'HOLD';
    if (value === 'ENTER' || value === 'ENTRY' || value === 'BUY' || value === 'SELL' || value === 'LONG' || value === 'SHORT') return 'ENTER';
    if (value === 'MANAGE' || value === 'ADD' || value === 'REDUCE') return 'MANAGE';
    if (value === 'EXIT' || value === 'CLOSE') return 'EXIT';
    return null;
  }

  private parseUrgency(raw: unknown): AIUrgency {
    const value = String(raw || '').trim().toUpperCase();
    if (value === 'LOW' || value === 'MED' || value === 'HIGH') return value;
    return 'MED';
  }

  private parseEntryStyle(raw: unknown): AIEntryStyle {
    return 'LIMIT';
  }

  private parseAddRule(raw: unknown): AIAddRule {
    const value = String(raw || '').trim().toUpperCase();
    if (value === 'WINNER_ONLY' || value === 'TREND_INTACT' || value === 'NEVER') return value;
    return 'WINNER_ONLY';
  }

  private parseInvalidationHint(raw: unknown): AIDecisionPlan['invalidationHint'] {
    const value = String(raw || '').trim().toUpperCase();
    if (value === 'VWAP' || value === 'ATR' || value === 'OBI_FLIP' || value === 'ABSORPTION_BREAK' || value === 'NONE') {
      return value;
    }
    return 'NONE';
  }

  private getRuntimeState(symbol: string, nowMs = Date.now()): RuntimeState {
    let state = this.runtime.get(symbol);
    if (!state) {
      const seed = this.bootstrapTrendBySymbol.get(symbol);
      state = {
        lastAction: 'NONE',
        lastActionSide: null,
        lastEntryTs: 0,
        lastAddTs: 0,
        lastFlipTs: 0,
        lastExitSide: null,
        holdStartTs: 0,
        trendBias: seed?.bias ?? null,
        trendBiasSinceTs: seed?.asOfMs ?? 0,
        trendLongConfirmTicks: seed?.bias === 'LONG' ? Math.max(1, Math.floor(DEFAULT_TREND_CONFIRM_TICKS / 2)) : 0,
        trendShortConfirmTicks: seed?.bias === 'SHORT' ? Math.max(1, Math.floor(DEFAULT_TREND_CONFIRM_TICKS / 2)) : 0,
        trendBreakConfirmTicks: 0,
        trendLastStrength: clamp(Number(seed?.strength ?? 0), 0, 1),
        trendIntact: Boolean(seed?.bias),
        lastTrendTakeProfitTs: 0,
        bootstrapSeeded: Boolean(seed?.bias),
        bootstrapSeedStrength: clamp(Number(seed?.strength ?? 0), 0, 1),
        bootstrapPhaseUntilTs: seed?.bias ? (nowMs + DEFAULT_BOOTSTRAP_PHASE_MS) : 0,
        bootstrapWarmupUntilTs: nowMs + DEFAULT_BOOTSTRAP_WARMUP_MS,
      };
      this.runtime.set(symbol, state);
      if (seed?.bias) {
        this.log?.('AI_TREND_BOOTSTRAP_APPLIED', {
          symbol,
          bias: seed.bias,
          strength: Number(state.trendLastStrength.toFixed(4)),
          asOfMs: seed.asOfMs,
        });
      }
    }
    return state;
  }

  private computeAdaptiveDecisionInterval(snapshot: AIMetricsSnapshot): number {
    if (!this.config) return 1000;
    const base = clamp(this.config.decisionIntervalMs, DEFAULT_MIN_DECISION_INTERVAL_MS, DEFAULT_MAX_DECISION_INTERVAL_MS);
    if (AI_UNRESTRICTED_MODE) {
      return base;
    }
    const prints = snapshot.trades.printsPerSecond;
    const burst = snapshot.trades.burstCount;
    const tradeCount = snapshot.trades.tradeCount;

    let factor = 1;
    if (prints >= 8 || burst >= 6 || tradeCount >= 40) {
      factor = 0.6;
    } else if (prints <= 1 || tradeCount <= 6) {
      factor = 1.8;
    } else if (prints >= 4 || burst >= 3) {
      factor = 0.8;
    }

    return clamp(Math.round(base * factor), DEFAULT_MIN_DECISION_INTERVAL_MS, DEFAULT_MAX_DECISION_INTERVAL_MS);
  }

  private buildRuntimeContext(snapshot: AIMetricsSnapshot, runtime: RuntimeState, nowMs: number): GuardrailRuntimeContext {
    if (!this.config) {
      return { nowMs, minHoldMsRemaining: 0, flipCooldownMsRemaining: 0, addGapMsRemaining: 0 };
    }
    const minHoldMsRemaining = runtime.lastEntryTs > 0
      ? Math.max(0, this.config.minHoldMs - Math.max(0, nowMs - runtime.lastEntryTs))
      : Math.max(0, Number(snapshot.riskState.cooldownMsRemaining || 0));
    const flipCooldownMsRemaining = runtime.lastFlipTs > 0
      ? Math.max(0, this.config.flipCooldownMs - Math.max(0, nowMs - runtime.lastFlipTs))
      : 0;
    const addGapMsRemaining = runtime.lastAddTs > 0
      ? Math.max(0, this.config.minAddGapMs - Math.max(0, nowMs - runtime.lastAddTs))
      : 0;
    return { nowMs, minHoldMsRemaining, flipCooldownMsRemaining, addGapMsRemaining };
  }

  private enrichSnapshot(
    snapshot: AIMetricsSnapshot,
    runtime: RuntimeState,
    blockedReasons: string[],
    runtimeContext: GuardrailRuntimeContext,
    trend: TrendStateView
  ): AIMetricsSnapshot {
    const nowMs = Number(snapshot.timestampMs || Date.now());
    const holdStreak = this.holdStreak.get(snapshot.symbol) || 0;
    return {
      ...snapshot,
      blockedReasons,
      riskState: {
        ...snapshot.riskState,
        cooldownMsRemaining: Math.max(
          Number(snapshot.riskState.cooldownMsRemaining || 0),
          runtimeContext.minHoldMsRemaining,
          runtimeContext.flipCooldownMsRemaining
        ),
      },
      executionState: {
        lastAction: runtime.lastAction,
        holdStreak,
        lastAddMsAgo: runtime.lastAddTs > 0 ? Math.max(0, nowMs - runtime.lastAddTs) : null,
        lastFlipMsAgo: runtime.lastFlipTs > 0 ? Math.max(0, nowMs - runtime.lastFlipTs) : null,
        trendBias: trend.bias,
        trendStrength: Number(trend.strength.toFixed(4)),
        trendIntact: trend.intact,
        trendAgeMs: trend.ageMs,
        trendBreakConfirm: trend.breakConfirm,
        lastTrendTakeProfitMsAgo: runtime.lastTrendTakeProfitTs > 0 ? Math.max(0, nowMs - runtime.lastTrendTakeProfitTs) : null,
        bootstrapPhaseMsRemaining: runtime.bootstrapPhaseUntilTs > nowMs ? Math.max(0, runtime.bootstrapPhaseUntilTs - nowMs) : 0,
        bootstrapSeedStrength: runtime.bootstrapSeedStrength > 0 ? Number(runtime.bootstrapSeedStrength.toFixed(4)) : 0,
        bootstrapWarmupMsRemaining: runtime.bootstrapWarmupUntilTs > nowMs ? Math.max(0, runtime.bootstrapWarmupUntilTs - nowMs) : 0,
      },
      position: snapshot.position
        ? {
          ...snapshot.position,
          timeInPositionMs: Math.max(0, Number(snapshot.position.timeInPositionMs || 0)),
        }
        : null,
    };
  }

  private generatePromptNonce(symbol: string, nowMs: number): string {
    this.nonceSeq += 1;
    return `${symbol}-${nowMs}-${this.nonceSeq}`;
  }

  private hashSnapshot(snapshot: AIMetricsSnapshot, nonce: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ nonce, snapshot }))
      .digest('hex')
      .slice(0, 16);
  }

  private recordDecisionLog(decision: StrategyDecision, intent: AIDecisionIntent): void {
    if (!this.decisionLog) return;
    const payload: StrategyDecisionLog = {
      ...decision.log,
      stats: {
        ...decision.log.stats,
        aiIntent: ['HOLD', 'ENTER', 'MANAGE', 'EXIT'].indexOf(intent),
      },
    };
    this.decisionLog.record(payload);
  }
}

