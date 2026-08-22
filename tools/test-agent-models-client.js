// src/agent/models-client.js 的网络层最小自检：真起一个本地 http 假服务器
// 返回 OpenAI 兼容 /models 格式,验证解析正确;并覆盖超时/大小上限/上游
// 401/404/其它错误/畸形 JSON/无法识别的形状。这里刻意不经过
// src/agent/config.js 的 validateBaseURL()(SSRF 拦截)——fetchProviderModels()
// 本身不做那层校验,由调用方(src/routes/agent.js)负责,见该模块顶部注释。
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchProviderModels } from '../src/agent/models-client.js';

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseURL: `http://127.0.0.1:${port}` };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---- 1) 标准 OpenAI 格式 {object:'list', data:[{id,...}]} ----
{
  let receivedAuth = null;
  const { server, baseURL } = await startServer((req, res) => {
    receivedAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-reasoner' }] }));
  });
  const result = await fetchProviderModels({ baseURL, apiKey: 'sk-test-key-abc' });
  assert.deepEqual(result.models, ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal(receivedAuth, 'Bearer sk-test-key-abc', 'apiKey 必须以 Bearer 头发出');
  await closeServer(server);
  console.log('  [1/9] 标准 OpenAI {data:[...]} 格式解析：ok');
}

// ---- 2) 裸数组格式（个别第三方网关不套 data 壳） ----
{
  const { server, baseURL } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'gpt-4o-mini' }, 'plain-string-id']));
  });
  const result = await fetchProviderModels({ baseURL, apiKey: 'sk-x' });
  assert.deepEqual(result.models, ['gpt-4o-mini', 'plain-string-id']);
  await closeServer(server);
  console.log('  [2/9] 裸数组格式（含纯字符串 id）解析：ok');
}

// ---- 3) 上游 401 → code:upstream_unauthorized ----
{
  const { server, baseURL } = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid api key: sk-x' })); // 上游回显的错误体本身可能含 key 片段
  });
  await assert.rejects(
    () => fetchProviderModels({ baseURL, apiKey: 'sk-x' }),
    (error) => {
      assert.equal(error.code, 'upstream_unauthorized');
      assert.doesNotMatch(error.message, /sk-x/, '错误消息不能把上游原始响应体（可能含 key 片段）透传出去');
      return true;
    }
  );
  await closeServer(server);
  console.log('  [3/9] 上游 401：ok（错误消息不透传上游原始响应体）');
}

// ---- 4) 上游 404 → code:upstream_not_found ----
{
  const { server, baseURL } = await startServer((req, res) => {
    res.writeHead(404);
    res.end('not found');
  });
  await assert.rejects(
    () => fetchProviderModels({ baseURL, apiKey: 'sk-x' }),
    (error) => { assert.equal(error.code, 'upstream_not_found'); return true; }
  );
  await closeServer(server);
  console.log('  [4/9] 上游 404：ok');
}

// ---- 5) 上游其它非 2xx（如 500）→ code:upstream_error ----
{
  const { server, baseURL } = await startServer((req, res) => {
    res.writeHead(500);
    res.end('internal error');
  });
  await assert.rejects(
    () => fetchProviderModels({ baseURL, apiKey: 'sk-x' }),
    (error) => { assert.equal(error.code, 'upstream_error'); assert.equal(error.status, 500); return true; }
  );
  await closeServer(server);
  console.log('  [5/9] 上游 500：ok（error.status 保留原始状态码）');
}

// ---- 6) 畸形 JSON → code:invalid_upstream_json ----
{
  const { server, baseURL } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{not valid json');
  });
  await assert.rejects(
    () => fetchProviderModels({ baseURL, apiKey: 'sk-x' }),
    (error) => { assert.equal(error.code, 'invalid_upstream_json'); return true; }
  );
  await closeServer(server);
  console.log('  [6/9] 畸形 JSON：ok');
}

// ---- 7) 无法识别的形状（既不是数组也没有 data 字段）→ code:unrecognized_upstream_shape ----
{
  const { server, baseURL } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await assert.rejects(
    () => fetchProviderModels({ baseURL, apiKey: 'sk-x' }),
    (error) => { assert.equal(error.code, 'unrecognized_upstream_shape'); return true; }
  );
  await closeServer(server);
  console.log('  [7/9] 无法识别的响应形状：ok');
}

// ---- 8) 响应体过大 → code:response_too_large（用很小的 maxBytes 逼近，不
//      需要真的传几 MB 数据） ----
{
  const { server, baseURL } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `model-${i}` })) }));
  });
  await assert.rejects(
    () => fetchProviderModels({ baseURL, apiKey: 'sk-x', maxBytes: 64 }),
    (error) => { assert.equal(error.code, 'response_too_large'); return true; }
  );
  await closeServer(server);
  console.log('  [8/9] 响应体过大（maxBytes 中途掐断）：ok');
}

// ---- 9) 超时 → code:timeout（用很小的 timeoutMs 逼近，服务器故意拖慢响应） ----
{
  const { server, baseURL } = await startServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    }, 500); // 远大于下面传的 timeoutMs
  });
  await assert.rejects(
    () => fetchProviderModels({ baseURL, apiKey: 'sk-x', timeoutMs: 30 }),
    (error) => { assert.equal(error.code, 'timeout'); return true; }
  );
  await closeServer(server);
  console.log('  [9/9] 超时（AbortController 真的生效）：ok');
}

// ---- 10) 连接被拒（端口未监听）→ code:network_error ----
{
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'http://127.0.0.1:1', apiKey: 'sk-x' }),
    (error) => { assert.equal(error.code, 'network_error'); return true; }
  );
  console.log('  [10/10] 连接被拒：ok（network_error，不是抛出未分类的原始异常）');
}

console.log('agent models-client 自检全部通过');
