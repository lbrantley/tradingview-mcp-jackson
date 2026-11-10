# Scanner Review — 2026-11-10 (morning)

Generated: 2026-11-10T12:00:38.494Z

```
## The clock

It is **06:00 Chicago** — a **normal** hour at 1.10x an average one.
An order placed now rests through **the NY overlap** — about 5h of cover.
Next window: **NY overlap** in 1h.

_Morning pass. The NY overlap is the single best window of the day but it is the only one left before the afternoon goes dead, so this is the adjustment pass: the morning-skewed pairs, and anything that filled overnight._

## Where the energy is

**Running hot:** AUDCHF 1.22 · GBPAUD 1.21 · EURAUD 1.21 · AUDNZD 1.18 · AUDCAD 1.16 · NZDCHF 1.16 · AUDUSD 1.16
**Quiet:** _none_

_Volatility persists for about two days, so a hot pair stays hot. It says nothing about direction — this picks the pair, the levels pick the side._

## Account

NAV **$1186.91**   unrealised $121.72   margin available $42.68   4 open

| pair | units | now | P/L | stop | distance | news lean |
|---|---|---|---|---|---|---|
| EURCAD | 9000 | 1.58483 | $5.92 | 1.57288 | 119p | — |
| EURCAD | 11000 | 1.58483 | $60.65 | 1.57288 | 119p | — |
| EURCAD | 14000 | 1.58483 | $188.36 | 1.57288 | 119p | — |
| EURCAD | 17000 | 1.58483 | $-133.21 | 1.57288 | 119p | — |

**What the system reads on each position**

- **EURCAD** LONG — last CONTINUATION LONG 26h ago at 1.57295 — system stop 1.56391, target **1.62445** (Grade B); 396p to that target from here

## Order blocks live right now

### Daily

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| CADCHF | SHORT | **0.58380** | 0.58802 | 42p $5.15 | 5% | 0.8R | 87% | 1d | 1.56x | 68% / 39% |
| USDCHF | SHORT | **0.83172** | 0.84030 | 86p $10.47 | 2% | 1.4R | 81% | 16d | 1.54x | 78% / 46% |

_5 more live but further out, 3.0R to 6.1R away. They alert on their own when they come within 1R._
_Older blocks run further: 60+ days reaches 2R 58% of the time against 34% for a same-day fill._

### 4-hour

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| USDCHF | SHORT | **0.82310** | 0.82519 | 21p $2.55 | 7% | 1.1R | 79% | 6d | 1.54x | 77% / 47% |
| GBPCHF | LONG | **1.09748** | 1.09424 | 32p $3.96 | 12% | 1.4R | 79% | 1d | 1.51x | 70% / 46% |
| EURNZD | LONG | **1.98402** | 1.97729 | 67p $3.79 | 8% | 1.5R | 79% | 6d | 1.27x | 77% / 47% |
| NZDCHF | LONG | **0.45914** | 0.45724 | 19p $2.32 | 18% | 1.6R | 79% | 1d | 1.27x | 70% / 46% |

_18 more live but further out, 2.4R to 7.2R away. They alert on their own when they come within 1R._
_H4 stops are a third of a daily one, so spread bites three times as hard — a bolded spread figure is most of the edge gone before price moves._

### In reach, drawn

_6 blocks within 2R of the limit. Blocks further out are in the tables above but not worth a picture yet._

**CADCHF SHORT** · daily · 0.78R away · waited 1d

![CADCHF D order block: how it formed, and where price is now](charts/2026-11-10/CADCHF-D-2026-11-02.svg)

**USDCHF SHORT** · 4-hour · 1.10R away · waited 6d

![USDCHF H4 order block: how it formed, and where price is now](charts/2026-11-10/USDCHF-H4-2026-10-30.svg)

**GBPCHF LONG** · 4-hour · 1.37R away · waited 1d

![GBPCHF H4 order block: how it formed, and where price is now](charts/2026-11-10/GBPCHF-H4-2026-11-06.svg)

**USDCHF SHORT** · daily · 1.43R away · waited 16d

![USDCHF D order block: how it formed, and where price is now](charts/2026-11-10/USDCHF-D-2026-10-13.svg)

**EURNZD LONG** · 4-hour · 1.46R away · waited 6d

![EURNZD H4 order block: how it formed, and where price is now](charts/2026-11-10/EURNZD-H4-2026-10-30.svg)

**NZDCHF LONG** · 4-hour · 1.59R away · waited 1d

![NZDCHF H4 order block: how it formed, and where price is now](charts/2026-11-10/NZDCHF-H4-2026-11-09.svg)

_Left panel is the block forming, right is where price sits now. Legend is in each image._

## Scanner calls, last 1 day

| when | pair | dir | branch | firing | entry | stop | target | outcome |
|---|---|---|---|---|---|---|---|---|
| 11-09T14:00 | AUDCHF | LONG | REV | 1st ⚠ | 0.56770 | 0.55657 | 0.60005 | open -0.03R |
| 11-09T14:00 | EURUSD | SHORT | REV | 3rd | 1.12032 | 1.12950 | 1.09397 | open -0.26R |
| 11-09T14:00 | EURGBP | SHORT | REV | 1st ⚠ | 0.83488 | 0.83795 | 0.82418 | open -0.44R |
| 11-09T14:00 | AUDNZD | LONG | REV | 3rd | 1.23004 | 1.22068 | 1.29364 | open -0.25R |
| 11-09T18:00 | EURNZD | LONG | REV | 4th | 1.99327 | 1.97696 | 2.01019 | open +0.03R |
| 11-09T18:00 | AUDJPY | SHORT | REV | 2nd | 109.370 | 110.691 | 107.672 | open +0.06R |
| 11-09T18:00 | USDCAD | SHORT | REV | 3rd | 1.41176 | 1.42077 | 1.37910 | open -0.22R |
| 11-09T22:00 | GBPUSD | SHORT | REV | 4th | 1.34436 | 1.35247 | 1.31258 | open +0.23R |
| 11-09T22:00 | NZDCAD | SHORT | REV | 18th | 0.79582 | 0.80301 | 0.78678 | open -0.03R |
| 11-09T22:00 | AUDUSD | SHORT | REV | 2nd | 0.69202 | 0.69913 | 0.67750 | open +0.10R |
| 11-09T22:00 | NZDJPY | SHORT | REV | 3rd | 89.055 | 90.002 | 85.876 | open +0.03R |
| 11-10T06:00 | NZDUSD | SHORT | REV | 1st ⚠ | 0.56308 | 0.57134 | 0.54493 | open +0.00R |
| 11-10T06:00 | USDJPY | LONG | REV | 5th | 158.107 | 156.647 | 160.574 | open +0.00R |
| 11-10T06:00 | CADCHF | LONG | REV | 8th | 0.58059 | 0.57497 | 0.60486 | open +0.00R |
| 11-10T06:00 | GBPJPY | SHORT | REV | 2nd | 212.264 | 214.398 | 206.249 | open +0.00R |
| 11-10T06:00 | USDCHF | LONG | REV | 1st ⚠ | 0.82080 | 0.80983 | 0.84348 | open +0.00R |
| 11-10T06:00 | EURJPY | SHORT | REV | 2nd | 177.502 | 178.818 | 172.184 | open +0.00R |
| 11-10T06:00 | NZDJPY | SHORT | REV | 2nd | 89.026 | 89.990 | 85.876 | open +0.00R |
| 11-10T06:00 | AUDJPY | SHORT | REV | 3rd | 109.297 | 110.594 | 107.672 | open +0.00R |
| 11-10T06:00 | CHFJPY | SHORT | REV | 4th | 192.622 | 194.823 | 187.587 | open +0.00R |

## Running tally, last 30 days

11 resolved · 0 target / 11 stopped · **-11.0R** · -1.000R per call · 49 still open

```
