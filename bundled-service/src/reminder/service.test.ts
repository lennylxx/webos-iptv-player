import { describe, expect, it } from 'vitest';
import { localizedAlertCopy } from './service';

describe('localizedAlertCopy', () => {
  it('keeps callbacks without a copy version on the legacy English path', () => {
    expect(localizedAlertCopy({ title: 'Alpha' })).toBeUndefined();
  });

  it('accepts complete versioned copy', () => {
    expect(localizedAlertCopy({
      copyVersion: 1,
      alertTitle: 'Title l1',
      alertMessage: 'Message l1',
      watchLabel: 'Watch l1',
      cancelLabel: 'Cancel l1',
    })).toEqual({
      title: 'Title l1',
      message: 'Message l1',
      watchLabel: 'Watch l1',
      cancelLabel: 'Cancel l1',
    });
  });

  it('rejects incomplete or unknown versioned copy', () => {
    expect(localizedAlertCopy({ copyVersion: 1, alertTitle: 'Title l1' })).toBeNull();
    expect(localizedAlertCopy({ copyVersion: 2 })).toBeNull();
  });
});
