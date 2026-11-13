import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { parseMigrationEventCursor } from './migrations.controller.js';

describe('migration event cursor', () => {
  it('starts at zero and resumes from the newest query or EventSource cursor', () => {
    expect(parseMigrationEventCursor(undefined, undefined)).toBe(0);
    expect(parseMigrationEventCursor('7', undefined)).toBe(7);
    expect(parseMigrationEventCursor('7', '12')).toBe(12);
    expect(parseMigrationEventCursor('15', '12')).toBe(15);
  });

  it.each(['-1', '01', '1.5', 'abc', '2147483648'])(
    'rejects malformed or unsupported cursor %s',
    (cursor) => {
      expect(() => parseMigrationEventCursor(cursor, undefined)).toThrow(BadRequestException);
    },
  );
});
