# `docs/` 文档索引

> - 文档状态：现行
> - 最后更新：2026-08-17
> - 作用：说明 `docs/` 下每份文档的职责、当前状态、权威顺序与维护规则。本文不重复其他文档的内容，只负责导航与治理。

## 1. 现行文档

| 文档 | 职责 | 状态 | 最后更新 | 权威层级 |
|---|---|---|---|---|
| [spec.md](spec.md) | 需求契约：Skill 必须表现成什么样、边界与验收标准 | 已确认，需求基线（0.2-baseline） | 2026-08-17 | 3a（产品需求事实源） |
| [design.md](design.md) | 技术设计：如何实现 spec，以及为什么采用这些工程选择 | 已确认，实施基线（0.2-implementation-baseline） | 2026-08-17 | 3b（工程决定事实源） |
| [task.md](task.md) | 实施施工单：波次、DAG、任务卡、写入边界与完成证据 | 已确认，执行中（W7） | 2026-08-17 | 3c（实施顺序与状态） |
| [claude-code-handoff.md](claude-code-handoff.md) | 运行交接：候选 SHA、ZIP 摘要、PIL-001/MET-001 runbook、授权与停止条件 | 现行运行快照 | 2026-08-17 | 4（操作快照） |
| [int-001-external-evidence-2026-08-13.json](int-001-external-evidence-2026-08-13.json) | INT-001 外部读者隔离与 A14 边界的内容无关证据记录 | 历史证据，不可变 | 2026-08-13 | 证据，不是指令 |

`docs/` 下没有其他现行文档。如果在某个分支或工作树里看到未列入本表的 `docs/` 文件，先判断它是否已被本表中的文档取代，再决定合并或删除，不要直接当作现行事实使用。

## 2. 权威顺序

冲突按以下顺序收敛，与 [claude-code-handoff.md](claude-code-handoff.md) §1 一致：

1. 用户当前明确指令或新授权的事实；
2. 当前候选代码、公开 Skill 文件、Schema 与已执行的验证结果；
3. 规划文档：[spec.md](spec.md) → [design.md](design.md) → [task.md](task.md)；
4. [claude-code-handoff.md](claude-code-handoff.md)（运行快照）；
5. 通用工具知识或推断惯例。

需求与设计冲突时以 spec 为准；设计与施工单冲突时以 design 为准；文档与实际候选状态冲突时，先用一次真实检查（Git、CI、GitHub、工作树）确认，再回写文档，不要让文档单方面宣布现状。

## 3. 当前状态摘要

v0.2 的 W0–W6 已全部完成并产出发布候选，剩余工作只有 W7 的真实使用门：

- **PIL-001**（`done`，2026-08-20，Issue #61 已按内容无关模板关闭）：一个经用户确认真实且有用的案例完成完整闭环；PIL-001: status=completed; validation=pass; content remains private. 负担指标因指标目录未授权而未采集（私有收口记录在案）。
- **MET-001**（`deferred`，Issue #62）：等待累计 3–5 份真实案例。

此外有若干候选冻结后的维护波次，均不改变 W7 的阻塞条件：

- **W8 / REL-002**（`done`）：修复文档跟踪化在候选分支上引入的 `scan:legacy-surface` 发布门回归，并把该门的核心断言下沉到单元测试。不改变产品行为或候选字节。
- **W9 / UI-004、VAL-002、RND-002、DOC-001、REL-003**（`done`）：以 spec 条款为准的对抗式复审确认了四个契约缺口——随手记编辑绑定活动游标、被拒动作回显机器码（§9.3/§13.5），个人绝对路径与作者占位符漏检（§13.2/§14.1），候选自声明影响集可授权改写未触及待处理块（§11.3），以及 DES-017 与已跟踪现状相反。四项均已修复并各有变异验证的回归测试；由于修复进入了分发运行时，候选 ZIP 按用户 2026-08-18 的决定重切，新摘要见 [claude-code-handoff.md](claude-code-handoff.md) §1。
- **W10 / IO-001、VAL-003、GEN-002、TEL-002、REL-004**（`done`）：第二轮对抗式复审覆盖首轮只间接触及的 I/O、consume、生成器、telemetry 与 Skill 表面，确认并修复了五个缺口，其中最严重的一个会在重复写入相同字节时永久卡死输出根，并在崩溃窗口内删除用户已交付的文件。
- **W11 / UI-005、REL-005**（`done`）：审批 HTML 改用用户已批准的审批工作台原型视觉系统（暖纸色、分诊左边框与决定态、分诊 pill、带键帽的四动作 chip、真实进度条、筛选 pill、紧凑侧栏），并按原型的阅读顺序让决策块居前、上下文面板折叠保留。三条原型规则因实测无障碍对比度不达标而做了等价替换；工作台体积上限由 350 KiB 提升至 384 KiB。
- **W12 / CI-001**（`done`）：CI 的 Playwright 浏览器安装在 apt 镜像退化时曾静默挂起超过 3 小时。安装步骤拆为“浏览器下载（致命）/系统依赖（有界重试、可降级）”两阶段并缓存浏览器目录。只写 `.github/**`，候选字节不变。
- **W13 / DOC-002**（`done`）：把 W11 已获批准并实施的审批台视觉系统固化为契约——spec §1 例外与 §7.2 条款、design DES-019 与 §11.8 规范性 token 清单——并按 DOC-001 先例重新绑定三文档摘要。文档-only，候选字节不变。
- **W14 / CI-002**（`done`）：apt 退化根治经用户审批工作台回执（round 1 全 PASS）授权：浏览器 lane 全部改跑按 digest 固定的官方 Playwright 容器镜像，apt 与浏览器下载移出 CI 关键路径；Node 24.19.0 钉版在容器内保持，镜像/npm 版本锁步由变异验证的单元测试守护。只写 `.github/**` 与测试，候选字节不变。
- **W15 / UI-006、REL-006**（`done`）：用户实际使用审批台后的 5 条反馈逐条裁定并落地——动作 chip 兑现 aria-pressed 开关语义（PASS 重复触发即撤销，输入型动作走预填编辑器 + 显式撤销）、随手记编辑器显示写入目标块、termRef 悬停定义预览（仅补充）、契约内表格可读性增强、Skill 写作规范强制零上下文直白语言与术语绑定。配色重设计未采纳（DES-019 契约冻结，理由已呈用户）。候选按 REL-006 重切。
- **W17 / UI-007、REL-007**（`done`）：按用户 2026-08-20 反馈把 termRef 简化为单一锚点——悬停/聚焦预览定义、点击直接跳转术语表附录，去掉“展开定义”按钮与独立跳转链接。候选按 REL-007 重切。

