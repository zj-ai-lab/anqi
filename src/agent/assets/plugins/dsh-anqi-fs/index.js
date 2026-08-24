// 案件 workspace 强 containment 的 DSH filesystem provider。
//
// 上游 dsh-fs-sandbox 的 workspace-write 只围写/改，明确允许读取任意宿主
// 可读路径；对通用 coding agent 这是产品选择，对单案律师工作区却不够。本类
// 保留上游的原子写、read-before-write、版本 guard 和 permission escalation，
// 只在 provider seam 上加一条更窄的规则：所有 model-facing fs target 必须先
// canonicalize，并仍位于构造时钉死的 cwd 下。绝对路径不是特例——在根内可用，
// 根外一律 FS_SANDBOX_DENIED；指向根外的 symlink 会在 realpath 后同样被拒绝。
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import { FsError } from '@deepseek-ai/dsh-fs';

function denied(target) {
  return new FsError(
    `cannot access "${target?.displayPath || '(unknown path)'}": outside the anqi case workspace`,
    'FS_SANDBOX_DENIED',
  );
}

export default class AnqiWorkspaceFileSystem extends SandboxedFileSystem {
  constructor(ctx, config) {
    super(ctx, config);
    // 调父类实现，避开下面 override，得到唯一可信的 canonical root identity。
    this.workspaceRootPromise = super.resolve(this.config.cwd);
  }

  async assertContained(target) {
    const root = await this.workspaceRootPromise;
    if (!super.contains(root, target)) throw denied(target);
    return target;
  }

  async resolve(filePath, options) {
    return this.assertContained(await super.resolve(filePath, options));
  }

  async lstat(filePath, options, signal) {
    await this.resolve(filePath, { ...(options || {}), signal });
    return super.lstat(filePath, options, signal);
  }

  async stat(target, signal) {
    return super.stat(await this.assertContained(target), signal);
  }

  async readText(target, signal) {
    return super.readText(await this.assertContained(target), signal);
  }

  async streamText(target, signal) {
    return super.streamText(await this.assertContained(target), signal);
  }

  async readBytes(target, signal, maxBytes) {
    return super.readBytes(await this.assertContained(target), signal, maxBytes);
  }

  async listDir(target, signal) {
    const entries = await super.listDir(await this.assertContained(target), signal);
    const root = await this.workspaceRootPromise;
    // LocalFileSystem.listDir 会解析每个 child 的真实 target；过滤掉工作区内
    // 指向根外的 symlink，既不给后续 consumer 一个越界 target，也不泄露外部
    // 目标的类型/大小元数据。
    return entries.filter((entry) => super.contains(root, entry.target));
  }

  async writeText(target, content, expected, signal, sandboxPolicy) {
    return super.writeText(await this.assertContained(target), content, expected, signal, sandboxPolicy);
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    return super.editText(await this.assertContained(target), edit, expected, signal, sandboxPolicy);
  }
}
