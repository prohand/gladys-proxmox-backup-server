import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { after, test } from 'node:test';
import { ProxmoxClient, ProxmoxError } from '../src/proxmox.js';
import { TEST_CERT, TEST_FINGERPRINT, TEST_KEY } from './fixtures/tls.js';

// The client against REAL local servers: the failures it must survive (a
// connection cut mid-answer, a server that stalls, a certificate that is not
// the pinned one) only exist on the wire.

const servers = [];
after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

/** Start a server on an ephemeral port; `handler` gets every request. */
async function serve(handler, { secure = false } = {}) {
  const requests = [];
  const listener = (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    handler(req, res);
  };
  const server = secure
    ? https.createServer({ cert: TEST_CERT, key: TEST_KEY }, listener)
    : http.createServer(listener);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { requests, url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}` };
}

function client(baseUrl, extra = {}, options = {}) {
  return new ProxmoxClient(
    {
      base_url: baseUrl,
      api_token_id: 'gladys@pbs!monitoring',
      api_token_secret: 'secret-value',
      node: 'localhost',
      verify_tls: true,
      tls_fingerprint: '',
      ...extra,
    },
    options,
  );
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('a GET returns the data member and carries the token and the query', async () => {
  const { url, requests } = await serve((req, res) => json(res, 200, { data: [{ store: 'one' }] }));
  const tasks = await client(url).getTasks('one', { typefilter: 'prune', limit: 50 });
  assert.deepEqual(tasks, [{ store: 'one' }]);
  assert.equal(requests[0].method, 'GET');
  assert.equal(
    requests[0].url,
    '/api2/json/nodes/localhost/tasks?store=one&start=0&limit=50&typefilter=prune',
  );
  assert.equal(requests[0].authorization, 'PBSAPIToken=gladys@pbs!monitoring:secret-value');
});

test('a connection cut in the middle of the answer rejects instead of hanging', async () => {
  const { url } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    res.write('{"data": [');
    setTimeout(() => res.socket.destroy(), 20);
  });
  await assert.rejects(client(url, {}, { timeoutMs: 5000 }).getDatastores(), (error) => {
    assert.ok(error instanceof ProxmoxError);
    assert.equal(error.kind, 'network');
    assert.match(error.messages.fr, /interrompue/);
    return true;
  });
});

test('a server that stalls mid-answer fails on the total deadline', async () => {
  const { url } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Trickle bytes forever: an idle-socket timeout alone would never fire.
    const timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  await assert.rejects(client(url, {}, { timeoutMs: 300 }).getDatastores(), { kind: 'timeout' });
  assert.ok(Date.now() - started < 2000);
});

test('a server that never answers fails on the deadline too', async () => {
  const { url } = await serve(() => {});
  await assert.rejects(client(url, {}, { timeoutMs: 200 }).getDatastores(), { kind: 'timeout' });
});

test('401 and 403 are told apart, with a bilingual message naming the fix', async () => {
  const { url } = await serve((req, res) =>
    json(res, req.url.includes('groups') ? 403 : 401, { data: null }),
  );
  await assert.rejects(client(url).getDatastores(), (error) => {
    assert.equal(error.kind, 'auth');
    assert.equal(error.status, 401);
    assert.match(error.messages.en, /token/);
    assert.match(error.messages.fr, /jeton/);
    return true;
  });
  await assert.rejects(client(url).getGroups('one'), (error) => {
    assert.equal(error.kind, 'permission');
    assert.equal(error.status, 403);
    assert.match(error.messages.en, /DatastoreAudit/);
    return true;
  });
});

test('other statuses, invalid JSON and oversized answers are typed errors', async () => {
  const { url } = await serve((req, res) => {
    if (req.url.includes('groups')) return json(res, 404, { errors: 'no such route' });
    if (req.url.includes('snapshots')) return res.end('<html>');
    res.end('x'.repeat(2048));
  });
  await assert.rejects(client(url).getGroups('one'), { kind: 'http', status: 404 });
  await assert.rejects(client(url).getSnapshots('one'), { kind: 'parse' });
  await assert.rejects(client(url, {}, { maxResponseBytes: 1024 }).getDatastores(), {
    kind: 'http',
  });
});

test('a refused connection is a network error', async () => {
  const { url } = await serve(() => {});
  const closed = servers.at(-1);
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(client(url).getDatastores(), (error) => {
    assert.equal(error.kind, 'network');
    assert.match(error.messages.en, /ECONNREFUSED/);
    return true;
  });
});

test('a self-signed certificate is refused unless pinned or verification is off', async () => {
  const { url, requests } = await serve((req, res) => json(res, 200, { data: [] }), {
    secure: true,
  });
  await assert.rejects(client(url).getDatastores(), (error) => {
    assert.equal(error.kind, 'tls');
    assert.match(error.messages.en, /fingerprint/);
    return true;
  });
  assert.equal(requests.length, 0);

  assert.deepEqual(await client(url, { tls_fingerprint: TEST_FINGERPRINT }).getDatastores(), []);
  // Pasted without separators, in lower case: same certificate.
  const bare = TEST_FINGERPRINT.replace(/:/g, '').toLowerCase();
  assert.deepEqual(await client(url, { tls_fingerprint: bare }).getDatastores(), []);
  assert.deepEqual(await client(url, { verify_tls: false }).getDatastores(), []);
});

test('a certificate that is not the pinned one never receives the token', async () => {
  const { url, requests } = await serve((req, res) => json(res, 200, { data: [] }), {
    secure: true,
  });
  const wrong = 'AB'.repeat(32);
  // Even with verification off: the pin wins.
  await assert.rejects(
    client(url, { tls_fingerprint: wrong, verify_tls: false }).getDatastores(),
    (error) => {
      assert.equal(error.kind, 'tls');
      assert.match(error.messages.en, /pinned fingerprint/);
      assert.match(error.messages.fr, /empreinte épinglée/);
      return true;
    },
  );
  assert.equal(requests.length, 0);
});

test('a pinned fingerprint refuses http:// and a value that is not SHA-256', async () => {
  const { url, requests } = await serve((req, res) => json(res, 200, { data: [] }));
  await assert.rejects(client(url, { tls_fingerprint: TEST_FINGERPRINT }).getDatastores(), {
    kind: 'config',
  });
  const secure = await serve((req, res) => json(res, 200, { data: [] }), { secure: true });
  await assert.rejects(client(secure.url, { tls_fingerprint: 'AA:BB' }).getDatastores(), {
    kind: 'config',
  });
  assert.equal(requests.length + secure.requests.length, 0);
});

test('an incomplete configuration is reported without any request', async () => {
  await assert.rejects(new ProxmoxClient({ base_url: '' }).getDatastores(), (error) => {
    assert.equal(error.kind, 'config');
    assert.ok(error.messages.en && error.messages.fr);
    return true;
  });
});