绿色 CI、fixture、演示内容与 replay no-op 仍不能关闭 MET-001。候选分支、候选 SHA、ZIP/manifest 摘要与逐步 runbook 见 [claude-code-handoff.md](claude-code-handoff.md)；任务级状态见 [task.md](task.md) §4。v0.2 tag 与 GitHub Release 均未创建，且需要单独授权。

## 4. 分支上下文

规划文档描述的是 **v0.2 候选**，其实现位于 `codex/v0.2.0`。默认分支 `main` 仍是较旧的 v0.1 代码线（`main` 的全部提交都包含在 `codex/v0.2.0` 中，后者另有 60 个提交）。

因此在 `main` 上阅读时：

- [claude-code-handoff.md](claude-code-handoff.md) 指向的 `../AGENTS.md`、`../CLAUDE.md` 与 `../skills/deliver-dual-audience-report/references/review-protocols.md` 在 `main` 上不存在，只存在于 `codex/v0.2.0`；
- `main` 上的 `SKILL.md`、`references/` 与 `scripts/` 仍是 v0.1（Python、静态人类叙事 HTML）实现，与本目录描述的 v0.2 行为不一致。

不要在 `main` 工作树上执行 v0.2 或 PIL-001 流程；按 handoff 的要求使用独立的 v0.2 工作树，并只用经校验后私有解压的发布 ZIP 作为试点运行时。

## 5. 不在本目录的材料

`docs/调研/` 是本地私有调研与审批材料，自 2026-08-17 起由 `.gitignore`（`docs/调研`）排除在仓库之外：

- 它不会被提交，也不应被恢复到仓库中；
- 它的正文不得复制进任何跟踪文件；
- [spec.md](spec.md) §17 中的 `docs/调研/...` 路径是**来源溯源记录**，不是仓库内可解析的链接。缺少该目录不影响实现、验证或评审，任何自动化都不得因此阻塞。

真实试点的方案正文、标题、文档 ID、回执、截图、审批者身份与命令输出同样不进入本目录，只保留在用户授权的私有输出根下。

## 6. 维护规则

1. **摘要绑定**：`spec.md` 变更后重算其 SHA-256，回填 [design.md](design.md) 与 [task.md](task.md) 文首；`design.md` 变更后回填 [task.md](task.md) 文首。三者变更后都要更新 [claude-code-handoff.md](claude-code-handoff.md) §1 的摘要表。

   ```bash
   shasum -a 256 docs/spec.md docs/design.md docs/task.md
   ```

2. **单向扩展**：需求只在 `spec.md` 增删，工程决定只在 `design.md` 增删，任务状态只由协调者在 `task.md` 增删。不得在下游文档里静默扩展上游范围。
3. **状态同步**：波次、剩余任务或候选事实变化时，[task.md](task.md)、[claude-code-handoff.md](claude-code-handoff.md) 与本文第 3 节必须一并更新，不得互相矛盾。
4. **公开树隐私**：本目录的跟踪文档属于公开树。提交前复扫真实业务正文、方案标题、文档 ID、审批者/参与者身份、个人绝对路径与凭据；发现命中先移除再提交。
5. **不重复内容**：本文只做索引。任何具体需求、设计、任务或运行细节都应写进对应文档，并在此处引用。
