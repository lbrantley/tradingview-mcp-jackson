# Scanner Review — 2026-11-20 (morning)

Generated: 2026-11-20T12:00:45.145Z

```
## The clock

It is **06:00 Chicago** — a **normal** hour at 1.10x an average one.
An order placed now rests through **the NY overlap** — about 5h of cover.
Next window: **NY overlap** in 1h.

_Morning pass. The NY overlap is the single best window of the day but it is the only one left before the afternoon goes dead, so this is the adjustment pass: the morning-skewed pairs, and anything that filled overnight._

## Where the energy is

**Running hot:** AUDJPY 1.22 · AUDUSD 1.15 · GBPJPY 1.15
**Quiet:** CADCHF 0.90 · USDCHF 0.89 · USDJPY 0.89

_Volatility persists for about two days, so a hot pair stays hot. It says nothing about direction — this picks the pair, the levels pick the side._

## Account

NAV **$1153.59**   unrealised $-393.54   margin available $35.71   4 open

| pair | units | now | P/L | stop | distance | news lean |
|---|---|---|---|---|---|---|
| EURCAD | 9000 | 1.57039 | $-84.79 | **none** | — | — |
| EURCAD | 11000 | 1.57039 | $-50.97 | **none** | — | — |
| EURCAD | 14000 | 1.57039 | $44.74 | **none** | — | — |
| EURCAD | 17000 | 1.57039 | $-302.52 | **none** | — | — |

**What the system reads on each position**

- **EURCAD** LONG — last REVERSAL LONG 46h ago at 1.56689 — system stop 1.55856, target **1.62068**; 503p to that target from here

## Order blocks live right now

### Daily

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| GBPJPY | SHORT | **209.580** | 210.764 | 118p $7.41 | 3% | 0.5R | 87% | 0d | 1.37x | 68% / 39% |
| GBPCAD | LONG | **1.87092** | 1.86329 | 76p $5.32 | 6% | 0.7R | 87% | 8d | 1.58x | 68% / 39% |
| GBPNZD | SHORT | **2.39535** | 2.40578 | 104p $5.72 | 11% | 0.9R | 87% | 0d | 1.26x | 68% / 39% |
| USDJPY | LONG | **158.530** | 157.582 | 95p $5.94 | 2% | 1.2R | 81% | 6d | 1.37x | 68% / 39% |
| EURGBP | LONG | **0.83460** | 0.83222 | 24p $3.11 | 5% | 1.4R | 81% | 0d | 1.50x | 68% / 39% |

_7 more live but further out, 2.1R to 7.5R away. They alert on their own when they come within 1R._
_Older blocks run further: 60+ days reaches 2R 58% of the time against 34% for a same-day fill._

### 4-hour

| pair | dir | limit | stop | 1R | spread | away | fills | waited | window | reaches 1R / 2R |
|---|---|---|---|---|---|---|---|---|---|---|
| GBPCHF | LONG | **1.09748** | 1.09424 | 32p $3.84 | 13% | 1.4R | 79% | 9d | 1.51x | 78% / 51% |
| USDJPY | LONG | **158.068** | 157.628 | 44p $2.76 | 4% | 1.5R | 79% | 8d | 1.37x | 78% / 51% |
| EURNZD | LONG | **1.98402** | 1.97729 | 67p $3.69 | 10% | 1.6R | 79% | 14d | 1.27x | 78% / 51% |
| NZDCHF | LONG | **0.45914** | 0.45724 | 19p $2.25 | 19% | 1.8R | 79% | 9d | 1.27x | 78% / 51% |

_15 more live but further out, 2.5R to 7.8R away. They alert on their own when they come within 1R._
_H4 stops are a third of a daily one, so spread bites three times as hard — a bolded spread figure is most of the edge gone before price moves._

### In reach, drawn

_6 blocks within 2R of the limit. Blocks further out are in the tables above but not worth a picture yet._

**GBPJPY SHORT** · daily · 0.50R away · waited 0d

![GBPJPY D order block: how it formed, and where price is now](charts/2026-11-20/GBPJPY-D-2026-11-16.svg)

**GBPCAD LONG** · daily · 0.75R away · waited 8d

![GBPCAD D order block: how it formed, and where price is now](charts/2026-11-20/GBPCAD-D-2026-10-27.svg)

**GBPNZD SHORT** · daily · 0.85R away · waited 0d

![GBPNZD D order block: how it formed, and where price is now](charts/2026-11-20/GBPNZD-D-2026-11-16.svg)

**USDJPY LONG** · daily · 1.21R away · waited 6d

![USDJPY D order block: how it formed, and where price is now](charts/2026-11-20/USDJPY-D-2026-11-08.svg)

**EURGBP LONG** · daily · 1.41R away · waited 0d

![EURGBP D order block: how it formed, and where price is now](charts/2026-11-20/EURGBP-D-2026-11-16.svg)

**GBPCHF LONG** · 4-hour · 1.42R away · waited 9d

![GBPCHF H4 order block: how it formed, and where price is now](charts/2026-11-20/GBPCHF-H4-2026-11-06.svg)

_Left panel is the block forming, right is where price sits now. Legend is in each image._

## Scanner calls, last 1 day

| when | pair | dir | branch | firing | entry | stop | target | outcome |
|---|---|---|---|---|---|---|---|---|
| 11-19T14:00 | NZDCHF | LONG | REV | 10th | 0.46404 | 0.45969 | 0.47585 | open -0.33R |
| 11-19T14:00 | EURCAD | LONG | REV | 4th | 1.57240 | 1.56329 | 1.62068 | open -0.13R |
| 11-19T14:00 | GBPAUD | LONG | REV | 2nd | 1.96443 | 1.94480 | 2.01992 | open +0.20R |
| 11-19T14:00 | NZDCAD | SHORT | REV | 4th | 0.78770 | 0.79468 | 0.75568 | open +0.00R |
| 11-19T14:00 | GBPCHF | LONG | REV | 1st ⚠ | 1.10568 | 1.09940 | 1.11572 | open -0.57R |
| 11-19T14:00 | CADJPY | SHORT | REV | 1st ⚠ | 111.604 | 112.407 | 109.609 | open +0.97R |
| 11-19T14:00 | AUDJPY | SHORT | WALL | 2nd | 106.618 | 107.340 | 105.171 | open +1.35R |
| 11-19T18:00 | NZDJPY | SHORT | REV | 3rd | 87.573 | 88.611 | 85.691 | open +0.27R |
| 11-19T18:00 | CADJPY | SHORT | REV | 5th | 111.374 | 112.633 | 109.609 | open +0.43R |
| 11-19T18:00 | USDCAD | SHORT | REV | 1st ⚠ | 1.43394 | 1.44413 | 1.37910 | open +0.17R |
| 11-19T18:00 | CHFJPY | SHORT | REV | 2nd | 189.202 | 190.801 | 187.587 | open +0.31R |
| 11-19T18:00 | EURGBP | SHORT | REV | 1st ⚠ | 0.83796 | 0.84117 | 0.82430 | open +0.18R |
| 11-19T18:00 | USDJPY | SHORT | REV | 5th | 159.679 | 160.404 | 155.748 | open +1.33R |
| 11-19T22:00 | USDJPY | SHORT | REV | 1st ⚠ | 159.338 | 160.592 | 155.748 | open +0.50R |
| 11-19T22:00 | CADJPY | SHORT | REV | 2nd | 111.115 | 112.159 | 109.609 | open +0.27R |
| 11-20T02:00 | GBPJPY | LONG | REV | 1st ⚠ | 208.612 | 206.519 | 218.430 | open -0.32R |
| 11-20T02:00 | USDCAD | SHORT | REV | 9th | 1.43252 | 1.44171 | 1.37910 | open +0.04R |
| 11-20T02:00 | GBPCAD | LONG | REV | 1st ⚠ | 1.87745 | 1.86880 | 1.93866 | open -0.12R |
| 11-20T02:00 | EURJPY | LONG | REV | 6th | 174.746 | 173.556 | 181.884 | open -0.51R |
| 11-20T02:00 | EURUSD | LONG | REV | 1st ⚠ | 1.09784 | 1.09071 | 1.14416 | open -0.10R |
| 11-20T06:00 | EURCAD | SHORT | REV | 7th | 1.57126 | 1.58377 | 1.49662 | open +0.00R |

## Running tally, last 30 days

19 resolved · 1 target / 18 stopped · **-17.0R** · -0.893R per call · 41 still open

```
