// POST /api/agent/models 的网络层实现（设计稿 §4）：对外发一次 GET
// {baseURL}/models（Bearer 认证），解析 OpenAI 兼容格式，返回模型 id 列表。
//
// 本模块自己不做"baseURL 字符串层面是否合法"的校验（协议/credential-free/
// 内网回环字符串黑名单/官方域钉死）——那是调用方（src/routes/agent.js）在
// 拿到这里之前就该做完的事（复用 src/agent/config.js 的 validateBaseURL()，
// 与保存设置时同一套规则）。这样拆开有两个好处：
//   1) 网络请求/解析/超时/大小上限这几件事本身可以脱离"必须是一个已通过
//      SSRF 校验的 baseURL"这个前提单独做单元测试——tools/test-agent-models-
//      client.js 直接对 127.0.0.1 起一个本地假 /models 服务器验证解析正确
//      性，不需要也不应该为了测试而放松真正的 SSRF 拦截。
//   2) 路由层可以单独测试"输入校验/apiKey 取值优先级/错误映射"这条链，
//      用注入的假 fetchModels 代替真实网络调用（同 supervisor.js 的
//      spawnFn 注入模式），不必每次跑真实网络请求。
//
// 【2026-08-23 减法】此前这里还负责"连接期 IP 钉住"（pinnedAddress/
// pinnedAddresses 参数——调用方对 hostname 做完一次真实 DNS 解析核对之后
// 把结果原样传导到实际 TCP 连接目标，消除两次解析之间的 DNS rebinding
// 窗口）。这一层已整体移除——理由见 src/agent/config.js 顶部与
// docs/agent-gates.md 门禁 9：这个端点本来就在 apiAuth 之后，能调用它的
// 调用方走既有 supervisor 路径（改 baseURL + 开关 + start worker）就能达成
// 同等外联，钉 IP 并未消除该类风险，只是把门槛从两步变三步；而它在真实
// 环境里的误伤（本机跑 Surge/Clash 等 fake-ip 代理时所有域名都解析到
// 198.18.0.0/15，为绕开误伤加的豁免又让这道闸门对这批用户整体退化成
// no-op）比"明确没有这道闸门"更糟。现在只连 target.hostname 本身，不再对
// "DNS 解析结果与实际连接目标是否一致"做任何额外核对——SSRF 防护回退成
// 调用方（validateBaseURL()）的纯字符串黑名单一层，与 worker 启动路径
// 处于同一水位，不是新增风险。
//
// 红线：本模块任何一条抛出的错误里都不含 apiKey 本身——apiKey 只出现在
// 发出去的 Authorization 请求头里，从未进入过任何字符串拼接/模板/错误消
// 息。上游响应体也不会被原样透传给调用方之外的任何地方（模块顶层的
// extractModelIds() 只挑 id 字段）。
import http from 'node:http';
import https from 'node:https';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2MB，模型列表正常不会接近这个量级
const MODELS_PATH_SUFFIX = '/models';

// 统一的错误形状：Error 实例 + .code（机器可读，供路由层做 HTTP 状态码映
// 射）+ 可选 .status（上游原始 HTTP 状态码）+ 内部标记 __handled，供下面
// fetchProviderModels() 的外层 catch 区分"本模块自己已经分类过的错误"（原样
// 透传）与"底层 socket/DNS 抛出的原始异常"（还需要按 timedOut 归类成
// timeout/network_error 两者之一）。__handled 不对外暴露任何意义,纯粹是本
// 文件内部的分类标记。
function modelsError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, __handled: true, ...extra });
}

