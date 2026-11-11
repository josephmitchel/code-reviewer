import { ensureLabel, listLabels, updateLabel, type RepoLabel } from '../github.js';
import { LABEL_DEFINITIONS, RENAMED_LABELS } from './render.js';

/**
 * The repo's label list, brought in line with the scheme in `render.ts`. Colour is what tells a
 * kind from a status from a level, so a label that exists under the right name but the wrong
 * colour is wrong; the sweep and the merge job both run this before they label anything.
 */

export type LabelOp =
  | { op: 'rename'; from: string; to: string; color: string; description: string }
  | { op: 'create'; name: string; color: string; description: string }
  | { op: 'update'; name: string; color: string; description: string };

/**
 * Pure: what has to change. A retired name is renamed in place, so it stays on its issues; when the
 * new name already exists too, the old label is left for a person to merge (GitHub cannot merge
 * two labels) and the new one is still brought up to date.
 */
export function planLabelSync(
  existing: RepoLabel[],
  definitions: Array<{ name: string; color: string; description: string }> = LABEL_DEFINITIONS,
  renames: Array<{ from: string; to: string }> = RENAMED_LABELS,
): { ops: LabelOp[]; leftBehind: string[] } {
  // GitHub label names are case-insensitive.
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
  const ops: LabelOp[] = [];
  const leftBehind: string[] = [];
  const renamedTo = new Set<string>();
  for (const r of renames) {
    const from = byName.get(r.from.toLowerCase());
    if (!from) continue;
    if (byName.has(r.to.toLowerCase())) {
      leftBehind.push(from.name);
      continue;
    }
    const def = definitions.find((d) => d.name === r.to);
    if (!def) continue;
    ops.push({ op: 'rename', from: from.name, to: def.name, color: def.color, description: def.description });
    renamedTo.add(def.name);
  }
  for (const def of definitions) {
    if (renamedTo.has(def.name)) continue;
    const have = byName.get(def.name.toLowerCase());
    if (!have) ops.push({ op: 'create', ...def });
    else if (have.color.toLowerCase() !== def.color.toLowerCase() || have.description !== def.description) {
      ops.push({ op: 'update', ...def });
    }
  }
  return { ops, leftBehind };
}

/** Apply the plan. Returns what it did, for the log and the `labels` command. */
export async function syncLabels(repoSlug: string): Promise<{ ops: LabelOp[]; leftBehind: string[] }> {
  const plan = planLabelSync(await listLabels(repoSlug));
  for (const o of plan.ops) {
    if (o.op === 'rename') {
      await updateLabel(repoSlug, o.from, { newName: o.to, color: o.color, description: o.description });
      console.log(`  label "${o.from}" renamed to "${o.to}"`);
    } else if (o.op === 'create') {
      await ensureLabel(repoSlug, o);
      console.log(`  label "${o.name}" created`);
    } else {
      await updateLabel(repoSlug, o.name, { color: o.color, description: o.description });
      console.log(`  label "${o.name}" recoloured`);
    }
  }
  for (const name of plan.leftBehind) {
    console.warn(`  label "${name}" is retired but its replacement already exists — merge it by hand`);
  }
  return plan;
}
