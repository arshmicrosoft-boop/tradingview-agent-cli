#!/usr/bin/env python3
"""Quantlab wrapper: runs the integration pipeline from a YAML config."""
import argparse
import sys
from pathlib import Path

# Ensure parent project root is importable (run_experiment lives there)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from run_experiment import run_pipeline


def decide_result(results: dict) -> str:
    """Derive PASS / FAIL / RESEARCH_CANDIDATE from validation results."""
    validation = results.get("validation", {})
    walk_forward = validation.get("walk_forward", "FAIL")
    purged_cv = validation.get("purged_cv", "FAIL")
    lean = results.get("lean", {})

    if walk_forward != "PASS" or purged_cv != "PASS":
        return "FAIL"
    # If LEAN realistic validation is present and positive
    sharp = lean.get("sharp", 0.0)
    max_dd = lean.get("max_drawdown", 0.0)
    if sharp >= 1.0 and max_dd >= -0.20:
        return "PASS"
    # Otherwise treat as research candidate
    return "RESEARCH_CANDIDATE"


def main():
    parser = argparse.ArgumentParser(description="Quantlab research engine")
    parser.add_argument(
        "config",
        nargs="?",
        default="experiments/btc_vwap.yaml",
        help="Experiment YAML config path (relative to project root)",
    )
    args = parser.parse_args()

    config_path = str(PROJECT_ROOT / args.config)
    print(f"Quantlab: loading config -> {config_path}")
    print(f"Quantlab: calling run_experiment pipeline...")

    result = run_pipeline(config_path)

    validation = result.get("validation", {})
    print(f"\nProgress:")
    print(f"  VectorBT candidates: {result.get('results', {}).get('candidates_tested', 'N/A')}")
    print(f"  LEAN trades: {result.get('lean', {}).get('trades', 'N/A')}")
    print(f"  LEAN Sharpe: {result.get('lean', {}).get('sharp', 'N/A')}")
    print(f"  Walk Forward: {validation.get('walk_forward', 'N/A')}")
    print(f"  Purged CV: {validation.get('purged_cv', 'N/A')}")
    print(f"  Monte Carlo runs: {validation.get('monte_carlo', {}).get('simulations', 'N/A')}")

    decision = decide_result(result)
    result["decision"] = decision  # sync back to result

    print(f"\n=== Final Decision: {decision} ===")
    print(f"Experiment: {result.get('experiment', 'unknown')}")
    print(f"Version: {result.get('version', 1)}")
    print(f"Strategy: {result.get('strategy_name', '—')}")
    print(f"Validation: WF={validation.get('walk_forward','N/A')}, CV={validation.get('purged_cv','N/A')}")
    print(f"LEAN trades: {result.get('lean', {}).get('trades', 'N/A')}, Sharpe: {result.get('lean', {}).get('sharp', 'N/A')}, Max DD: {result.get('lean', {}).get('max_drawdown', 'N/A')}")


if __name__ == "__main__":
    main()
