# RSI-SMA Cross Backtest V4 — Level-to-Level R:R

_Generated 2026-06-11T21:43:50.425Z_

## Methodology

- 500 daily bars (~24 months) per pair
- Significant levels: ≥3 swing touches clustered within 0.15%
- PASS gates: Weekly RSI extreme + sustained pre-cross + target level exists + R:R ≥ 3:1
- Outcome: reached target level within 30 days

## Confusion Matrix

| | Reached target | Did NOT reach |
|--|---|---|
| **PASSED** | TP: 0 | FP: 37 |
| **FILTERED** | FN: 11 | TN: 53 |

- Precision: **0.0%**
- Baseline: 10.9% of all crosses reached their target
- Recall: 0.0%
- Filter cost: 17.2%
