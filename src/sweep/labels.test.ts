import { describe, expect, it } from 'vitest';
import { planLabelSync } from './labels.js';
import { LABEL_DEFINITIONS, RENAMED_LABELS } from './render.js';

/**
 * The label list is the owner's view of every ticket, and colour is what separates a kind from a
 * status. These pin that a repo on the old names is moved without losing a label from an issue.
 */
describe('planLabelSync', () => {
  const def = (name: string) => LABEL_DEFINITIONS.find((d) => d.name === name)!;

  it('renames a retired label in place, with the new colour', () => {
    const { ops } = planLabelSync([
      { name: 'code-reviewer', color: '5319e7', description: 'old' },
      { name: 'quality: security', color: '0e8a16', description: 'old' },
    ]);
    expect(ops).toContainEqual({ op: 'rename', from: 'code-reviewer', ...renamed('concern') });
    expect(ops).toContainEqual({ op: 'rename', from: 'quality: security', ...renamed('security') });
    expect(ops.filter((o) => o.op === 'create' && (o.name === 'concern' || o.name === 'security'))).toEqual([]);

    function renamed(to: string) {
      return { to, color: def(to).color, description: def(to).description };
    }
  });

  it('recolours a label that exists under the right name, and leaves a correct one alone', () => {
    const { ops } = planLabelSync([
      { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
      { name: 'wontfix', color: 'FFFFFF', description: def('wontfix').description },
    ]);
    expect(ops).toContainEqual({ op: 'update', ...def('bug') });
    expect(ops.some((o) => 'name' in o && o.name === 'wontfix')).toBe(false);
  });

  it('does not rename onto a label that already exists', () => {
    const { ops, leftBehind } = planLabelSync([
      { name: 'enhancement', color: 'a2eeef', description: '' },
      { name: 'spec', color: def('spec').color, description: def('spec').description },
    ]);
    expect(leftBehind).toEqual(['enhancement']);
    expect(ops.some((o) => o.op === 'rename')).toBe(false);
  });

  it('is a no-op on a repo already on the scheme, and never touches labels outside it', () => {
    const onScheme = [...LABEL_DEFINITIONS, { name: 'accessibility', color: 'f143ab', description: 'x' }];
    expect(planLabelSync(onScheme)).toEqual({ ops: [], leftBehind: [] });
  });

  it('gives every retired name a replacement that is defined', () => {
    for (const r of RENAMED_LABELS) expect(def(r.to), r.from).toBeDefined();
  });
});
