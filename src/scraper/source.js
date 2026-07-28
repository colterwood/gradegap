import { config } from '../config.js';
import { createMockSource } from './mock/mockSource.js';

// The real source is imported lazily so mock mode never needs Playwright.
export async function createSource() {
  if (config.mock) return createMockSource();
  const { createCardLadderSource } = await import('./cardladder/clSource.js');
  return createCardLadderSource();
}