// 手动读取响应体并在中途按字节数掐断，而不是先整体读完再检查长度——
// Content-Length 头本身可以被上游伪造成一个很小的值，真实 body 却是任意
// 大；只有在真正读流的过程中逐块累计字节数才靠得住。response 是 Node
// http.IncomingMessage（可读流），用 for-await 逐块消费。
async function readBodyWithCap(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw modelsError('response_too_large', '模型服务返回内容过大，已中止');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
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
// （validateBaseURL() 的 normalized 值）。
export async function fetchProviderModels({
  baseURL,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  let target;
  try {
    target = new URL(`${baseURL}${MODELS_PATH_SUFFIX}`);
  } catch {
    throw modelsError('network_error', '连接模型服务失败，请检查网络与 baseURL');
  }

  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  const options = {
    method: 'GET',
    host: target.hostname,
    port: target.port ? Number(target.port) : (isHttps ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  };

  let timedOut = false;
  let req;
  let timer;
  try {
    const response = await new Promise((resolve, reject) => {
      req = transport.request(options);
      timer = setTimeout(() => {
        timedOut = true;
        req.destroy(new Error('anqi-agent-models-timeout'));
      }, timeoutMs);
      req.on('response', resolve);
      req.on('error', reject);
      req.end();
    });

    if (response.statusCode >= 300 && response.statusCode < 400) {
      // 绝不自动跟随 3xx。/models 是一次单纯的只读探测,没有任何正当理由
      // 需要跟着上游的 Location 走;跟随会把这次请求带去一个从未审过、也
      // 从未做过校验的第二个地址,直接废掉上面的 SSRF 拦截（复审探针历史
      // 实测：一个已通过校验的"公网"baseURL 返回 302 指向 127.0.0.1 上的
      // 内网服务,内网服务被真实打到一次,其响应体被当成模型列表原样返回）。
      // 这里显式拒绝,不落到下面泛化的 upstream_error 分支（那样错误码会
      // 误导成"上游服务出错",而真实情况是"上游想让我们去一个没审过的
      // 地址"）。不读取 Location 头,不做任何形式的"提示用户改用最终地址"
      // 之外的自动化——那样等于换一种方式重新实现跟随重定向。
      response.resume();
      throw modelsError('upstream_redirect_blocked', '模型服务地址返回了重定向，出于安全考虑已阻止自动跟随，请直接填写最终地址', { status: response.statusCode });
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume(); // 丢弃 body,不解析非 2xx 响应体
      if (response.statusCode === 401 || response.statusCode === 403) {
        throw modelsError('upstream_unauthorized', 'API Key 无效或无权限，请检查后重试', { status: response.statusCode });
      }
      if (response.statusCode === 404) {
        throw modelsError('upstream_not_found', '该地址未提供 /models 接口（404），请检查 baseURL', { status: response.statusCode });
      }
      throw modelsError('upstream_error', `模型服务返回错误（HTTP ${response.statusCode}）`, { status: response.statusCode });
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
  } catch (error) {
    // 本模块自己已经分类过的错误（modelsError() 产出,带 __handled 标记）
    // 原样透传,不重新归类;其余（req/socket 层的原始异常,如 ECONNREFUSED、
    // ENOTFOUND、被 timer 触发的 destroy()）按 timedOut 标记归到
    // timeout/network_error 两者之一——不把底层原始错误消息透给调用方
    // （可能携带内部路径/系统层细节）,也绝不可能包含 apiKey（它只在
    // header 里,从没进过任何字符串拼接）。
    if (error?.__handled) throw error;
    if (timedOut) throw modelsError('timeout', '连接模型服务超时，请检查网络与 baseURL');
    throw modelsError('network_error', '连接模型服务失败，请检查网络与 baseURL');
  } finally {
    clearTimeout(timer);
  }
}

// 路由层的错误 → HTTP 状态码映射，与 fetchProviderModels() 抛出的 .code
// 一一对应；未识别的 code 一律 502（防御性兜底，不应该真的走到）。
export function modelsErrorToHttpStatus(code) {
  switch (code) {
    case 'upstream_unauthorized': return 401;
    case 'upstream_not_found': return 404;
    case 'upstream_redirect_blocked': return 502;
    case 'timeout':
    case 'network_error': return 504;
    default: return 502;
  }
}
