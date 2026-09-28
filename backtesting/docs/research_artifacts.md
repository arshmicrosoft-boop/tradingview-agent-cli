# Research Artifacts Documentation

## MLflow Artifact Structure

Each experiment run produces a reproducible artifact bundle under:

```
runs/<experiment_id>/
    config.yaml         # Experiment parameters (strategy, data source, version)
    trades.csv          # Trade-level results (entry/exit, timestamp, PnL, fees)
    equity_curve.png    # Equity curve visualization (cumulative PnL over time)
    metrics.json        # Sharpe ratio, max drawdown, total PnL, win rate, trade count
    monte_carlo.json    # Validation outputs (95% PnL range, simulation runs, distributions)
    lean_log.txt        # Lean engine output (realistic execution log, order fills, statistics)
```

These files tie back to the universal experiment schema (`experiment`, `data`, `strategy`, `parameters`, `costs`, `validation`). A year later, reproducing any result requires the experiment ID, the `config.yaml`, and the DVC-tracked dataset version.

## DVC Dataset Tracking

The dataset `BTC_5m.parquet` is tracked by DVC. Its hash (`a81f9e2`) records the exact binary version used in each experiment. Changing the dataset updates the hash, so results always reference a verified data version. Configs in `experiments/*.yaml` include the `data.hash` field for cross-reference with MLflow logs.
