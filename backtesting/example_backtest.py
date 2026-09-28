"""Quick vectorbt demo: simple portfolio backtest."""
import numpy as np
import vectorbt as vbt

np.random.seed(42)
# Synthetic price series: 100 periods, 1 asset
close = np.cumprod(1 + np.random.normal(0.001, 0.02, size=(100, 1)), axis=0) * 100

# Simple signal: enter when price above previous close
signal = close > np.roll(close, 1, axis=0)
signal[0] = False  # first bar no previous value

portfolio = vbt.Portfolio.from_signals(
    close=close,
    entries=signal,
    exits=~signal,
)

print("Total return:", portfolio.total_return())
print("Entries:", portfolio.entry_trades)
