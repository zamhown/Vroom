import { describe, expect, it } from 'vitest';
import { hasSlotContent } from './slot-content';

describe('compact slot content', () => {
  it('omits missing and empty summary values without suppressing false or zero', () => {
    for (const value of [undefined, null, '', '  ', []]) expect(hasSlotContent(value)).toBe(false);
    for (const value of [false, 0, '0', { term: 'unfamiliar-option' }, [{ term: 'another-option' }]])
      expect(hasSlotContent(value)).toBe(true);
  });
  it('retains unset editable actions and deliberately configured empty copy', () => {
    expect(hasSlotContent(undefined, true)).toBe(true);
    expect(hasSlotContent(null, false, 'Not classified')).toBe(true);
    expect(hasSlotContent(undefined, false, ' ')).toBe(false);
  });
});
