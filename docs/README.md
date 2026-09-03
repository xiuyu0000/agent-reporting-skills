# `docs/` 文档索引

> - 文档状态：现行
> - 最后更新：2026-09-03
> - 作用：说明 `docs/` 下每份文档的职责、当前状态、权威顺序与维护规则。本文不重复其他文档的内容，只负责导航与治理。

## 1. 现行文档

| 文档 | 职责 | 状态 | 最后更新 | 权威层级 |
|---|---|---|---|---|
| [spec.md](spec.md) | 需求契约：Skill 必须表现成什么样、边界与验收标准（其“目标发布 v0.2.0”指 v0.2 线，当前候选为 v0.2.1；spec 正文与摘要未变） | 已确认，需求基线（0.2-baseline） | 2026-08-17 | 3a（产品需求事实源） |
| [design.md](design.md) | 技术设计：如何实现 spec，以及为什么采用这些工程选择 | 已确认，实施基线（0.2-implementation-baseline） | 2026-09-03 | 3b（工程决定事实源） |
| [task.md](task.md) | 实施施工单：波次、DAG、任务卡、写入边界与完成证据 | 已确认，执行中（W7） | 2026-09-03 | 3c（实施顺序与状态） |
| [claude-code-handoff.md](claude-code-handoff.md) | 运行交接：候选 SHA、ZIP 摘要、PIL-001/MET-001 runbook、授权与停止条件 | 现行运行快照 | 2026-09-03 | 4（操作快照） |
| [platform-usage.md](platform-usage.md) | 跨平台使用指南：Claude Code / Cowork / Codex / Kimi 的安装、调用、更新指南、运行时事实与故障排查 | 现行 | 2026-09-03 | 使用指南（不定义行为） |
| [local-development.md](local-development.md) | 本地开发与验证：工具链版本、一次性准备、门禁跑法与已记录的执行注意事项 | 现行操作记录 | 2026-09-03 | 4（操作快照；不定义需求或设计） |
| [viz-001-approval-visual-clarity-2026-09-02.md](viz-001-approval-visual-clarity-2026-09-02.md) | VIZ-001 变更请求：审批 HTML 表达清晰度与可视化的需求、影响判定与实施方案 | 已获用户 2026-09-02 批准，W24 已实施 | 2026-09-02 | 变更记录（不定义需求；需求仍以 spec 为准） |
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
- **W19 / SKL-003、REL-008**（`done`）：按用户指令确保 Skill 在 Claude Code、Claude Cowork、Codex 与 Kimi 四个平台可用——frontmatter 依开放规范补 `compatibility` 运行时声明（SKL-001 的逐字节钉点同步），新增 [platform-usage.md](platform-usage.md) 四平台指南，README 安装节改为平台矩阵。运行时事实按「合同运行时 Node 24 vs 实测可运行 22/26」两层如实表述，因为 Cowork 沙箱与 Codex 云端镜像的默认 Node 低于 24。分发面变化由 REL-008 重切候选。
- **W20 / 仓库卫生与本地验证环境**（`done`）：经用户明确授权补齐 `.gitignore` 未覆盖的四个工具链产出目录（否则 handoff §6.2 的干净树预检在任何一次构建或测试后必然失败），并修正 `dist/` 自 v0.1 遗留的裸忽略规则使新发布产物对 `git status` 可见；新增 [local-development.md](local-development.md) 固化本地工具链与门禁跑法，其中 §5.1 记录了一条**未修复**的审批台滚动竞态（仅在三引擎合并跑且宿主 CPU 饱和时复现，修复属产品变更须另立波次）。产品与测试代码零改动，候选摘要不变。
- **W22 / 文档订正：Codex 安装路径**（`done`）：[platform-usage.md](platform-usage.md) §5 此前把 `~/.codex/skills/` 写成“仍被兼容读取”的遗留路径，与 Codex 现状相反——Codex 自带的 skill-installer 系统技能明确安装到 `$CODEX_HOME/skills/<skill-name>`（默认 `~/.codex/skills`），且两个目录经实测都被扫描。§5 改为并列呈现两条现行受支持路径（`~/.codex/skills/` 为 Codex 第一方默认，`~/.agents/skills/` 为与 Kimi 共用的跨工具互操作目录），同名技能不可双放的警告保留，“改后需重启”收窄到 `[[skills.config]]` 开关。文档-only，只写 §5 与三份文档的同步位；`src/`、`tests/`、`skills/`、`dist/` 零改动，候选摘要不变。
- **W23 / UI-008、VAL-004、REL-009**（`done`）：真实试点中一份规范 JSON 49,994 字节（Base64 66,660 字符）的合同在 WebKit 浏览器中被工作台以 `DOCUMENT_ENCODING_INVALID` 拒载——WebKit 解析器把超过 65,536 code unit 的模板文本续入第二个文本节点，而读取端要求恰好一个。读取端改为接受任意非空的纯文本节点序列；render 与 validate delivery/batch 在规范 JSON 达到 47,616 字节时携带载荷预算 `warnings`。候选按 REL-009 重切。
- **W24 / UI-009、UI-010、CTR-003、SKL-004、REL-010**（`done`）：按用户 2026-09-02 的三条使用反馈修复审批面表达清晰度。flow 改为按边集分层并对边标签做避让搜索（原实现按数组下标摆成固定二列、标签钉在线段中点，重叠是确定性的）；术语定义预览从滚动容器内的 `::after` 伪元素改为 `<body>` 级单例（`overflow-x:auto` 会使 CSS 把另一轴计算为 `auto`，因此表格同时垂直裁剪）；`ContentNode` 增加 `scale` 节点，`FlowGraphNode`/`FlowGraphEdge` 增加可选 `kind`；Skill 写作规范改为以载体选择作强制触发并配工作示例。影响判定见 [viz-001-approval-visual-clarity-2026-09-02.md](viz-001-approval-visual-clarity-2026-09-02.md)：**不构成 spec 需求条款变更**，spec 摘要前后一致。字节门未放宽（2026-09-02 首次落地 391376/393216，余 1840；2026-09-03 重排到 W23 之上后 391339/393216，余 1877），原计划的第二个新节点 `matrix` 因此未实施。协议面为纯可选加法：既有文档字节与摘要不变，偏斜是向前的（新文档在旧 v0.2.0 运行时下被拒收而非误读），声明见 [claude-code-handoff.md](claude-code-handoff.md) §1。候选按 REL-010 重切（摘要见 task.md 的 REL-010 卡；该 v0.2.0 候选文件已于 W25 从树中移除）。
- **W25 / REL-011、DOC-003**（`done`）：候选线切换到 v0.2.1。W23 与 W24 都是在 v0.2.0 候选冻结后落地的分发面变更，继续在 `codex/v0.2.0` 上重切候选已不合适；用户于 2026-09-03 从 `main` 开出 `codex/v0.2.1` 作为新的集成分支与 PR base，`codex/v0.2.0` 冻结在 `3ff6509`（含 W23 PR #83 与 W24 PR #84）作为 v0.2.0 候选谱系，不再合入。REL-011 把 `package.json`、`RELEASE_VERSION`、`GENERATOR_VERSION`、`SUPPORTED_GENERATOR_VERSION` 与构建标记统一升到 0.2.1，按 DES-014 的不双轨规则只支持 `generatorVersion: 0.2.1`。2026-09-03 用已安装的 0.2.0 运行时渲染 W23 期 fixture 再以 0.2.1 CLI 实测：0.2.0 生成的视图内嵌自身 0.2.0 工作台，仍是自包含的离线工作台，照常打开并可走完本轮（不会出现 `META_IDENTITY_MISMATCH`，该码只在把另一生成器版本的载荷装入不同版本的工作台时触发，CLI 不会产出这种组合）；0.2.1 CLI 拒绝对旧视图操作——`validate delivery` 报 `CSP_INVALID`（`/approval`、`/approval/csp`），`render --replace-generated` 另报 `ARTIFACT_IDENTITY_MISMATCH`（`/approval/meta`），原因是旧工作台的内联脚本/CSP 哈希与生成器 meta 与当前运行时会生成的不同；`review-document/1` 文档不变，用 0.2.1 重渲染得到相同的 `dar-review-digest`、`contentVersion` 与 round（仅 `dar-generator-version` 由 0.2.0 变为 0.2.1），`review-packet/1` 回执绑定文档身份而非审批 HTML，旧视图导出的回执对未变动文档的 `validate packet`/`consume` 仍有效。处理原则：旧视图留档、在新的空目录重新 render（render 为只创建，`TARGET_EXISTS`），不删除私有输出根下的任何内容。REL-011 同时把 CI 触发分支与发布步骤改为 v0.2.1，126 处测试字面量同步迁移；候选在 Node 24.19.0 上重切为 `dist/deliver-dual-audience-report-v0.2.1.zip`（1,024,339 字节，SHA-256 `3c766e13bad7eccafa8426825c7ed9c590be3ac74e28281440e289e2aec6545f`；manifest SHA-256 `9da67c25e4f901db4754032f2cf82bbd0c3980232c5e46bd59f92dac0169023b`；12 个条目；工作台 391339/393216），v0.2.0 的 ZIP/manifest 从树中移除，`v0.1.1` ZIP 作为历史证据保留。DOC-003 新增 [platform-usage.md](platform-usage.md) 的四平台**更新指南**（替换已安装版本的可验证步骤；未在本轮实测的平台机制按推断标注），并把 CLAUDE/AGENTS/README/本索引/local-development/handoff 的分支上下文统一到 `codex/v0.2.1`。设计决定记录为 DES-022。本地 `~/.claude/skills`、`~/.agents/skills` 下的已安装副本已于同日经用户授权同步为本候选（12 文件摘要与 manifest 一致）；`codex/v0.2.0` 同日补打注释 tag `v0.2.0` 标记冻结点，仍无 GitHub Release。

