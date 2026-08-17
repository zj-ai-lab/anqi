<!-- IMPORTANT：案齐目前不接收外部 Pull Request。请把已脱敏的问题或建议提交为 Issue，或在自己的 Fork 中继续维护改动；不要在 PR 上传案件资料。详见 CONTRIBUTING.md。 -->

> 谢谢你愿意为案齐花时间。主仓目前只由维护者本人修改，外部 PR 会按维护政策关闭而不进入评审。这个做法不是许可证限制；AGPL-3.0-only 赋予的 Fork、修改、运行和分发权利不受影响。

以下清单仅供维护者的内部 PR 使用。

## 说明

- 关联 Issue：
- 改动目的：
- 用户可观察行为：

## 维护者检查

- [ ] 改动行为已同步 `docs/DESIGN.md`
- [ ] 数据模型变更已同步 `docs/DESIGN.md §2` 并新增编号 migration
- [ ] UI 体系变更已同步 `docs/DESIGN-TOKENS.md`
- [ ] 部署或公开发行方式变更已同步相应文档
- [ ] 未提交真实当事人信息、数据库、案件夹、日志、凭据或私有基础设施坐标
- [ ] 未擅自改变 `rules/deadline_rules.json` 的 review 状态
- [ ] `npm run check` 全绿，skipped 0
- [ ] 前端变更已目测三种皮肤与 390px 窄屏
- [ ] migration 已用带存量数据的 fixture 验证升级与回滚边界
- [ ] `docs/CHANGES.md` 已更新
