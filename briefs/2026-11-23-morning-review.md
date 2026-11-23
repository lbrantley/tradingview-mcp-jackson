# Scanner Review — 2026-11-23 (morning)

Generated: 2026-11-23T12:00:38.002Z

```
## The clock

It is **06:00 Chicago** — a **normal** hour at 1.10x an average one.
An order placed now rests through **the NY overlap** — about 5h of cover.
Next window: **NY overlap** in 1h.

_Morning pass. The NY overlap is the single best window of the day but it is the only one left before the afternoon goes dead, so this is the adjustment pass: the morning-skewed pairs, and anything that filled overnight._

## Where the energy is

**Running hot:** AUDJPY 1.26 · EURAUD 1.25 · AUDCHF 1.20 · GBPAUD 1.19 · AUDUSD 1.17 · AUDCAD 1.17 · GBPJPY 1.16
**Quiet:** _none_

_Volatility persists for about two days, so a hot pair stays hot. It says nothing about direction — this picks the pair, the levels pick the side._

## Account

NAV **$1199.34**   unrealised $-346.35   margin available $81.19   4 open

| pair | units | now | P/L | stop | distance | news lean |
|---|---|---|---|---|---|---|
| EURCAD | 9000 | 1.57172 | $-76.45 | **none** | — | — |
| EURCAD | 11000 | 1.57172 | $-40.81 | **none** | — | — |
| EURCAD | 14000 | 1.57172 | $57.60 | **none** | — | — |
| EURCAD | 17000 | 1.57172 | $-286.69 | **none** | — | — |

**What the system reads on each position**

- **EURCAD** LONG — last REVERSAL LONG 74h ago at 1.56689 — system stop 1.55869, target **1.62068**; 490p to that target from here

## Order blocks live right now

### Daily

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| GBPNZD | SHORT | **2.39535** | 2.40578 | 104p $5.71 | 10% | 0.3R | 94% | 1d | 1.26x | 68% / 39% |
| GBPCAD | LONG | **1.87092** | 1.86329 | 76p $5.32 | 7% | 0.8R | 87% | 9d | 1.58x | 68% / 39% |
| EURGBP | LONG | **0.83460** | 0.83222 | 24p $3.11 | 5% | 1.5R | 81% | 1d | 1.50x | 68% / 39% |
| AUDUSD | LONG | **0.65028** | 0.64297 | 73p $7.31 | 2% | 1.6R | 81% | 250d | 1.44x | 75% / 53% |
| GBPJPY | SHORT | **209.580** | 210.764 | 118p $7.46 | 3% | 1.8R | 81% | 1d | 1.37x | 68% / 39% |

_6 more live but further out, 2.4R to 6.6R away. They alert on their own when they come within 1R._
_Older blocks run further: 60+ days reaches 2R 58% of the time against 34% for a same-day fill._

### 4-hour

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| USDCHF | SHORT | **0.83920** | 0.84155 | 24p $2.80 | 7% | 0.0R | 87% | 0d | 1.54x | 70% / 46% |
| CHFJPY | LONG | **189.212** | 188.603 | 61p $3.84 | 7% | 0.7R | 83% | 0d | 1.40x | 70% / 46% |
| NZDUSD | SHORT | **0.54884** | 0.55081 | 20p $1.97 | 12% | 0.9R | 83% | 1d | 1.39x | 70% / 46% |
| CADCHF | SHORT | **0.58862** | 0.59032 | 17p $2.03 | 15% | 1.7R | 79% | 1d | 1.56x | 70% / 46% |

_17 more live but further out, 2.4R to 8.0R away. They alert on their own when they come within 1R._
_H4 stops are a third of a daily one, so spread bites three times as hard — a bolded spread figure is most of the edge gone before price moves._

### In reach, drawn

_6 blocks within 2R of the limit. Blocks further out are in the tables above but not worth a picture yet._

**USDCHF SHORT** · 4-hour · 0.02R away · waited 0d

![USDCHF H4 order block: how it formed, and where price is now](charts/2026-11-23/USDCHF-H4-2026-11-22.svg)

**GBPNZD SHORT** · daily · 0.34R away · waited 1d

![GBPNZD D order block: how it formed, and where price is now](charts/2026-11-23/GBPNZD-D-2026-11-16.svg)

**CHFJPY LONG** · 4-hour · 0.68R away · waited 0d

![CHFJPY H4 order block: how it formed, and where price is now](charts/2026-11-23/CHFJPY-H4-2026-11-20.svg)

**GBPCAD LONG** · daily · 0.79R away · waited 9d

![GBPCAD D order block: how it formed, and where price is now](charts/2026-11-23/GBPCAD-D-2026-10-27.svg)

**NZDUSD SHORT** · 4-hour · 0.89R away · waited 1d

![NZDUSD H4 order block: how it formed, and where price is now](charts/2026-11-23/NZDUSD-H4-2026-11-20.svg)

**EURGBP LONG** · daily · 1.50R away · waited 1d

![EURGBP D order block: how it formed, and where price is now](charts/2026-11-23/EURGBP-D-2026-11-16.svg)

_Left panel is the block forming, right is where price sits now. Legend is in each image._

## Scanner calls, last 1 day

| when | pair | dir | branch | firing | entry | stop | target | outcome |
|---|---|---|---|---|---|---|---|---|
| 11-22T22:00 | GBPCAD | LONG | REV | 3rd | 1.87917 | 1.86798 | 1.93866 | open -0.04R |
| 11-22T22:00 | EURNZD | SHORT | REV | 1st ⚠ | 2.00526 | 2.02134 | 1.95988 | open -0.04R |
| 11-22T22:00 | AUDCHF | LONG | REV | 1st ⚠ | 0.55778 | 0.55172 | 0.58186 | open -0.04R |
| 11-22T22:00 | AUDUSD | LONG | REV | 5th | 0.66426 | 0.65753 | 0.72420 | open +0.03R |
| 11-23T02:00 | USDCAD | SHORT | REV | 11th | 1.43223 | 1.44192 | 1.37910 | open -0.05R |
| 11-23T02:00 | CHFJPY | SHORT | REV | 3rd | 189.392 | 190.903 | 187.587 | open -0.15R |
| 11-23T06:00 | GBPCHF | SHORT | REV | 3rd | 1.10046 | 1.10997 | 1.08088 | open +0.00R |
| 11-23T06:00 | CADCHF | LONG | REV | 3rd | 0.58572 | 0.58099 | 0.60486 | open +0.00R |
| 11-23T06:00 | AUDNZD | LONG | REV | 3rd | 1.21455 | 1.20507 | 1.29364 | open +0.00R |
| 11-23T06:00 | EURCHF | SHORT | REV | 9th | 0.92085 | 0.92750 | 0.89149 | open +0.00R |
| 11-23T06:00 | GBPJPY | LONG | REV | 2nd | 208.671 | 206.432 | 218.430 | open +0.00R |
| 11-23T06:00 | CHFJPY | SHORT | REV | 1st ⚠ | 189.624 | 191.512 | 187.587 | open +0.00R |
| 11-23T06:00 | EURGBP | LONG | REV | 1st ⚠ | 0.83682 | 0.83354 | 0.84230 | open +0.00R |
| 11-23T06:00 | AUDCAD | LONG | REV | 3rd | 0.95192 | 0.94411 | 1.00292 | open +0.00R |

## Running tally, last 30 days

16 resolved · 3 target / 13 stopped · **-7.6R** · -0.473R per call · 44 still open

```
