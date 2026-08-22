// src/agent/models-client.js 的网络层最小自检：真起一个本地 http 假服务器
// 返回 OpenAI 兼容 /models 格式,验证解析正确;并覆盖超时/大小上限/上游
// 401/404/其它错误/畸形 JSON/无法识别的形状。这里刻意不经过
// src/agent/config.js 的 validateBaseURL()(SSRF 拦截)——fetchProviderModels()
// 本身不做那层校验,由调用方(src/routes/agent.js)负责,见该模块顶部注释。
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchProviderModels, modelsErrorToHttpStatus } from '../src/agent/models-client.js';

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
  console.log('  [1/12] 标准 OpenAI {data:[...]} 格式解析：ok');
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
  console.log('  [2/12] 裸数组格式（含纯字符串 id）解析：ok');
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
  console.log('  [3/12] 上游 401：ok（错误消息不透传上游原始响应体）');
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
  console.log('  [4/12] 上游 404：ok');
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
  console.log('  [5/12] 上游 500：ok（error.status 保留原始状态码）');
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
  console.log('  [6/12] 畸形 JSON：ok');
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
  console.log('  [7/12] 无法识别的响应形状：ok');
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
  console.log('  [8/12] 响应体过大（maxBytes 中途掐断）：ok');
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
  console.log('  [9/12] 超时（AbortController 真的生效）：ok');
}

// ---- 10) 连接被拒（端口未监听）→ code:network_error ----
{
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'http://127.0.0.1:1', apiKey: 'sk-x' }),
    (error) => { assert.equal(error.code, 'network_error'); return true; }
  );
  console.log('  [10/12] 连接被拒：ok（network_error，不是抛出未分类的原始异常）');
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
  console.log('  [11/12] 3xx 重定向被拒绝且未跟随：ok（upstream_redirect_blocked，重定向目标零命中）');
}

// ---- 12) 【2026-08-23 UX 缺陷修复回归，编排方人工验收发现】
//      modelsErrorToHttpStatus() 的 code → HTTP 状态码映射表本身：
//      upstream_unauthorized（上游供应商说 key 无效/无权限）绝不能映射到
//      401——public/js/api.js 的全局 fetch 封装把任何 401 一律当成"anqi
//      会话过期"直接跳登录页，此前这里映射到 401 导致用户在设置页填错一
//      个字符的 API Key、点「拉取可用模型」就被踢回登录页，永远看不到
//      写好的中文提示（本次要修的原始缺陷，详见
//      src/agent/models-client.js 的 modelsErrorToHttpStatus() 顶部注释表）。
//      这里直接测这个纯函数，不需要真实网络/HTTP 服务器。 ----
{
  assert.equal(modelsErrorToHttpStatus('upstream_unauthorized'), 502, 'upstream_unauthorized 必须映射到非 401 的状态码（本次选 502，理由见函数注释）');
  assert.notEqual(modelsErrorToHttpStatus('upstream_unauthorized'), 401, '核心回归：上游认证失败绝不能让本端点也回 401，否则会被前端全局 401 拦截误判为 anqi 会话过期');
  assert.equal(modelsErrorToHttpStatus('upstream_not_found'), 404);
  assert.equal(modelsErrorToHttpStatus('upstream_redirect_blocked'), 502);
  assert.equal(modelsErrorToHttpStatus('upstream_error'), 502);
  assert.equal(modelsErrorToHttpStatus('timeout'), 504);
  assert.equal(modelsErrorToHttpStatus('network_error'), 504);
  assert.equal(modelsErrorToHttpStatus('unrecognized_code_should_never_happen'), 502, '未识别 code 的防御性兜底也不能是 401');
  console.log('  [12/12] modelsErrorToHttpStatus() 映射表：upstream_unauthorized→502（非 401）+ 其余 code 映射不变：ok');
}

console.log('agent models-client 自检全部通过');
