import { DryRunOrderBook, DryRunOrderRequest, DryRunSide } from './types';

export type LimitStrategyMode = 'MARKET' | 'PASSIVE' | 'AGGRESSIVE' | 'SPLIT';
export type AIEntryStyle = 'LIMIT' | 'MARKET_SMALL' | 'HYBRID';
export type AIEntryUrgency = 'LOW' | 'MED' | 'HIGH';

export interface LimitOrderStrategyConfig {
  mode: LimitStrategyMode;
  splitLevels: number;
  passiveOffsetBps: number;
  maxSlices: number;
}

const DEFAULT_CONFIG: LimitOrderStrategyConfig = {
  mode: 'MARKET',
  splitLevels: 3,
  passiveOffsetBps: 2,
  maxSlices: 4,
};

function roundTo(value: number, decimals: number): number {
  const m = Math.pow(10, Math.max(0, decimals));
  return Math.round(value * m) / m;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class LimitOrderStrategy {
  private readonly config: LimitOrderStrategyConfig;

  constructor(config?: Partial<LimitOrderStrategyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
  }

  buildEntryOrders(params: {
    side: DryRunSide;
    qty: number;
    markPrice: number;
    orderBook: DryRunOrderBook;
    urgency?: number; // 0-1
    entryStyle?: AIEntryStyle;
    urgencyLevel?: AIEntryUrgency;
    spreadPct?: number | null;
    volatility?: number | null;
    ladderCount?: number | null;
  }): DryRunOrderRequest[] {
    const { side, qty, markPrice, orderBook } = params;
    if (!(qty > 0) || !(markPrice > 0)) return [];

    if (params.entryStyle) {
      return this.buildStyleOrders({
        side,
        qty,
        markPrice,
        orderBook,
        entryStyle: params.entryStyle,
        urgencyLevel: params.urgencyLevel ?? this.normalizeUrgency(params.urgency),
        spreadPct: params.spreadPct ?? null,
        volatility: params.volatility ?? null,
        ladderCount: params.ladderCount ?? null,
      });
    }

    const urgency = Math.max(0, Math.min(1, params.urgency ?? 0));
    const mode = urgency > 0.85 ? 'AGGRESSIVE' : this.config.mode;

    if (mode === 'MARKET' || mode === 'AGGRESSIVE') {
      return [{ side, type: 'MARKET', qty, timeInForce: 'IOC', reduceOnly: false }];
    }

    const bestBid = orderBook.bids?.[0]?.price ?? 0;
    const bestAsk = orderBook.asks?.[0]?.price ?? 0;
    if (!(bestBid > 0) || !(bestAsk > 0)) {
      return [{ side, type: 'MARKET', qty, timeInForce: 'IOC', reduceOnly: false }];
    }

    if (mode === 'PASSIVE') {
      const offset = this.config.passiveOffsetBps / 10000;
      const target = side === 'BUY'
        ? bestBid * (1 - offset)
        : bestAsk * (1 + offset);
      return [{
        side,
        type: 'LIMIT',
        qty,
        price: roundTo(target, 6),
        timeInForce: 'GTC',
        reduceOnly: false,
      }];
    }

    // SPLIT
    const levels = Math.max(1, Math.min(this.config.splitLevels, this.config.maxSlices));
    const perSlice = qty / levels;
    const orders: DryRunOrderRequest[] = [];
    const bookLevels = side === 'BUY' ? orderBook.bids : orderBook.asks;
    for (let i = 0; i < levels; i += 1) {
      const lvl = bookLevels?.[i];
      const price = lvl?.price ?? (side === 'BUY' ? bestBid : bestAsk);
      orders.push({
        side,
        type: 'LIMIT',
        qty: roundTo(perSlice, 6),
        price: roundTo(price, 6),
        timeInForce: 'GTC',
        reduceOnly: false,
      });
    }
    return orders;
  }

  private normalizeUrgency(urgency?: number): AIEntryUrgency {
    const value = Math.max(0, Math.min(1, urgency ?? 0));
    if (value >= 0.7) return 'HIGH';
    if (value >= 0.35) return 'MED';
    return 'LOW';
  }

  private buildStyleOrders(params: {
    side: DryRunSide;
    qty: number;
    markPrice: number;
    orderBook: DryRunOrderBook;
    entryStyle: AIEntryStyle;
    urgencyLevel: AIEntryUrgency;
    spreadPct: number | null;
    volatility: number | null;
    ladderCount: number | null;
  }): DryRunOrderRequest[] {
    const bestBid = params.orderBook.bids?.[0]?.price ?? 0;
    const bestAsk = params.orderBook.asks?.[0]?.price ?? 0;
    const hasBook = bestBid > 0 && bestAsk > 0;
    const fallbackMarket: DryRunOrderRequest[] = [
      { side: params.side, type: 'MARKET', qty: roundTo(params.qty, 6), timeInForce: 'IOC', reduceOnly: false },
    ];
    if (!hasBook) {
      if (params.entryStyle === 'LIMIT') {
        return [{
          side: params.side,
          type: 'LIMIT',
          qty: roundTo(params.qty, 6),
          price: roundTo(params.markPrice, 6),
          timeInForce: 'IOC',
          reduceOnly: false,
          postOnly: false,
        }];
      }
      return fallbackMarket;
    }

    const orders: DryRunOrderRequest[] = [];
    const marketFractionByStyle: Record<AIEntryStyle, Record<AIEntryUrgency, number>> = {
      LIMIT: { LOW: 0, MED: 0, HIGH: 0 },
      MARKET_SMALL: { LOW: 0.25, MED: 0.4, HIGH: 0.6 },
      HYBRID: { LOW: 0.2, MED: 0.35, HIGH: 0.5 },
    };
    const marketFraction = marketFractionByStyle[params.entryStyle][params.urgencyLevel];
    const marketQty = roundTo(params.qty * marketFraction, 6);
    let remainingQty = roundTo(params.qty - marketQty, 6);

    if (marketQty > 0) {
      orders.push({
        side: params.side,
        type: 'MARKET',
        qty: marketQty,
        timeInForce: 'IOC',
        reduceOnly: false,
      });
    }

    if (!(remainingQty > 0)) {
      return orders.length > 0 ? orders : fallbackMarket;
    }

    const baseLadderCount = this.computeLadderCount(params.urgencyLevel, params.spreadPct, params.volatility);
    const ladderCount = clamp(
      Number.isFinite(params.ladderCount as number) ? Number(params.ladderCount) : baseLadderCount,
      0,
      5
    );
    const spacingBps = this.computeSpacingBps(params.spreadPct, params.volatility);

    if (params.entryStyle === 'LIMIT') {
      const immediatePrice = params.side === 'BUY' ? bestAsk : bestBid;
      orders.push({
        side: params.side,
        type: 'LIMIT',
        qty: remainingQty,
        price: roundTo(immediatePrice, 6),
        timeInForce: 'IOC',
        reduceOnly: false,
        postOnly: false,
      });
      return orders;
    }

    if (ladderCount === 0) {
      const passiveOffset = this.config.passiveOffsetBps / 10_000;
      const price = params.side === 'BUY'
        ? bestBid * (1 - passiveOffset)
        : bestAsk * (1 + passiveOffset);
      orders.push({
        side: params.side,
        type: 'LIMIT',
        qty: remainingQty,
        price: roundTo(price, 6),
        timeInForce: 'GTC',
        reduceOnly: false,
        postOnly: true,
      });
      return orders;
    }

    const slices = this.allocateSlices(remainingQty, ladderCount);
    let remaining = remainingQty;
    for (let i = 0; i < slices.length; i += 1) {
      const sliceQty = i === slices.length - 1 ? roundTo(remaining, 6) : slices[i];
      remaining = roundTo(remaining - sliceQty, 6);
      if (!(sliceQty > 0)) continue;

      const level = i + 1;
      const offset = (spacingBps * level) / 10_000;
      const limitPrice = params.side === 'BUY'
        ? bestBid * (1 - offset)
        : bestAsk * (1 + offset);

      orders.push({
        side: params.side,
        type: 'LIMIT',
        qty: sliceQty,
        price: roundTo(limitPrice, 6),
        timeInForce: 'GTC',
        reduceOnly: false,
        postOnly: true,
      });
    }

    if (orders.length === 0) {
      return fallbackMarket;
    }
    return orders;
  }

  private allocateSlices(totalQty: number, count: number): number[] {
    const n = Math.max(1, Math.trunc(count));
    const out: number[] = [];
    let remaining = roundTo(totalQty, 6);
    for (let i = 0; i < n; i += 1) {
      const slotsLeft = n - i;
      const raw = slotsLeft > 1 ? remaining / slotsLeft : remaining;
      const qty = roundTo(raw, 6);
      out.push(qty);
      remaining = roundTo(remaining - qty, 6);
    }
    return out;
  }

  private computeLadderCount(urgency: AIEntryUrgency, spreadPct: number | null, volatility: number | null): number {
    const spreadBps = Math.max(0, Number.isFinite(spreadPct as number) ? Math.abs(Number(spreadPct)) * 10_000 : 0);
    const vol = Math.max(0, Number.isFinite(volatility as number) ? Number(volatility) : 0);
    const base = urgency === 'HIGH' ? 1 : urgency === 'MED' ? 2 : 3;
    const spreadAdj = spreadBps >= 6 ? 1 : 0;
    const volAdj = vol >= 150 ? 1 : 0;
    return Math.max(0, Math.min(5, base + spreadAdj + volAdj));
  }

  private computeSpacingBps(spreadPct: number | null, volatility: number | null): number {
    const spreadBps = Math.max(0, Number.isFinite(spreadPct as number) ? Math.abs(Number(spreadPct)) * 10_000 : 0);
    const vol = Math.max(0, Number.isFinite(volatility as number) ? Number(volatility) : 0);
    const spacing = 2 + (spreadBps * 0.75) + (vol * 0.02);
    return Math.max(2, Math.min(80, Math.round(spacing)));
  }
}
