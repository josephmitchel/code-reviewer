import { describe, expect, it } from 'vitest';
import { ticketReferences } from './landed.js';

/**
 * The merge event reads the PR body to learn which tickets landed. `Addresses #N` is the
 * convention; a closing keyword is the slip the automation has to catch, because GitHub has
 * already closed that ticket by the time this runs.
 */
describe('ticketReferences', () => {
  it('reads Addresses lines, one or many', () => {
    expect(ticketReferences('Addresses #2\n\nAddresses #7')).toEqual({ addressed: [2, 7], closed: [] });
    expect(ticketReferences('addresses #3, #4 and #5')).toEqual({ addressed: [3, 4, 5], closed: [] });
    expect(ticketReferences('Addresses: #9')).toEqual({ addressed: [9], closed: [] });
  });

  it('separates GitHub closing keywords from Addresses', () => {
    expect(ticketReferences('Closes #2\nAddresses #3\nfixes #4')).toEqual({ addressed: [3], closed: [2, 4] });
  });

  it('ignores cross-repo references and bare mentions', () => {
    expect(ticketReferences('Addresses acme/other#5. See also #6 for context.')).toEqual({ addressed: [], closed: [] });
  });

  it('dedupes', () => {
    expect(ticketReferences('Addresses #2\nAddresses #2')).toEqual({ addressed: [2], closed: [] });
  });
});
