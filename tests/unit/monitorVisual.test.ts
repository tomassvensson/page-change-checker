import { expect, it } from 'vitest';

import { maskSignature } from '../../src/monitor/visual.js';

it('ignores cosmetic header repaint but preserves a real row change without changing original evidence', () => {
  const original = Buffer.alloc(4 * 4 * 3, 255),
    repaint = Buffer.from(original),
    row = Buffer.from(original);
  repaint.fill(0, 0, 12);
  row.fill(0, 24, 36);
  const signature = (pixels: Buffer) => ({
    width: 4,
    height: 4,
    pixels: pixels.toString('base64')
  });
  const regions = [{ x: 0, y: 0, width: 1, height: 0.25 }];
  expect(maskSignature(signature(original), regions)).toEqual(
    maskSignature(signature(repaint), regions)
  );
  expect(maskSignature(signature(original), regions)).not.toEqual(
    maskSignature(signature(row), regions)
  );
  expect(original.every((value) => value === 255)).toBe(true);
  expect(maskSignature(signature(original), [])).toEqual(signature(original));
  expect(() => maskSignature({ ...signature(original), width: 5 }, regions)).toThrow('dimensions');
  expect(() => maskSignature(signature(original), [{ x: 1, y: 0, width: 1, height: 1 }])).toThrow(
    'region'
  );
});
