// session_id -> case_id 服务端登记表（设计稿 §2/§4 的唯一事实来源）。
//
// 设计稿 §2「case_id：由 supervisor 的固定案件绑定产生，不从模型正文推断」与
// §4「服务端从已存的 session binding 取得 case/agent，不信任客户端提交的
// case/cwd」要求：任何受信任写入面（目前是 /internal/agent-proposals，未来
// approval/user-question 的 one-shot 回答通路同理）必须按 session_id 反查
// case，而不是相信请求体里的 case_id。
//
// AgentSupervisor.start() 在铸造 sessionId、把它注入 worker 环境变量之前，
// 立刻调用 bindSession() 登记这条绑定；worker 终态收尾（_finalizeWorker，
// 覆盖 graceful stop 与崩溃两条路径）时调用 unbindSession() 注销——worker
// 一旦不在运行，这个 session_id 就不应该再被用来提交新提案。
//
// 只是一个进程内 Map：单进程 supervisor，重启即清空，不需要持久化；
// 与 DSH 子进程的实际存活与否无关——存活性由 supervisor.workers 自己管理，
// 这里只负责"这个 session 属于哪个 case"这一件事。
const sessionToCase = new Map();

export function bindSession(sessionId, caseId) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('bindSession 需要非空字符串 sessionId');
  }
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new Error('bindSession 需要合法 caseId');
  }
  sessionToCase.set(sessionId, caseId);
}

export function unbindSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  sessionToCase.delete(sessionId);
}

// 反查：查不到返回 null，绝不回落到"信任调用方"。
export function caseIdForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return sessionToCase.get(sessionId) ?? null;
}

// 仅供测试使用：清空整张表，避免多个测试文件的进程内状态互相污染。
export function _resetSessionRegistryForTest() {
  sessionToCase.clear();
}
