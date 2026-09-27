---
name: tv-paper-execution
description: Safely place and inspect paper orders in the tradingview-to-cli repo — the run order for tv:launch, status, propose --dry-run and propose; what each risk-gate block code means and how to clear it; the kill switch; and the manual two-click cancel. Use when asked to paper trade this repo, size or place an order, read paper positions/balance, or diagnose a BLOCKED BY RISK GATE error.
version: 1.0.0
---

# Paper execution in this repo

Operating instructions for `execution/paper-trade.mjs`. The *mechanism* — how
TradingView is driven over CDP, and the DOM handles — lives in the
`tradingview-paper-trading` skill. This file is only the procedure and the ways
it fails. Depth is in [`AGENT.md`](../../../AGENT.md) §8 and §11.

> Placing an order is consequential. It puts a real order into a live paper
> broker. Never run anything in `execution/` that a human did not ask for.

## Preflight

Do these in order. Skipping step 3 is the one that costs an hour.

1. `npm run verify` — must pass. A red build is a real defect, not something to
   work around.
2. `npm run tv:launch` — starts Desktop on CDP 9222 **and** guarantees a chart
   tab. CDP alone is not enough; without a chart every handle reads as missing.
3. **Confirm the Paper Trading broker is connected.** If it is not, there is no
   order ticket at all and clicking **Trade** pops a `Connect broker` modal.
   This is not in `AGENT.md` — it is the most common reason a first attempt
   looks like "the panel is empty".
4. `node execution/paper-trade.mjs status` — needs `api_available: true`.
5. **Expand the Paper Trading panel** (chevron beside the label). Collapsed
   account state is unreadable, and the gate fails closed rather than assuming
   zero exposure.

## The normal path

```powershell
npm run tv:launch
node execution/paper-trade.mjs status
node execution/paper-trade.mjs propose buy DOGEUSD --thesis "..." --dry-run
node execution/paper-trade.mjs propose buy DOGEUSD --thesis "..."
```

`propose` is the only path an agent should use. **You supply a thesis, never a
size** — the risk engine computes quantity, stop and leverage, and it is the
same code the backtest used. `buy`/`sell <qty>` is a manual override and is
logged as `sized_by: "agent-explicit"`.

Always `--dry-run` first and read the engine's size and stop before submitting.

Check the exposure caps *before* you promise anything: `propose` sizes against
`Orders margin + Account margin`, so a busy paper account blocks the order
regardless of how small the proposed size is.

## Blocked by the gate

The gate runs **before any UI interaction**. If it blocks, nothing was clicked —
that ordering is the whole defense. `error: No clicks were made` is proof, not
a claim.

| Code | Cause | Fix |
|---|---|---|
| `KILL_SWITCH` | `kill_switch: true` in `config/risk.json` | the fastest stop available; clear it deliberately, never reflexively |
| `STATE_UNREADABLE` | account summary unreadable — panel collapsed | expand the Paper Trading panel, re-run `status` |
| `RECONCILIATION_UNAVAILABLE` | exposed, but positions table not rendered | expand the account manager, reconcile by hand, then trade |
| `RECONCILIATION_MISMATCH` | account margin and positions table disagree | you are exposed but do not know what you hold. Reconcile manually first |
| `PRICE_UNKNOWN` | ticket price unreadable, so the order cannot be sized | pass `--est-price <p>` |
| `MAX_OPEN_ORDERS` | already exposed (resting **or** filled) and `max_open_orders: 1` | close the position with `--close`, cancel the order by hand, or raise the limit deliberately |
| `MAX_ORDER_NOTIONAL` | `qty × price` over cap | reduce size, or raise `max_order_notional_usd` deliberately |
| `MAX_TOTAL_MARGIN` | committed + notional over cap | reduce size, or raise `max_total_margin_usd` deliberately |

Two subtleties that cost time:

- **"One at a time" means one unit of exposure, not one order.** A resting order
  *and* an open position both count, via `Orders margin` and `Account margin`.
  Counting only resting orders let a second position stack up.
- **`--close` is exempt from the exposure caps** — otherwise the gate would trap
  you, unable to close precisely because something was open. It is *not* exempt
  from the kill switch, state readability, or price.

Raising a limit to make an order fit is a decision, not a workaround. Say which
limit you raised and why in the audit trail.

## Cancelling is manual

There is no script for it and there must not be one. The order line and its `x`
are canvas-drawn with no DOM handle; the account manager's Orders table renders
empty and `CXL All` only exists on a DOM tab that is not always there.

Two clicks by hand:

1. Hover the order line on the chart, click its **`x`**.
2. In the dialog, click **Cancel order** — not "Keep order".

`node execution/paper-trade.mjs cancel` only reports that it will not do this,
and logs the refusal. Coordinate probing here is genuinely unsafe: in
development a probe opened the chart's timezone dropdown, nearly hit the
account-deletion control, and placed a duplicate order.

## After anything unexpected

```powershell
Get-Content config/audit.jsonl -Tail 20
```

Every action **and every refusal** is appended there, with the gate verdict, the
ticket text, and the margin before/after. An order you did not place will be in
this file. The ticket label recorded there is what the UI actually said, which
is the only ground truth about what was submitted.

## Rules

- The signal decides **direction only**. Size, stop and leverage are the risk
  engine's job. Do not hand-compute a size to get past a cap.
- `research/` must never place orders, and `verify.mjs` fails the build if
  `research/` can reach `execution/` or reach TradingView. Keep it that way.
- A dry run that you did not read is not a dry run. A gate you have not seen
  pass is not permission to click.
