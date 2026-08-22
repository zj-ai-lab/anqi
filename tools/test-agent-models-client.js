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
  console.log('  [1/13] 标准 OpenAI {data:[...]} 格式解析：ok');
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
  console.log('  [2/13] 裸数组格式（含纯字符串 id）解析：ok');
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
  console.log('  [3/13] 上游 401：ok（错误消息不透传上游原始响应体）');
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
  console.log('  [4/13] 上游 404：ok');
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
  console.log('  [5/13] 上游 500：ok（error.status 保留原始状态码）');
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
  console.log('  [6/13] 畸形 JSON：ok');
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
  console.log('  [7/13] 无法识别的响应形状：ok');
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
  console.log('  [8/13] 响应体过大（maxBytes 中途掐断）：ok');
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
  console.log('  [9/13] 超时（AbortController 真的生效）：ok');
}

// ---- 10) 连接被拒（端口未监听）→ code:network_error ----
{
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'http://127.0.0.1:1', apiKey: 'sk-x' }),
    (error) => { assert.equal(error.code, 'network_error'); return true; }
  );
  console.log('  [10/13] 连接被拒：ok（network_error，不是抛出未分类的原始异常）');
}

// ---- 11) 【红线回归】3xx 重定向绝不自动跟随 → code:upstream_redirect_blocked，
//      且重定向目标（内网 stand-in 服务器）从未被真正打到——之前用默认
//      redirect:'follow'，一个已通过 validateBaseURL() 校验的 baseURL 可以用
//      302 把请求带到调用方从未审过的第二个地址（探针实测内网服务被真实打到，
//      响应体被当成模型列表原样返回）。 ----
{
  let internalHit = false;
  const { server: internalServer, baseURL: internalBaseURL } = await startServer((req, res) => {
    internalHit = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'INTERNAL-SECRET-MODEL' }] }));
  });
  const { server, baseURL } = await startServer((req, res) => {
    res.writeHead(302, { Location: `${internalBaseURL}/internal-target` });
    res.end();
  });
  await assert.rejects(
    () => fetchProviderModels({ baseURL, apiKey: 'sk-x' }),
    (error) => { assert.equal(error.code, 'upstream_redirect_blocked'); assert.equal(error.status, 302); return true; }
  );
  assert.equal(internalHit, false, '3xx 重定向目标绝不应该被真正请求到');
  await closeServer(server);
  await closeServer(internalServer);
  console.log('  [11/13] 3xx 重定向被拒绝且未跟随：ok（upstream_redirect_blocked，重定向目标零命中）');
}

// ---- 12) 【红线回归，2026-08-23 复审新增】pinnedAddress 机制本身：TCP 连接
//      必须打到 pinnedAddress（不再触发第二次 DNS 解析），但 Host 请求头与
//      TLS SNI 必须仍然是原始 hostname——用一个真实不解析的 hostname
//      （.invalid 顶级域，RFC 2606 保留、保证任何 resolver 都查不到）搭配
//      pinnedAddress='127.0.0.1' 证明：(a) 请求依然成功（说明真的没有再解析
//      这个 hostname，否则会直接 ENOTFOUND），(b) 服务端收到的 Host 头是原
//      始 hostname 而不是被替换成 IP。 ----
{
  let receivedHost = null;
  const { server, baseURL: realBaseURL } = await startServer((req, res) => {
    receivedHost = req.headers.host;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'pinned-model' }] }));
  });
  const port = new URL(realBaseURL).port;
  const bogusBaseURL = `http://anqi-agent-pin-test.invalid:${port}`;
  const result = await fetchProviderModels({ baseURL: bogusBaseURL, apiKey: 'sk-pin', pinnedAddress: '127.0.0.1' });
  assert.deepEqual(result.models, ['pinned-model']);
  assert.equal(receivedHost, `anqi-agent-pin-test.invalid:${port}`, 'Host 头必须保留原始 hostname，不能被替换成 pinnedAddress');
  await closeServer(server);
  console.log('  [12/13] pinnedAddress：实际连接打到钉住的 IP，Host 头仍是原始 hostname：ok');
}

// ---- 13) 同一个不可解析的 hostname，省略 pinnedAddress 时必须真的走一次
//      DNS 解析并失败（network_error）——反证上一条测试里"请求成功"确实是
//      pinnedAddress 生效的结果，不是这个 hostname 碰巧能被解析。 ----
{
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'http://anqi-agent-pin-test.invalid:1', apiKey: 'sk-pin' }),
    (error) => { assert.equal(error.code, 'network_error'); return true; }
  );
  console.log('  [13/13] 省略 pinnedAddress 时该 hostname 无法解析（network_error）：ok（反证上一条测试的连接目标确实是 pinnedAddress）');
}

console.log('agent models-client 自检全部通过');
