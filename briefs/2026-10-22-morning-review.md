# Scanner Review — 2026-10-22 (morning)

Generated: 2026-10-22T11:03:38.881Z

```
## The clock

It is **06:00 Chicago** — a **normal** hour at 1.10x an average one.
An order placed now rests through **the NY overlap** — about 5h of cover.
Next window: **NY overlap** in 1h.

_Morning pass. The NY overlap is the single best window of the day but it is the only one left before the afternoon goes dead, so this is the adjustment pass: the morning-skewed pairs, and anything that filled overnight._

## Where the energy is

**Running hot:** AUDCHF 1.23 · NZDCHF 1.21
**Quiet:** GBPJPY 0.89 · USDJPY 0.89 · EURJPY 0.84 · CHFJPY 0.78

_Volatility persists for about two days, so a hot pair stays hot. It says nothing about direction — this picks the pair, the levels pick the side._

## Account

NAV **$817.80**   unrealised $-271.05   margin available $0.00   2 open

| pair | units | now | P/L | stop | distance | news lean |
|---|---|---|---|---|---|---|
| EURGBP | 8000 | 0.83849 | $3.42 | **none** | — | 🟢 3 tailwind |
| EURCAD | 17000 | 1.57323 | $-274.47 | **none** | — | — |

**What the system reads on each position**

- **EURGBP** LONG — last REVERSAL LONG 18h ago at 0.83780 — system stop 0.83480, target **0.86717**; 287p to that target from here
- **EURCAD** LONG — last REVERSAL LONG 10h ago at 1.57483 — system stop 1.56636, target **1.62445**; 512p to that target from here

## What is coming, and which way it leans

**EURGBP LONG**
- 🟢 10-23T06:00 GBP — Retail Sales MoM  (fc -0.1 vs prev 0.5)
- 🟢 10-23T08:30 GBP — S&P Global Manufacturing PMI Flash  (fc 51.7 vs prev 51.9)
- 🟢 10-23T08:30 GBP — S&P Global Services PMI Flash  (fc 51.8 vs prev 52.1)

_Lean is read from forecast vs previous — which way consensus leans, not what will print._

## Order blocks live right now

### Daily

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| GBPJPY | LONG | **210.312** | 208.171 | 214p $13.54 | 2% | 0.7R | 87% | 1d | 1.37x | 68% / 39% |
| USDCHF | SHORT | **0.83172** | 0.84030 | 86p $10.41 | 2% | 0.9R | 87% | 3d | 1.54x | 68% / 39% |

_8 more live but further out, 3.1R to 7.2R away. They alert on their own when they come within 1R._
_Older blocks run further: 60+ days reaches 2R 58% of the time against 34% for a same-day fill._

### 4-hour

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| EURCAD | LONG | **1.56944** | 1.56513 | 43p $3.07 | 8% | 1.2R | 79% | 158d | 1.59x | 78% / 51% |
| NZDCHF | SHORT | **0.46878** | 0.47087 | 21p $2.54 | 18% | 1.2R | 79% | 0d | 1.27x | 70% / 46% |
| NZDJPY | SHORT | **89.929** | 90.383 | 45p $2.87 | 7% | 1.4R | 79% | 0d | 1.28x | 70% / 46% |
| NZDCAD | LONG | **0.79408** | 0.79222 | 19p $1.32 | **25%** | 1.5R | 79% | 141d | 1.33x | 78% / 51% |

_10 more live but further out, 2.5R to 7.1R away. They alert on their own when they come within 1R._
_H4 stops are a third of a daily one, so spread bites three times as hard — a bolded spread figure is most of the edge gone before price moves._

### In reach, drawn

_6 blocks within 2R of the limit. Blocks further out are in the tables above but not worth a picture yet._

**GBPJPY LONG** · daily · 0.70R away · waited 1d

![GBPJPY D order block: how it formed, and where price is now](charts/2026-10-22/GBPJPY-D-2026-10-13.svg)

**USDCHF SHORT** · daily · 0.85R away · waited 3d

![USDCHF D order block: how it formed, and where price is now](charts/2026-10-22/USDCHF-D-2026-10-13.svg)

**EURCAD LONG** · 4-hour · 1.19R away · waited 158d

![EURCAD H4 order block: how it formed, and where price is now](charts/2026-10-22/EURCAD-H4-2026-03-16.svg)

**NZDCHF SHORT** · 4-hour · 1.23R away · waited 0d

![NZDCHF H4 order block: how it formed, and where price is now](charts/2026-10-22/NZDCHF-H4-2026-10-21.svg)

**NZDJPY SHORT** · 4-hour · 1.42R away · waited 0d

![NZDJPY H4 order block: how it formed, and where price is now](charts/2026-10-22/NZDJPY-H4-2026-10-21.svg)

**NZDCAD LONG** · 4-hour · 1.53R away · waited 141d

![NZDCAD H4 order block: how it formed, and where price is now](charts/2026-10-22/NZDCAD-H4-2026-04-07.svg)

_Left panel is the block forming, right is where price sits now. Legend is in each image._

## Scanner calls, last 1 day

| when | pair | dir | branch | firing | entry | stop | target | outcome |
|---|---|---|---|---|---|---|---|---|
| 10-21T13:00 | GBPAUD | LONG | REV | 1st ⚠ | 1.90548 | 1.89138 | 1.95694 | open +0.43R |
| 10-21T13:00 | GBPJPY | LONG | REV | 2nd | 211.776 | 210.296 | 213.533 | stopped -1.00R |
| 10-21T13:00 | GBPCHF | SHORT | REV | 2nd | 1.10441 | 1.11092 | 1.08540 | open +0.78R |
| 10-21T13:00 | USDCHF | LONG | REV | 1st ⚠ | 0.82438 | 0.81708 | 0.85632 | open -0.61R |
| 10-21T13:00 | AUDUSD | SHORT | REV | 6th | 0.70306 | 0.70941 | 0.67750 | open +0.26R |
| 10-21T13:00 | AUDJPY | LONG | REV | 7th | 111.141 | 109.831 | 113.562 | open -0.77R |
| 10-21T13:00 | AUDNZD | SHORT | REV | 1st ⚠ | 1.23340 | 1.24123 | 1.21994 | open -0.00R |
| 10-21T17:00 | NZDCAD | SHORT | REV | 16th | 0.80091 | 0.80678 | 0.78749 | open +0.68R |
| 10-21T17:00 | EURJPY | SHORT | REV | 1st ⚠ | 177.634 | 178.687 | 171.729 | open +1.17R |
| 10-21T17:00 | EURGBP | LONG | REV | 7th | 0.83866 | 0.83480 | 0.86717 | open -0.19R |
| 10-21T17:00 | CADJPY | SHORT | REV | 1st ⚠ | 112.578 | 113.453 | 107.746 | open +0.62R |
| 10-21T21:00 | GBPCAD | SHORT | REV | 2nd | 1.88066 | 1.89089 | 1.85129 | open +0.16R |
| 10-21T21:00 | GBPCHF | SHORT | REV | 1st ⚠ | 1.10432 | 1.11062 | 1.08540 | open +0.79R |
| 10-21T21:00 | AUDJPY | LONG | REV | 2nd | 111.210 | 109.940 | 113.562 | open -0.85R |
| 10-21T21:00 | USDCHF | LONG | REV | 1st ⚠ | 0.82442 | 0.81738 | 0.85632 | open -0.63R |
| 10-21T21:00 | AUDCHF | LONG | REV | 3rd | 0.57970 | 0.57426 | 0.59652 | open -0.85R |
| 10-21T21:00 | NZDCHF | SHORT | REV | 6th | 0.47054 | 0.47381 | 0.45836 | open +1.33R |
| 10-21T13:00 | EURCAD | SHORT | REV | 1st ⚠ | 1.57886 | 1.58826 | 1.56736 | open +0.46R |
| 10-22T01:00 | GBPUSD | SHORT | REV | 1st ⚠ | 1.33979 | 1.34888 | 1.29883 | open -0.10R |
| 10-22T01:00 | NZDUSD | SHORT | REV | 2nd | 0.56892 | 0.57535 | 0.51428 | open +0.04R |
| 10-22T01:00 | EURNZD | LONG | REV | 5th | 1.97635 | 1.96021 | 2.01019 | open -0.04R |
| 10-22T01:00 | EURCAD | LONG | REV | 1st ⚠ | 1.57767 | 1.56636 | 1.62445 | open -0.28R |
| 10-22T01:00 | NZDJPY | SHORT | REV | 7th | 89.720 | 90.827 | 87.497 | open +0.40R |
| 10-22T01:00 | GBPNZD | LONG | REV | 3rd | 2.35491 | 2.33671 | 2.37918 | open +0.16R |
| 10-22T01:00 | GBPJPY | SHORT | REV | 3rd | 211.302 | 213.121 | 206.523 | open +0.43R |
| 10-22T01:00 | EURAUD | SHORT | REV | 1st ⚠ | 1.60210 | 1.61243 | 1.55743 | open +0.03R |
| 10-22T05:00 | GBPJPY | SHORT | REV | 1st ⚠ | 210.522 | 212.961 | 206.523 | open +0.00R |
| 10-22T05:00 | GBPJPY | SHORT | WALL | 1st ⚠ | 210.522 | 211.365 | 206.523 | open +0.00R |
| 10-22T05:00 | EURJPY | SHORT | WALL | 1st ⚠ | 176.404 | 177.632 | 171.729 | open +0.00R |
| 10-22T05:00 | AUDNZD | LONG | REV | 2nd | 1.23342 | 1.22493 | 1.26706 | open +0.00R |

## Running tally, last 30 days

9 resolved · 0 target / 9 stopped · **-9.0R** · -1.000R per call · 51 still open

```
