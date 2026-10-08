import { describe, expect, it } from 'vitest';
import { maxSeq, toSeq } from './seq';

describe('seq', () => {
  it('compares string and number room_seq as bigint', () => {
    expect(toSeq('9007199254740993')).toBeGreaterThan(toSeq(9007199254740992));
  });
  it('maxSeq returns the largest as a string and "0" for none', () => {
    expect(maxSeq(['2', 10, '9'])).toBe('10');
    expect(maxSeq([])).toBe('0');
  });
});
