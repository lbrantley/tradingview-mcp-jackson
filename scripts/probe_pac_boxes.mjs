#!/usr/bin/env node
// Probe PAC (Price Action Concepts) boxes on a single symbol to see what
// information is encoded in each box (high/low/time range/colors).

import { setSymbol, setTimeframe } from '../src/core/chart.js';
import { getPineBoxes, getPineLabels } from '../src/core/data.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const symbol = process.argv[2] ? `OANDA:${process.argv[2]}` : 'OANDA:EURUSD';
  const tf = process.argv[3] || '240';

  console.log(`\nProbing PAC boxes on ${symbol} @ ${tf}\n`);

  await setSymbol({ symbol });
  await sleep(4000);
  await setTimeframe({ timeframe: tf });
  await sleep(4000);

  const boxes = await getPineBoxes({ study_filter: 'Price Action Concepts', verbose: true });
  const labels = await getPineLabels({ study_filter: 'Price Action Concepts', verbose: true, max_labels: 30 });

  const study = boxes.studies?.[0];
  if (!study) {
    console.log('No PAC study found on chart.');
    process.exit(1);
  }

  console.log(`Study: ${study.name}`);
  console.log(`Total boxes: ${study.total_boxes}`);
  console.log(`Deduplicated zones: ${study.zones.length}\n`);

  console.log('── ALL BOXES (raw) ──');
  const colorMap = {};
  for (const b of (study.all_boxes || [])) {
    const colorKey = `border:${b.borderColor}|bg:${b.bgColor}`;
    colorMap[colorKey] = (colorMap[colorKey] || 0) + 1;
    console.log(`  id=${String(b.id ?? '').slice(0, 12)}  high=${b.high}  low=${b.low}  x1=${b.x1}  x2=${b.x2}  border=${b.borderColor}  bg=${b.bgColor}`);
  }

  console.log('\n── COLOR FREQUENCY ──');
  for (const [k, v] of Object.entries(colorMap).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}×  ${k}`);
  }

  console.log('\n── PAC LABELS (for cross-reference) ──');
  const labelStudy = labels.studies?.[0];
  if (labelStudy) {
    for (const l of labelStudy.labels.slice(-15)) {
      console.log(`  text="${l.text}"  price=${l.price}  x=${l.x}  textColor=${l.textColor}  color=${l.color}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
