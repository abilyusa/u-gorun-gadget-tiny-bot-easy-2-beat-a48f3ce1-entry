# Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana

[![Competition](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/competitions/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Rank](https://make.fun/badge/abilyusa/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/rank.svg)](https://make.fun/competitions/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Reward](https://make.fun/badge/abilyusa/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/reward.svg)](https://make.fun/competitions/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for hourly Solana prices that beats buy-and-hold by
not holding: it buys only sharp, short oversold dips and sells the bounce
quickly, with a hard stop when the dip keeps falling.

## Strategy

Per symbol, over its own hourly closes:

- **RSI(9)** — plain mean of the last 9 up/down moves (no Wilder smoothing) —
  plus a **5-bar EMA**.
- **Entry:** RSI(9) below 25 while the close sits below its 5-bar EMA.
  Candidates rank by how oversold they are; at most 4 open positions, each
  at most 25% of equity (the competition cap).
- **Exit:** the whole position when RSI(9) rises above 60, or the position
  is worth 3% under its cost (stop), or 6% over it (take profit).
- Sells go first in each reply, then buys; each order caps slippage at
  100 bps past the close it was decided on, so a fill into a liquidity gap
  is refused and retried, never chased.

## Why this shape

On the dev window the market grinds down with bounces: trend-following bots
bleed from whipsaw and buy-and-hold bleeds from the drift. Buying only deep
oversold dips keeps the bot near cash in a downtrend, still catches
dip-bounces when the market turns up, and trades often enough to clear the
8-trade guardrail on a 3-day window. The thresholds were picked by
backtesting the dev window, its 72-bar sub-windows, and the price-inverted
window, so the rule is not fitted to one stretch or one direction.

## Files

- `main.ts` — the bot (Node 22, runs as `node main.ts`, no dependencies).
- `vendor/makefun-bars.ts` — the kit's `agent-fun/bars-replay/v1` shim,
  vendored unchanged from the competition kit.
- `LICENSE` — MIT.

## Run locally

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
