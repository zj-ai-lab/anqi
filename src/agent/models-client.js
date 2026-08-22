// POST /api/agent/models 的网络层实现（设计稿 §4）：对外发一次 GET
// {baseURL}/models（Bearer 认证），解析 OpenAI 兼容格式，返回模型 id 列表。
//
// 本模块不做 baseURL 安全校验（协议/credential-free/内网回环拦截/官方域钉
// 死）——那是调用方（src/routes/agent.js）在拿到这里之前就该做完的事（复用
// src/agent/config.js 的 validateBaseURL()，与保存设置时同一套规则）。这样
// 拆开有两个好处：
//   1) 网络请求/解析/超时/大小上限这几件事本身可以脱离"必须是一个已通过
//      SSRF 校验的 baseURL"这个前提单独做单元测试——tools/test-agent-models-
//      client.js 直接对 127.0.0.1 起一个本地假 /models 服务器验证解析正确
//      性，不需要也不应该为了测试而放松真正的 SSRF 拦截。
//   2) 路由层可以单独测试"输入校验/apiKey 取值优先级/错误映射"这条链，
//      用注入的假 fetchModels 代替真实网络调用（同 supervisor.js 的
//      spawnFn 注入模式），不必每次跑真实网络请求。
//
// 红线：本模块任何一条抛出的错误里都不含 apiKey 本身——apiKey 只出现在
// 发出去的 Authorization 请求头里，从未进入过任何字符串拼接/模板/错误消
// 息。上游响应体也不会被原样透传给调用方之外的任何地方（模块顶层的
// extractModelIds() 只挑 id 字段）。
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2MB，模型列表正常不会接近这个量级
const MODELS_PATH_SUFFIX = '/models';

// 统一的错误形状：Error 实例 + .code（机器可读，供路由层做 HTTP 状态码映
// 射）+ 可选 .status（上游原始 HTTP 状态码）。message 只给人类看的中文提
// 示，同样绝不含 apiKey 或上游原始响应体。
function modelsError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// 手动读取响应体并在中途按字节数掐断，而不是先整体读完再检查长度——
// Content-Length 头本身可以被上游伪造成一个很小的值，真实 body 却是任意
// 大；只有在真正读流的过程中逐块累计字节数才靠得住。
async function readBodyWithCap(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    // 极少数环境下 response.body 不是 ReadableStream（理论上 undici 的
    // fetch 实现总有它），退化到 arrayBuffer() 兜底，仍然事后检查一次大小。
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw modelsError('response_too_large', '模型服务返回内容过大，已中止');
    return buf.toString('utf8');
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw modelsError('response_too_large', '模型服务返回内容过大，已中止');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// 解析 OpenAI 兼容的 /models 响应体，容忍两种常见形状：
//   { object: 'list', data: [{ id, ... }, ...] }（标准 OpenAI 格式）
//   [{ id, ... }, ...] 或 ['id', ...]（个别第三方网关直接返回数组）
// 只取每个条目的 id 字段（字符串），其余字段（created/owned_by 等）不透
// 出——前端下拉框只需要模型名。
function extractModelIds(parsedBody) {
  const list = Array.isArray(parsedBody) ? parsedBody : Array.isArray(parsedBody?.data) ? parsedBody.data : null;
  if (!list) return null;
  const ids = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

// 主入口：baseURL 必须是调用方已经校验过的、去掉尾部斜杠的绝对 URL
// （validateBaseURL() 的 normalized 值）。fetchImpl 默认全局 fetch，测试可
// 以传入其它 fetch 兼容实现（目前测试直接用真实 http 服务器 + 真实
// fetch，不需要替换这个参数，但保留注入点与仓库其它地方的依赖注入风格一
// 致，也方便将来需要 mock 网络层时使用）。
export async function fetchProviderModels({
  baseURL,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = fetch,
}) {
  const modelsURL = `${baseURL}${MODELS_PATH_SUFFIX}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(modelsURL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    // 网络层失败（DNS/连接被拒/超时中止）统一归到 network_error/timeout——
    // 不把底层 fetch/undici 的原始错误消息透给调用方（可能携带内部路径/
    // 系统层细节），也绝不可能包含 apiKey（它只在 header 里，从没进过任何
    // 字符串拼接）。
    if (error?.name === 'AbortError') {
      throw modelsError('timeout', '连接模型服务超时，请检查网络与 baseURL');
    }
    throw modelsError('network_error', '连接模型服务失败，请检查网络与 baseURL');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw modelsError('upstream_unauthorized', 'API Key 无效或无权限，请检查后重试', { status: response.status });
    }
    if (response.status === 404) {
      throw modelsError('upstream_not_found', '该地址未提供 /models 接口（404），请检查 baseURL', { status: response.status });
    }
    throw modelsError('upstream_error', `模型服务返回错误（HTTP ${response.status}）`, { status: response.status });
  }

  const rawText = await readBodyWithCap(response, maxBytes);

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    throw modelsError('invalid_upstream_json', '模型服务返回内容不是合法 JSON');
  }

  const models = extractModelIds(parsedBody);
  if (!models) {
    throw modelsError('unrecognized_upstream_shape', '模型服务返回格式无法识别（既不是 {data:[...]} 也不是数组）');
  }
  return { models };
}

// 路由层的错误 → HTTP 状态码映射，与 fetchProviderModels() 抛出的 .code
// 一一对应；未识别的 code 一律 502（防御性兜底，不应该真的走到）。
export function modelsErrorToHttpStatus(code) {
  switch (code) {
    case 'upstream_unauthorized': return 401;
    case 'upstream_not_found': return 404;
    case 'timeout':
    case 'network_error': return 504;
    default: return 502;
  }
}
