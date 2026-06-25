/**
 * Deploy v5.3 — Weekly EMA HTF filter
 * Injects Pine Script and compiles. Retries Pine Editor open up to 3 times.
 */
import { readFileSync } from 'fs';
import { setSource, smartCompile, getErrors } from '../src/core/pine.js';

const SOURCE_PATH = new URL('../scripts/4h_smc_strategy.pine', import.meta.url).pathname;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function deploy() {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  console.log(`Source loaded: ${source.split('\n').length} lines`);

  // Inject source — retry up to 3 times (Pine Editor open is intermittent)
  let injected = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await setSource({ source });
      console.log(`Source injected (attempt ${attempt})`);
      injected = true;
      break;
    } catch (e) {
      console.log(`Inject attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await sleep(3000);
    }
  }

  if (!injected) {
    console.error('Failed to inject source after 3 attempts. Aborting.');
    process.exit(1);
  }

  await sleep(1000);

  // Compile
  let compiled = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await smartCompile();
      console.log(`Compile result (attempt ${attempt}):`, JSON.stringify(result));
      compiled = true;
      break;
    } catch (e) {
      console.log(`Compile attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await sleep(3000);
    }
  }

  if (!compiled) {
    console.error('Compile failed after 3 attempts.');
    process.exit(1);
  }

  await sleep(2000);

  // Check for errors
  try {
    const errors = await getErrors();
    if (errors && errors.errors && errors.errors.length > 0) {
      console.error('Compilation errors:');
      errors.errors.forEach(e => console.error(' -', e));
    } else {
      console.log('No errors — v5.3 is live.');
    }
  } catch (e) {
    console.log('Could not check errors:', e.message);
  }
}

deploy().catch(console.error);
