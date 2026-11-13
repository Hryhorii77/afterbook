import { describe, expect, it } from 'vitest';
import { cleanNumberInput, readNumberField, readNumberFields } from '../lib/agent/formFields';

describe('readNumberField', () => {
  it('reads plain numbers', () => {
    for (const [raw, n] of [['0.3', 0.3], ['10', 10], ['.5', 0.5], ['5.', 5], [' 1000 ', 1000], ['0', 0]] as const)
      expect(readNumberField(raw, 'X')).toBe(n);
  });
  it('refuses what the inputs let through, instead of sending NaN (read as “not given”) or 0', () => {
    expect(readNumberField('1.2.3', 'Most to pay to trade')).toBe('Most to pay to trade isn’t a number');
    expect(readNumberField('.', 'X')).toBe('X isn’t a number');
    expect(readNumberField('', 'The budget')).toBe('The budget is empty');
    expect(readNumberField('1e3', 'X')).toBe('X isn’t a number');
    expect(readNumberField('-1', 'X')).toBe('X isn’t a number');
  });
  it('an optional field left blank takes its stated value', () => {
    expect(readNumberField('', 'Keep as cash', 0)).toBe(0);
    expect(readNumberField('..', 'Keep as cash', 0)).toBe('Keep as cash isn’t a number');
  });
  it('reads a form: every value, or the first problem and its field', () => {
    expect(readNumberFields({ a: ['1', 'A'], b: ['', 'B', 0] })).toEqual({ values: { a: 1, b: 0 } });
    expect(readNumberFields({ a: ['1', 'A'], b: ['2..', 'B'] })).toEqual({ error: 'B isn’t a number', field: 'b' });
  });
  it('a number too long to be finite is refused, not sent as null (review of PR #173)', () => {
    expect(readNumberField('9'.repeat(400), 'Most to pay to trade')).toBe('Most to pay to trade isn’t a number');
    expect(readNumberField('9'.repeat(300), 'X')).toBe(Number('9'.repeat(300)));
  });
  it('a decimal comma is read as a point, so “1,5” is 1.5, not 15', () => {
    expect(cleanNumberInput('1,5')).toBe('1.5');
    expect(readNumberField(cleanNumberInput('1,5'), 'X')).toBe(1.5);
    expect(cleanNumberInput('$1 000')).toBe('1000');
    expect(readNumberField(cleanNumberInput('1,000.5'), 'X')).toBe('X isn’t a number');
  });
});
