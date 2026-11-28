import { deepEqual, doesNotMatch, equal, match } from 'node:assert/strict';
import { test } from 'node:test';
import { describeComments } from '../../scenarios/lifecycle/analysis.ts';
import type { Comment } from '../../scenarios/lifecycle/analysis.ts';
import { isShapeKey, SHAPE_MARKER } from '../../scenarios/lifecycle/marks.ts';
import { shapeRewriteCommentChecks } from '../../scenarios/lifecycle/phase2-journeys.ts';

const EDITED = Date.parse('2026-11-26T10:00:00Z');
const RESHAPED = Date.parse('2026-11-26T10:30:00Z');

let next = 1;
const comment = (key: string | undefined, created: string, updated: string, text: string): Comment => {
  const id = next++;
  return {
    id,
    body: `${key ? `<!-- nibfin:${key} -->\n` : ''}${text}`,
    created_at: created,
    updated_at: updated,
    user: { login: 'nibfin' },
    html_url: `https://github.com/o/exec/issues/5#issuecomment-${id}`,
  };
};

const shape = comment('shape', '2026-11-26T09:00:00Z', '2026-11-26T10:20:00Z', 'Shape: quadruple the input');
const shapeWrong = comment(
  'shape-wrong',
  '2026-11-26T10:05:00Z',
  '2026-11-26T10:05:00Z',
  'The approved Shape is wrong (Writer).',
);

const checks = (comments: Comment[], until = RESHAPED) =>
  shapeRewriteCommentChecks(comments, EDITED, until).map((x) => ({ rule: x.rule, ok: x.ok }));

test('isShapeKey accepts only the exact Shape key, while SHAPE_MARKER keeps its loose match', () => {
  equal(isShapeKey('shape'), true);
  for (const key of ['shape-wrong', 'shape:x', 'shapes', '', undefined]) equal(isShapeKey(key), false, String(key));
  match('shape-wrong', SHAPE_MARKER);
});

test('a shape comment is the Shape comment and a shape-wrong comment is the reason', () => {
  deepEqual(checks([shape, shapeWrong, comment(undefined, '2026-11-26T10:06:00Z', '2026-11-26T10:06:00Z', 'hi')]), [
    { rule: 'R3.39', ok: true },
    { rule: 'R3.40', ok: true },
    { rule: 'R3.40', ok: true },
  ]);
});

test('a shape:x comment in the window counts as the reason, not as a Shape comment', () => {
  const colon = comment('shape:x', '2026-11-26T10:07:00Z', '2026-11-26T10:07:00Z', 'Sent back');
  deepEqual(checks([shape, colon], Infinity), [
    { rule: 'R3.39', ok: true },
    { rule: 'R3.40', ok: true },
    { rule: 'R3.40', ok: true },
  ]);
});

test('two shape comments fail R3.40 and name both with their times and URLs', () => {
  const second = comment('shape', '2026-11-26T10:10:00Z', '2026-11-26T10:12:00Z', 'Shape: quadruple again');
  const [reason, count, rewrite] = shapeRewriteCommentChecks([shape, shapeWrong, second], EDITED, RESHAPED);
  equal(reason.ok, true);
  equal(rewrite.ok, true);
  equal(count.rule, 'R3.40');
  equal(count.ok, false);
  match(count.problem, /^2 comments with the Shape key `shape`, expected the one rewritten; marked comments on P: read 3 comments/);
  for (const x of [shape, second]) {
    match(count.problem, new RegExp(`marker shape \\(created ${x.created_at}, updated ${x.updated_at}, ${x.html_url}\\)`));
  }
  match(count.problem, /marker shape-wrong \(created 2026-11-26T10:05:00Z/);
});

test('no reason in the window fails R3.39 and names the window and every marked comment read', () => {
  const before = comment('pending', '2026-11-26T08:00:00Z', '2026-11-26T08:30:00Z', 'Pending');
  const plain = comment(undefined, '2026-11-26T10:06:00Z', '2026-11-26T10:06:00Z', 'a human remark');
  const [reason, count] = shapeRewriteCommentChecks([shape, before, plain], EDITED, RESHAPED);
  equal(count.ok, true);
  equal(reason.rule, 'R3.39');
  equal(reason.ok, false);
  match(
    reason.problem,
    /^no marked comment between 2026-11-26T10:00:00.000Z and 2026-11-26T10:30:00.000Z gives the reason the Shape was sent back; marked comments on P: read 2 comments: /,
  );
  match(reason.problem, new RegExp(`marker shape \\(created ${shape.created_at}, updated ${shape.updated_at}, ${shape.html_url}\\)`));
  match(reason.problem, new RegExp(`marker pending \\(created ${before.created_at}, updated ${before.updated_at}, ${before.html_url}\\)`));
  doesNotMatch(reason.problem, /human remark/);
  match(shapeRewriteCommentChecks([shape], EDITED, Infinity)[0].problem, /and now gives the reason/);
});

test('a Shape comment not rewritten after the edit fails the R3.40 rewrite check', () => {
  const old = comment('shape', '2026-11-26T09:00:00Z', '2026-11-26T09:10:00Z', 'Shape: quadruple');
  const [, , rewrite] = shapeRewriteCommentChecks([old, shapeWrong], EDITED, RESHAPED);
  equal(rewrite.ok, false);
  match(rewrite.problem, /^the Shape comment was not rewritten for the edited Issue \(no `quadruple`\); marked comments on P: /);
});

test('describeComments without stamps keeps its output', () => {
  const x = comment('pending', '2026-11-26T08:00:00Z', '2026-11-26T08:00:00Z', 'Waiting for the Owner');
  equal(describeComments([x]), 'read 1 comment: #1 marker pending "Waiting for the Owner"');
});
