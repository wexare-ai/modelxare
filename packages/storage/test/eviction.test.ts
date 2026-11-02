import { describe, expect, it } from 'vitest';
import { planEviction, type SavedFile } from '../src/index.ts';

const MB = 1e6;
const file = (sha256: string, mb: number, lastUsed: number): SavedFile => ({ sha256, size: mb * MB, lastUsed });
const plenty = 100_000 * MB;

describe('planEviction', () => {
  it('removes nothing when the download fits', () => {
    const plan = planEviction({ files: [file('a', 300, 1), file('b', 300, 2)], needed: 300 * MB, limit: 1000 * MB, free: plenty });
    expect(plan).toEqual({ remove: [], freed: 0, ok: true });
  });

  it('removes the least recently used model first, and only as much as needed', () => {
    const files = [file('new', 300, 30), file('old', 300, 10), file('mid', 300, 20)];
    const plan = planEviction({ files, needed: 300 * MB, limit: 1000 * MB, free: plenty });
    expect(plan).toEqual({ remove: ['old'], freed: 300 * MB, ok: true });
  });

  it("removes a model's files together: they were last used at the same moment", () => {
    const files = [file('base', 70, 10), file('adapter', 5, 10), file('other', 300, 20)];
    const plan = planEviction({ files, needed: 50 * MB, limit: 400 * MB, free: plenty });
    expect(plan.remove.sort()).toEqual(['adapter', 'base']);
  });

  it('never removes kept files (the model about to run, the router in use)', () => {
    const files = [file('router', 900, 1), file('a', 300, 2)];
    const plan = planEviction({ files, needed: 400 * MB, limit: 1500 * MB, free: plenty, keep: new Set(['router']) });
    expect(plan.remove).toEqual(['a']);
  });

  it('removes files with no recorded use first', () => {
    const files = [file('recorded', 300, 5), file('unknown', 300, 0)];
    expect(planEviction({ files, needed: 300 * MB, limit: 700 * MB, free: plenty }).remove).toEqual(['unknown']);
  });

  it('lets a download larger than the limit through after removing everything else', () => {
    const files = [file('a', 100, 1), file('b', 100, 2)];
    const plan = planEviction({ files, needed: 900 * MB, limit: 500 * MB, free: plenty });
    expect(plan).toEqual({ remove: ['a', 'b'], freed: 200 * MB, ok: true });
  });

  it("makes room in the browser's space even when under the limit", () => {
    const files = [file('a', 300, 1), file('b', 300, 2)];
    const plan = planEviction({ files, needed: 300 * MB, limit: 4000 * MB, free: 100 * MB });
    expect(plan).toEqual({ remove: ['a'], freed: 300 * MB, ok: true });
  });

  it("removes nothing when the download won't fit in the browser's space anyway", () => {
    const files = [file('a', 300, 1), file('keep', 300, 2)];
    const plan = planEviction({ files, needed: 1000 * MB, limit: 4000 * MB, free: 100 * MB, keep: new Set(['keep']) });
    expect(plan).toEqual({ remove: [], freed: 0, ok: false });
  });

  it('trims to a lower limit when nothing is being downloaded', () => {
    const files = [file('a', 300, 1), file('b', 300, 2), file('c', 300, 3)];
    expect(planEviction({ files, needed: 0, limit: 650 * MB, free: plenty }).remove).toEqual(['a']);
  });
});
