# Scanner Review — 2026-11-25 (morning)

Generated: 2026-11-25T12:00:40.799Z

```
## The clock

It is **06:00 Chicago** — a **normal** hour at 1.10x an average one.
An order placed now rests through **the NY overlap** — about 5h of cover.
Next window: **NY overlap** in 1h.

_Morning pass. The NY overlap is the single best window of the day but it is the only one left before the afternoon goes dead, so this is the adjustment pass: the morning-skewed pairs, and anything that filled overnight._

## Where the energy is

**Running hot:** EURAUD 1.33 · GBPAUD 1.33 · AUDCAD 1.28 · AUDCHF 1.27 · AUDUSD 1.27 · AUDJPY 1.26 · AUDNZD 1.17 · GBPCHF 1.16
**Quiet:** _none_

_Volatility persists for about two days, so a hot pair stays hot. It says nothing about direction — this picks the pair, the levels pick the side._

## Account

NAV **$872.23**   unrealised $-679.55   margin available $62.52   3 open

| pair | units | now | P/L | stop | distance | news lean |
|---|---|---|---|---|---|---|
| EURCAD | 9000 | 1.56114 | $-143.38 | **none** | — | — |
| EURCAD | 11000 | 1.56114 | $-122.36 | **none** | — | — |
| EURCAD | 17000 | 1.56114 | $-413.81 | **none** | — | — |

**What the system reads on each position**

- **EURCAD** LONG — last REVERSAL LONG 619h ago at 1.55583 — system stop 1.54751, target **1.62445**; 633p to that target from here

## Order blocks live right now

### Daily

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| GBPJPY | SHORT | **209.580** | 210.764 | 118p $7.43 | 3% | 0.6R | 87% | 3d | 1.37x | 68% / 39% |
| EURGBP | LONG | **0.83460** | 0.83222 | 24p $3.12 | 5% | 0.6R | 87% | 3d | 1.50x | 68% / 39% |
| AUDUSD | LONG | **0.65028** | 0.64297 | 73p $7.31 | 2% | 1.9R | 81% | 252d | 1.44x | 75% / 53% |

_7 more live but further out, 2.1R to 7.6R away. They alert on their own when they come within 1R._
_Older blocks run further: 60+ days reaches 2R 58% of the time against 34% for a same-day fill._

### 4-hour

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| GBPCAD | LONG | **1.86334** | 1.86167 | 17p $1.17 | **31%** | 1.6R | 79% | 19d | 1.58x | 78% / 51% |

_21 more live but further out, 2.7R to 7.5R away. They alert on their own when they come within 1R._
_H4 stops are a third of a daily one, so spread bites three times as hard — a bolded spread figure is most of the edge gone before price moves._

### In reach, drawn

_4 blocks within 2R of the limit. Blocks further out are in the tables above but not worth a picture yet._

**GBPJPY SHORT** · daily · 0.60R away · waited 3d

![GBPJPY D order block: how it formed, and where price is now](charts/2026-11-25/GBPJPY-D-2026-11-16.svg)

**EURGBP LONG** · daily · 0.62R away · waited 3d

![EURGBP D order block: how it formed, and where price is now](charts/2026-11-25/EURGBP-D-2026-11-16.svg)

**GBPCAD LONG** · 4-hour · 1.60R away · waited 19d

![GBPCAD H4 order block: how it formed, and where price is now](charts/2026-11-25/GBPCAD-H4-2026-10-29.svg)

**AUDUSD LONG** · daily · 1.88R away · waited 252d

![AUDUSD D order block: how it formed, and where price is now](charts/2026-11-25/AUDUSD-D-2025-11-19.svg)

_Left panel is the block forming, right is where price sits now. Legend is in each image._

## Scanner calls, last 1 day

| when | pair | dir | branch | firing | entry | stop | target | outcome |
|---|---|---|---|---|---|---|---|---|
| 11-24T14:00 | GBPCAD | SHORT | REV | 4th | 1.87326 | 1.88481 | 1.83108 | open +0.63R |
| 11-24T14:00 | EURCHF | SHORT | REV | 1st ⚠ | 0.91667 | 0.92271 | 0.89149 | open +0.63R |
| 11-24T14:00 | CADJPY | SHORT | REV | 2nd | 111.523 | 112.510 | 109.609 | open -0.05R |
| 11-24T14:00 | AUDCAD | SHORT | WALL | 1st ⚠ | 0.94840 | 0.95374 | 0.93882 | target +1.79R |
| 11-24T18:00 | CADCHF | LONG | REV | 4th | 0.58563 | 0.58081 | 0.60092 | open -0.34R |
| 11-24T18:00 | EURCAD | SHORT | WALL | 1st ⚠ | 1.56463 | 1.57040 | 1.49662 | open +0.25R |
| 11-24T22:00 | NZDCHF | SHORT | REV | 2nd | 0.45758 | 0.46283 | 0.43366 | open +0.49R |
| 11-24T22:00 | EURCAD | SHORT | REV | 1st ⚠ | 1.56370 | 1.57581 | 1.49662 | open +0.04R |
| 11-24T22:00 | USDJPY | LONG | REV | 5th | 159.269 | 158.062 | 162.686 | open +0.15R |
| 11-24T22:00 | AUDNZD | SHORT | REV | 3rd | 1.21242 | 1.22445 | 1.18616 | open +0.69R |
| 11-24T22:00 | GBPAUD | LONG | REV | 1st ⚠ | 1.97490 | 1.95187 | 2.01992 | open +0.60R |
| 11-24T22:00 | AUDUSD | LONG | WALL | 5th | 0.66367 | 0.66129 | 0.72420 | stopped -1.00R |
| 11-24T22:00 | NZDUSD | SHORT | REV | 2nd | 0.54738 | 0.55356 | 0.53969 | open +0.35R |
| 11-24T22:00 | GBPNZD | LONG | REV | 3rd | 2.39442 | 2.37984 | 2.43525 | open +0.03R |
| 11-25T02:00 | NZDCAD | SHORT | REV | 1st ⚠ | 0.78028 | 0.78752 | 0.75568 | open +0.15R |
| 11-25T06:00 | CADCHF | SHORT | REV | 1st ⚠ | 0.58401 | 0.59063 | 0.56581 | open +0.00R |
| 11-25T06:00 | NZDCHF | SHORT | WALL | 1st ⚠ | 0.45502 | 0.45883 | 0.43366 | open +0.00R |
| 11-25T06:00 | EURNZD | LONG | REV | 4th | 2.00624 | 1.99093 | 2.08038 | open +0.00R |
| 11-25T06:00 | EURCHF | SHORT | WALL | 1st ⚠ | 0.91288 | 0.91610 | 0.89149 | open +0.00R |
| 11-25T06:00 | NZDJPY | LONG | REV | 2nd | 86.933 | 85.973 | 89.424 | open +0.00R |
| 11-25T06:00 | USDCHF | SHORT | REV | 2nd | 0.83458 | 0.84274 | 0.79420 | open +0.00R |
| 11-25T06:00 | EURJPY | LONG | REV | 6th | 174.406 | 172.827 | 181.884 | open +0.00R |

## Running tally, last 30 days

13 resolved · 1 target / 12 stopped · **-10.2R** · -0.784R per call · 47 still open

```
