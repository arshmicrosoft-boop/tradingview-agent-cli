#!/usr/bin/env python3
"""Monte Carlo validation module for trading backtests.

Shuffles trade sequences 10,000 times and computes outcome distributions.
Provides confidence ranges for strategy results.
"""

import numpy as np


def shuffle_trades(trades: list[float], n_simulations: int = 10_000, seed: int = 42) -> dict:
    """Shuffle trade return sequence and compute outcome distributions.

    Args:
        trades: List of individual trade returns (percentages or PnL ratios).
        n_simulations: Number of shuffle iterations.
        seed: Random seed for reproducibility.

    Returns:
        Dict with mean_return, std_return, percentiles, and confidence bands.
    """
    rng = np.random.default_rng(seed)
    trades_arr = np.array(trades, dtype=float)
    cumulative = np.cumsum(trades_arr)
    original_total = float(cumulative[-1]) if len(cumulative) > 0 else 0.0

    simulated_totals = np.empty(n_simulations, dtype=float)
    for i in range(n_simulations):
        shuffled = rng.permutation(trades_arr)
        simulated_totals[i] = float(np.sum(shuffled))

    return {
        "original_total": original_total,
        "simulations": int(n_simulations),
        "mean": float(np.mean(simulated_totals)),
        "std": float(np.std(simulated_totals)),
        "percentiles": {
            "5th": float(np.percentile(simulated_totals, 5)),
            "25th": float(np.percentile(simulated_totals, 25)),
            "50th": float(np.percentile(simulated_totals, 50)),
            "75th": float(np.percentile(simulated_totals, 75)),
            "95th": float(np.percentile(simulated_totals, 95)),
        },
        "confidence_range_95": (
            float(np.percentile(simulated_totals, 2.5)),
            float(np.percentile(simulated_totals, 97.5)),
        ),
    }


if __name__ == "__main__":
    # Demo: synthetic trade returns from a simple mean-reverting strategy
    demo_trades = [0.01, -0.005, 0.008, -0.003, 0.015, -0.002, 0.012, -0.001]
    result = shuffle_trades(demo_trades, n_simulations=10_000, seed=42)
    print("Monte Carlo Validation Results")
    print("-" * 40)
    print(f"Original total return: {result['original_total']:.4f}")
    print(f"Simulations: {result['simulations']}")
    print(f"Mean (shuffled): {result['mean']:.4f}")
    print(f"Std (shuffled): {result['std']:.4f}")
    print(f"95% confidence range: {result['confidence_range_95'][0]:.4f} to {result['confidence_range_95'][1]:.4f}")
    print("-" * 40)