绿色 CI、fixture、演示内容与 replay no-op 仍不能关闭 MET-001。候选分支、候选 SHA、ZIP/manifest 摘要与逐步 runbook 见 [claude-code-handoff.md](claude-code-handoff.md)；任务级状态见 [task.md](task.md) §4。v0.2.1 tag 与 GitHub Release 均未创建，且需要单独授权；v0.2.0 从未打过 tag，是否在 `3ff6509` 补打由用户另行决定。

## 4. 分支上下文

规划文档描述的是 **v0.2 候选**，当前候选线为 **v0.2.1**，集成分支为 `codex/v0.2.1`（用户于 2026-09-03 从 `main` 开出）。自 2026-08-20 起，默认分支 `main` 通过 `-s ours` 同步合并与集成分支保持**树完全一致**（两侧历史都保留：main 此前独有的一条 2026-08-17 文档整合提交经该合并并入谱系），该规则原样延续到 `codex/v0.2.1`。`codex/v0.2.0` 冻结在 `3ff6509`，作为 v0.2.0 候选谱系保留，不再合入、不作 PR base。因此 `main` 与 `codex/v0.2.1` 的内容相同，规则如下：

- PR 一律以 `codex/v0.2.1` 为 base；每次集成分支变化后以同样的同步合并更新 `main`；
- 试点/真实审批流程仍按 handoff 要求在独立干净工作树中运行，且只用经校验后私有解压的发布 ZIP 作为运行时——分支同步不改变该纪律。

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
