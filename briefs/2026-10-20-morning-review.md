# Scanner Review — 2026-10-20 (morning)

Generated: 2026-10-20T11:03:38.340Z

```
## The clock

It is **06:00 Chicago** — a **normal** hour at 1.10x an average one.
An order placed now rests through **the NY overlap** — about 5h of cover.
Next window: **NY overlap** in 1h.

_Morning pass. The NY overlap is the single best window of the day but it is the only one left before the afternoon goes dead, so this is the adjustment pass: the morning-skewed pairs, and anything that filled overnight._

## Where the energy is

**Running hot:** EURCAD 1.27 · EURAUD 1.25 · AUDCHF 1.17
**Quiet:** CADJPY 0.87 · NZDJPY 0.84 · EURJPY 0.82 · CHFJPY 0.82 · USDJPY 0.79 · GBPJPY 0.78

_Volatility persists for about two days, so a hot pair stays hot. It says nothing about direction — this picks the pair, the levels pick the side._

## Account

NAV **$836.81**   unrealised $-255.31   margin available $455.69   1 open

| pair | units | now | P/L | stop | distance | news lean |
|---|---|---|---|---|---|---|
| EURCAD | 17000 | 1.57479 | $-255.31 | **none** | — | — |

**What the system reads on each position**

- **EURCAD** LONG — last CONTINUATION LONG 102h ago at 1.59047 — system stop 1.58363, target **1.62445** (Grade C); 497p to that target from here

## Order blocks live right now

### Daily

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| USDCHF | SHORT | **0.83172** | 0.84030 | 86p $10.38 | 2% | 0.6R | 87% | 1d | 1.54x | 68% / 39% |

_7 more live but further out, 2.8R to 7.4R away. They alert on their own when they come within 1R._
_Older blocks run further: 60+ days reaches 2R 58% of the time against 34% for a same-day fill._

### 4-hour

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| EURGBP | LONG | **0.83879** | 0.83526 | 35p $4.70 | 3% | 0.5R | 83% | 361d | 1.50x | 78% / 51% |
| GBPCHF | SHORT | **1.10496** | 1.10729 | 23p $2.82 | 17% | 1.7R | 79% | 3d | 1.51x | 77% / 47% |
| EURCAD | LONG | **1.56944** | 1.56513 | 43p $3.06 | 8% | 1.9R | 79% | 156d | 1.59x | 78% / 51% |
| EURAUD | LONG | **1.59828** | 1.59527 | 30p $2.10 | 12% | 1.9R | 79% | 3d | 1.34x | 77% / 47% |
| GBPAUD | LONG | **1.89510** | 1.88846 | 66p $4.64 | 8% | 2.0R | 79% | 3d | 1.34x | 77% / 47% |

_11 more live but further out, 2.5R to 7.4R away. They alert on their own when they come within 1R._
_H4 stops are a third of a daily one, so spread bites three times as hard — a bolded spread figure is most of the edge gone before price moves._

### In reach, drawn

_6 blocks within 2R of the limit. Blocks further out are in the tables above but not worth a picture yet._

**EURGBP LONG** · 4-hour · 0.53R away · waited 361d

![EURGBP H4 order block: how it formed, and where price is now](charts/2026-10-20/EURGBP-H4-2025-05-28.svg)

**USDCHF SHORT** · daily · 0.58R away · waited 1d

![USDCHF D order block: how it formed, and where price is now](charts/2026-10-20/USDCHF-D-2026-10-13.svg)

**GBPCHF SHORT** · 4-hour · 1.69R away · waited 3d

![GBPCHF H4 order block: how it formed, and where price is now](charts/2026-10-20/GBPCHF-H4-2026-10-14.svg)

**EURCAD LONG** · 4-hour · 1.90R away · waited 156d

![EURCAD H4 order block: how it formed, and where price is now](charts/2026-10-20/EURCAD-H4-2026-03-16.svg)

**EURAUD LONG** · 4-hour · 1.94R away · waited 3d

![EURAUD H4 order block: how it formed, and where price is now](charts/2026-10-20/EURAUD-H4-2026-10-14.svg)

**GBPAUD LONG** · 4-hour · 1.98R away · waited 3d

![GBPAUD H4 order block: how it formed, and where price is now](charts/2026-10-20/GBPAUD-H4-2026-10-14.svg)

_Left panel is the block forming, right is where price sits now. Legend is in each image._

## Scanner calls, last 1 day

| when | pair | dir | branch | firing | entry | stop | target | outcome |
|---|---|---|---|---|---|---|---|---|
| 10-19T13:00 | EURCHF | SHORT | REV | 6th | 0.92622 | 0.93071 | 0.90334 | open +0.15R |
| 10-19T13:00 | USDCHF | SHORT | REV | 3rd | 0.82610 | 0.83206 | 0.80718 | open +0.21R |
| 10-19T13:00 | EURGBP | LONG | REV | 2nd | 0.84276 | 0.83891 | 0.86717 | open -0.54R |
| 10-19T17:00 | AUDCAD | LONG | REV | 3rd | 0.98489 | 0.97747 | 1.00604 | open -0.19R |
| 10-19T21:00 | NZDCHF | SHORT | REV | 3rd | 0.46787 | 0.47310 | 0.45425 | open -0.19R |
| 10-19T21:00 | NZDCAD | SHORT | REV | 1st ⚠ | 0.79836 | 0.80585 | 0.78749 | open -0.12R |
| 10-19T21:00 | GBPJPY | LONG | REV | 1st ⚠ | 211.112 | 209.428 | 213.533 | open -0.00R |
| 10-19T21:00 | AUDCHF | SHORT | REV | 1st ⚠ | 0.57624 | 0.58225 | 0.56031 | open -0.12R |
| 10-20T01:00 | NZDUSD | LONG | REV | 1st ⚠ | 0.56768 | 0.56114 | 0.61544 | open +0.12R |
| 10-20T01:00 | USDJPY | SHORT | REV | 12th | 158.186 | 159.431 | 153.713 | open +0.03R |
| 10-20T01:00 | GBPAUD | LONG | REV | 1st ⚠ | 1.90920 | 1.89620 | 1.94986 | open -0.07R |
| 10-20T01:00 | AUDUSD | LONG | REV | 2nd | 0.69838 | 0.69176 | 0.71228 | open +0.17R |
| 10-20T01:00 | EURCHF | SHORT | REV | 7th | 0.92638 | 0.93039 | 0.90334 | open +0.20R |
| 10-20T05:00 | EURCHF | SHORT | REV | 2nd | 0.92556 | 0.93141 | 0.90334 | open +0.00R |
| 10-20T05:00 | GBPCHF | LONG | REV | 3rd | 1.10102 | 1.09417 | 1.12516 | open +0.00R |
| 10-20T05:00 | EURCAD | SHORT | WALL | 5th | 1.57763 | 1.58550 | 1.56736 | open +0.00R |
| 10-20T05:00 | EURAUD | SHORT | REV | 1st ⚠ | 1.60414 | 1.61768 | 1.55743 | open +0.00R |

## Running tally, last 30 days

6 resolved · 0 target / 6 stopped · **-6.0R** · -1.000R per call · 54 still open

```
