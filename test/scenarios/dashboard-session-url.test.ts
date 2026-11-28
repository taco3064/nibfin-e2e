import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { sessionAddress } from '../../scenarios/management/dashboard.ts';

const local = { host: '127.0.0.1', port: 43210, origin: 'http://127.0.0.1:43210', proof: 'abc' };

test('session URL: the current two-line output is read', () => {
  deepEqual(
    sessionAddress('Dashboard session URL (works once; Ctrl-C stops the server):\nhttp://127.0.0.1:43210/#proof=abc\n'),
    local,
  );
});

test('session URL: the older "Dashboard: " form is read', () => {
  deepEqual(sessionAddress('Dashboard: http://127.0.0.1:43210/#proof=abc\n'), local);
});

test('session URL: another host is reported as printed, without the proof in the origin', () => {
  deepEqual(sessionAddress('http://0.0.0.0:43210/#proof=abc'), {
    ...local,
    host: '0.0.0.0',
    origin: 'http://0.0.0.0:43210',
  });
  equal(sessionAddress('Dashboard at http://[::1]:43210/#proof=abc')?.origin, 'http://[::1]:43210');
});

test('session URL: only a URL with a proof in its fragment is taken', () => {
  equal(sessionAddress('http://127.0.0.1:1/'), undefined);
  equal(sessionAddress('http://127.0.0.1:43210/?proof=abc'), undefined);
  equal(sessionAddress('http://127.0.0.1:43210/?proof=abc#x'), undefined);
  deepEqual(
    sessionAddress('listening on http://127.0.0.1:1/\nDashboard session URL:\nhttp://127.0.0.1:43210/#proof=abc'),
    local,
  );
  deepEqual(sessionAddress('http://127.0.0.1:43210/#a=1&proof=abc'), local);
});
