// Quick local smoke test — not part of the deployed app.
// Spins up an HTTP server wrapping the handler, mocks Circle's API via a
// second local server, and posts both a link submission and an image
// submission through it to catch integration bugs before deploying.

const http = require('http');
const { once } = require('events');

process.env.CIRCLE_API_TOKEN = 'test-token';
process.env.CIRCLE_SPACE_ID = '2843717';

async function main() {
  // Mock Circle API
  let lastPostBody = null;
  const mockCircle = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/direct_uploads' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        signed_id: 'fake-signed-id',
        url: 'https://assets-v2.circle.so/fake-key',
        direct_upload: { url: `http://127.0.0.1:${mockS3Port}/upload`, headers: { 'Content-Type': 'image/png' } }
      }));
      return;
    }
    if (req.url === '/posts' && req.method === 'POST') {
      lastPostBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://app.agentbee.net/c/kudos-agent-submitted/test-post' }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => mockCircle.listen(0, r));
  const mockCirclePort = mockCircle.address().port;
  process.env.CIRCLE_API_BASE_URL = `http://127.0.0.1:${mockCirclePort}`;

  // Mock S3
  const mockS3 = http.createServer((req, res) => { res.writeHead(200); res.end(); });
  await new Promise(r => mockS3.listen(0, r));
  var mockS3Port = mockS3.address().port;

  // Now require the handler AFTER env vars are set (module reads them at load time)
  delete require.cache[require.resolve('../api/submit-kudos.js')];
  const handler = require('../api/submit-kudos.js');

  // Vercel's Node runtime adds res.status()/res.json() helpers on top of the
  // plain http.ServerResponse; shim them here so this local test matches
  // what the deployed function actually gets.
  function withVercelHelpers(res) {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
    return res;
  }

  const app = http.createServer((req, res) => handler(req, withVercelHelpers(res)));
  await new Promise(r => app.listen(0, r));
  const appPort = app.address().port;

  // --- Test 1: link submission ---
  {
    const body = buildMultipart({
      businessName: 'Test Agency Pty Ltd',
      awardLink: 'https://example.com/award-announcement',
      website: '',
      confirmNotRobot: 'yes'
    }, null);
    const result = await postMultipart(appPort, body.buffer, body.boundary);
    console.log('Link submission ->', result.status, result.json);
    if (result.status !== 200) throw new Error('Link submission failed');
    console.log('Post body sent to Circle:', JSON.stringify(lastPostBody, null, 2));
  }

  // --- Test 2: image submission ---
  {
    const fakeImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const body = buildMultipart({
      businessName: 'Image Test Agency',
      website: '',
      confirmNotRobot: 'yes'
    }, { fieldName: 'awardImage', filename: 'award.png', contentType: 'image/png', data: fakeImage });
    const result = await postMultipart(appPort, body.buffer, body.boundary);
    console.log('Image submission ->', result.status, result.json);
    if (result.status !== 200) throw new Error('Image submission failed');
    console.log('Post body sent to Circle:', JSON.stringify(lastPostBody, null, 2));
  }

  // --- Test 3: honeypot triggers silent rejection ---
  {
    const body = buildMultipart({
      businessName: 'Bot Agency',
      awardLink: 'https://example.com/spam',
      website: 'http://spam.example',
      confirmNotRobot: 'yes'
    }, null);
    const result = await postMultipart(appPort, body.buffer, body.boundary);
    console.log('Honeypot submission ->', result.status, result.json);
    if (result.status !== 200) throw new Error('Honeypot handling should still return 200');
  }

  // --- Test 4: missing business name is rejected ---
  {
    const body = buildMultipart({
      businessName: '',
      awardLink: 'https://example.com/award',
      website: '',
      confirmNotRobot: 'yes'
    }, null);
    const result = await postMultipart(appPort, body.buffer, body.boundary);
    console.log('Missing name ->', result.status, result.json);
    if (result.status !== 400) throw new Error('Expected 400 for missing business name');
  }

  console.log('\nAll smoke tests passed.');
  app.close(); mockCircle.close(); mockS3.close();
}

function buildMultipart(fields, file) {
  const boundary = '----smoketestboundary';
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  if (file) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`);
  }
  let buffer = Buffer.from(parts.join(''), 'utf8');
  if (file) {
    buffer = Buffer.concat([buffer, file.data, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
  } else {
    buffer = Buffer.concat([buffer, Buffer.from(`--${boundary}--\r\n`, 'utf8')]);
  }
  return { buffer, boundary };
}

function postMultipart(port, buffer, boundary) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/', method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': buffer.length
      }
    }, async (res) => {
      let raw = '';
      for await (const chunk of res) raw += chunk;
      let json; try { json = JSON.parse(raw); } catch { json = raw; }
      resolve({ status: res.statusCode, json });
    });
    req.on('error', reject);
    req.end(buffer);
  });
}

main().catch(err => { console.error('SMOKE TEST FAILED:', err); process.exit(1); });
