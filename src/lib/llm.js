// LLM 层（1.1.0）：只做「把一句话整理成结构化建议」，别的一概不干。
//
// 铁律（CLAUDE.md）在这里的落地方式：
//   ① **LLM 永不算期限**——本模块的输出类型只有 task / log 两种，**在结构上就没有
//      产出 deadline 的可能**。法定期限只能由 deadline engine（确定性纯函数）推。
//      提示词里也明写禁止，但真正的防线是这里的类型闭合 + 路由层的白名单校验。
//   ② **LLM 不写库**——本模块是纯函数式的「解析器」，不 import db，拿不到任何写入口。
//      产物回到前端填进快录条的输入框，**人按「记」才走 /api/quick 入表**（= 人工确认）。
//      收件箱走的是异步路径（后台 Agent 提取，人不在场），与这里的同步路径分开，
//      两条路的共同不变量是：LLM 的产物永不自己落库。见 DESIGN.md §8.6。
//
// 隐私尺度（用户 2026-07-13 拍板）：**只把用户亲手打的那句话发出去**。
//   不发案件列表、不发当事人名单、不发案号库——LLM 看不到你没写的东西。
//   案件匹配由本地代码做（routes/records.js 的 matchCase），全程不出机。
//   事实核对（2026-07-13）：DeepSeek 付费 API 账号的数据默认不用于训练，
//   且数据存储在中国境内（符合 DESIGN.md「库与备份不出境」）。
//
// 供应商：DeepSeek 官方 API（OpenAI 兼容格式），零新依赖，走 Node 原生 fetch。
// base_url 可配（env DEEPSEEK_BASE_URL），默认官方地址；换其他 OpenAI 兼容供应商只改 env。
const API_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '') + '/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
// ⚠ 旧模型名 deepseek-chat / deepseek-reasoner 于 2026-07-24 下线，别回退到它们。
const TIMEOUT_MS = 12000;
const MAX_TEXT = 500;

export function llmReady() {
  return !!process.env.DEEPSEEK_API_KEY;
}

// 提示词里必须出现 "json" 字样，否则 DeepSeek 的 json_object 模式不生效（官方文档明写）。
// ⚠ 范例 json 里**绝不能带 // 注释**——那本身就是非法 json，等于教模型吐非法 json。
//   字段说明一律写在 json 块外面。（1.1.0 实测踩过：带注释的范例导致偶发返回非法 json / 空内容。）
function systemPrompt(today, weekday) {
  return `你是律师个人案件系统的录入助手。把用户一句话口语，整理成一条结构化记录，只用 json 回答。

今天是 ${today}（星期${weekday}）。相对日期（明天 / 下周三 / 月底）以此换算成具体日期。
注意：「下周X」指**下一个自然周**的周X（本周的说法是「本周X / 这周X」）。「X 天后 / X 天内」按自然日加。

输出格式，严格照这个形状，只输出这一个 json 对象：
{"kind":"task","title":"交举证材料","date":"2026-07-14","case_hint":"王五案"}

字段含义：
- kind：只能是 task 或 log。task = 以后要做的事；log = 已经做完的事的留痕。分不清给 task。
- title：整理后的事项，去掉时间词和案件名，只留「做什么」。简洁可执行，不超过 40 字。
- date：task 是打算哪天做，log 是哪天做的。用户没提到日期就给空字符串 ""。
- case_hint：用户话里指向某个案件的那几个字（当事人名 / 案由 / 案号片段），原样摘出不要改写。没有就给 ""。

规则：
1. 法律期限（举证期限、上诉期、答辩期等）不归你算。用户提到期限，你只当作他说了这么一件事记下来：date 只填他明说的日期，他没明说就留 ""。**任何情况下都不要自己推算期限的截止日**——系统另有确定性引擎负责。
2. 用户没说的一律留空，不要脑补。宁可留空让人来填，也不要猜错。
3. title 里不要重复案件名（案件靠 case_hint 单独匹配）。
4. 只输出那个 json 对象本身，不要解释，不要 markdown 代码块。`;
}

/** 剥掉模型偶尔套上的 markdown 代码围栏 —— 防御性，不指望它总守规矩 */
function stripFence(s) {
  const t = String(s).trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (m ? m[1] : t).trim();
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 把一句话解析成 {kind, title, date, case_hint}。
 * 不校验语义（那是路由层的活）——这里只负责拿到一个「形状对」的对象。
 * @throws 未配 key / 超时 / 上游报错 / 返回不是合法 json
 */
export async function parseQuick(text, today) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw Object.assign(new Error('未配置 DEEPSEEK_API_KEY'), { code: 'NO_KEY' });
  const raw = String(text || '').trim();
  if (!raw) throw new Error('text 不能为空');
  if (raw.length > MAX_TEXT) throw new Error(`text 过长（>${MAX_TEXT} 字）`);

  // 官方文档明写「API 偶发返回空 content」——单次调用本来就不该当可靠。
  // 重试一次即可：实测失败是偶发抖动而非确定性拒答（同一句话有时成有时空）。
  // 401/超长这类确定性错误不重试（下面 callOnce 直接抛，不进循环）。
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callOnce(key, raw, today);
    } catch (e) {
      if (e.fatal) throw e;          // key 错 / 上游 4xx：重试也没用
      lastErr = e;
    }
  }
  throw lastErr;
}

async function callOnce(key, raw, today) {
  const weekday = WEEKDAY[new Date(today + 'T00:00:00+08:00').getDay()];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt(today, weekday) },
          { role: 'user', content: raw },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,          // 抽取任务，不要创造力
        // 🔴 必须关思考模式。v4-flash **默认开着思维链**，而 reasoning token 是算进
        //    max_tokens 的——复杂句子的思考能把 400 的预算吃光，content 直接空串返回
        //    （finish_reason=length）。「偶发空内容」的真身就是这个，不是随机抖动。
        //    实测（2026-07-13，同一句话）：
        //      disabled → finish=stop、1.0s、合法 json
        //      默认     → finish=length、5.4s、思考吃掉 400 token、content=""
        //    对「一句话抽 json」这种任务，思维链是纯浪费：慢 5 倍、按输出价计费、还制造故障。
        thinking: { type: 'disabled' },
        max_tokens: 300,         // 关了思考后，300 足够装下这个 json（实测约 40 token）
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'LLM 超时（12s）' : `LLM 网络错误：${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 4xx = key 错/请求非法，重试无意义；5xx/429 是暂时的，交给上层重试
    const e = new Error(`LLM 上游 ${res.status}：${body.slice(0, 200)}`);
    e.fatal = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw e;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  // 官方已知问题：偶发返回空 content。当成可重试失败，别静默给个空建议。
  if (!content || !content.trim()) throw new Error('LLM 返回空内容');
  try {
    return JSON.parse(stripFence(content));
  } catch {
    throw new Error('LLM 返回的不是合法 json');
  }
}
