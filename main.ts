// Tiny Bot: oversold snap-back on hourly Solana bars.
//
// Idea (my own, tuned on the dev window): in a choppy, grind-down market the
// trend bots all bleed from whipsaw, and buy-and-hold bleeds from the drift.
// What pays is buying a sharp, short oversold dip and selling the bounce
// quickly, with a hard stop when the dip keeps falling.
//
//   - Per symbol, over its own closes: RSI(14) as a plain mean of the last 14
//     up/down moves (no Wilder smoothing), and a 5-bar EMA.
//   - Entry, on a bar's close (filled at the next open): RSI(14) below 30 and
//     the close below its 5-bar EMA. Candidates rank by how oversold they
//     are; at most 4 open positions, each at most 25% of equity (the cap).
//   - Exit, the whole position: RSI(14) above 55, or the position worth 3%
//     under its cost (stop), or 8% over it (take profit), or 12 bars held
//     without a bounce (time exit, so a dead dip does not sit through the
//     rest of the window).
//   - Sells go first in a reply, then buys in universe order; a reply never
//     spends cash a sell of the same reply would bring (proceeds land at the
//     next open). Each order caps slippage at 100 bps past the close, so a
//     fill into a liquidity gap is refused and retried, never chased.
//   - No position is opened while warming up, and a symbol with no bar on a
//     batch is not decided on that batch. Fully deterministic: plain float
//     arithmetic on closes only, no clock, no randomness, no environment.
//
// The numbers (30 / 55 / 3% / 8% / 12 bars / 4 slots) were picked by backtesting the
// dev window plus its 72-bar sub-windows and the price-inverted window, so
// the rule is not fitted to one stretch or one direction: it stays near
// cash in a downtrend, still catches dip-bounces in an uptrend, and keeps
// enough trades to clear the 8-trade guardrail on a 3-day window.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const MAX_SLIPPAGE_BPS = 100;
const RSI_PERIOD = 14;
const RSI_ENTRY_BELOW = 30;
const RSI_EXIT_ABOVE = 55;
const EMA_SPAN = 5;
const STOP_NUM = 97n; // sell at or below 97% of cost
const STOP_DEN = 100n;
const TAKE_NUM = 108n; // sell at or above 108% of cost
const TAKE_DEN = 100n;
const MAX_HOLD_BARS = 12; // sell a position held this long without a bounce
const MAX_POSITIONS = 4;

// Per-symbol close history in plain price units (close raw / 10^price_scale).
const closes = new Map<string, number[]>();
// Per-symbol 5-bar EMA, seeded on the first close.
const ema = new Map<string, number>();
// Bars since each open position was decided (counts decision batches).
const heldBars = new Map<string, number>();

function pushCloses(batch: Batch): void {
  for (const bar of batch.bars) {
    const scale = 10 ** (barSymbolScale(bar.symbol) ?? 0);
    const price = Number(bar.c) / scale;
    let series = closes.get(bar.symbol);
    if (series === undefined) {
      series = [];
      closes.set(bar.symbol, series);
    }
    series.push(price);
    const k = 2 / (EMA_SPAN + 1);
    const prev = ema.get(bar.symbol);
    ema.set(bar.symbol, prev === undefined ? price : price * k + prev * (1 - k));
  }
}

// The price scale of a symbol, from hello's symbol list.
const scales = new Map<string, number>();
function barSymbolScale(symbol: string): number | undefined {
  return scales.get(symbol);
}

// RSI(14): 100 - 100 / (1 + mean gain / mean loss) over the last 14 hourly
// moves; null until 15 closes exist. Gains and losses are plain means, not
// Wilder-smoothed, so a fresh 14-bar window fully replaces the old one.
function rsi(symbol: string): number | null {
  const series = closes.get(symbol);
  if (series === undefined || series.length <= RSI_PERIOD) return null;
  let gain = 0;
  let loss = 0;
  for (let j = series.length - RSI_PERIOD; j < series.length; j++) {
    const d = series[j]! - series[j - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function shouldExit(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, r: number | null): boolean {
  if (r !== null && r > RSI_EXIT_ABOVE) return true;
  const value = state.value(symbol, held.qty);
  if (value * STOP_DEN <= held.cost * STOP_NUM) return true;
  if (value * TAKE_DEN >= held.cost * TAKE_NUM) return true;
  if ((heldBars.get(symbol) ?? 0) >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onHello(state) {
    for (const s of state.hello.symbols) scales.set(s.symbol, s.price_scale);
  },
  onBatch(state, batch) {
    pushCloses(batch);
    if (state.warmingUp) return [];
    const fresh = new Set(batch.bars.map((b) => b.symbol));
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: { symbol: string; depth: number }[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const r = rsi(symbol);
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (shouldExit(state, symbol, held, r)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          heldBars.delete(symbol);
        } else {
          heldBars.set(symbol, (heldBars.get(symbol) ?? 0) + 1);
        }
        continue;
      }
      const e = ema.get(symbol);
      const last = closes.get(symbol)?.at(-1);
      if (r !== null && e !== undefined && last !== undefined && r < RSI_ENTRY_BELOW && last < e) {
        entries.push({ symbol, depth: RSI_ENTRY_BELOW - r });
      }
    }
    entries.sort((a, b) => b.depth - a.depth);

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / 10000n;
    let room = MAX_POSITIONS - (state.positions.size - sells.length);
    let cash = state.cash;
    for (const { symbol } of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = state.weightRoom(symbol);
      if (slice > byWeight) slice = byWeight;
      if (slice > cash) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      heldBars.set(symbol, 0);
      cash -= slice;
      room--;
    }
    return orders;
  },
});
