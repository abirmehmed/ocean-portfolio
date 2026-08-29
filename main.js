/**
 * Entry point. Thin by design: all real logic lives in ocean.js (the
 * WebGPU/TSL engine + its own UI controls) and portfolio.js (panel nav,
 * carousel, contact form, case-study modal), which have zero imports
 * between them.
 *
 * initPortfolio() runs unconditionally, before initOcean() — the
 * portfolio shell must work whether or not WebGPU/the ocean succeeds.
 */

import { initOcean } from './ocean.js';
import { initPortfolio } from './portfolio.js';

initPortfolio();
initOcean();
