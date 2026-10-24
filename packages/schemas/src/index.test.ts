import { describe, expect, it } from 'vitest';
import { schemasPackageName } from './index.js';

describe('schemas package', () => {
  it('exposes its package name', () => {
    expect(schemasPackageName).toBe('@gis-vision/schemas');
  });
});
