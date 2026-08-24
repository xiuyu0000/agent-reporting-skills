# `deliver-dual-audience-report` 跨平台使用指南

> - 文档状态：现行
> - 适用版本：v0.2 候选 ZIP（摘要以 [claude-code-handoff.md](claude-code-handoff.md) §1 为准）
> - 覆盖平台：Claude Code、Claude Cowork（含 claude.ai）、OpenAI Codex、Kimi（Kimi Code CLI 与 Kimi Work）
> - 事实基线：本文的平台机制核对于 2026-08-20，来源为各平台官方文档与本机实测；平台行为会演进，冲突时以平台当前文档为准

本 Skill 遵循开放 Agent Skills 规范（agentskills.io，SKILL.md + YAML frontmatter），
frontmatter 只使用规范字段（`name`、`description`、`compatibility`），因此在所有
采纳该规范的客户端上都是合法技能。四个目标平台均已确认支持该规范。

## 1. 你会得到什么

安装后，任一平台的 Agent 在满足触发条件时（单一审批人 + 明确审批目标 + 至少 4 个
天然独立决策项）可以调用本 Skill，产出两份文件：

- `<base>_AGENT.md` —— 给下一个 Agent 的精确续作上下文；
- `<base>_APPROVAL.html` —— 给审批人的离线交互审批工作台（浏览器直接打开，
  无网络依赖），审阅后导出结构化回执（`review-packet/1`）驱动下一轮。

## 2. 通用前置（所有平台相同）

### 2.1 获取并校验 ZIP

发布物是确定性 ZIP：`dist/deliver-dual-audience-report-v0.2.0.zip`，顶层目录即
技能目录 `deliver-dual-audience-report/`。安装前核对 SHA-256（当前值见
[claude-code-handoff.md](claude-code-handoff.md) §1 的候选快照表）：

```bash
shasum -a 256 deliver-dual-audience-report-v0.2.0.zip
```

### 2.2 运行时要求（重要）

| 事实 | 说明 |
|---|---|
| 合同运行时 | **Node.js 24 LTS（`>=24 <25`）**。全部发布验证、字节可复现保证与 CI 门禁都在 24.19.0 上断言 |
| 实测兼容 | CLI 运行时不做版本硬拦截；init/render/validate 全流程已在 Node 22.23.2 与 26.7.0 冒烟通过（2026-08-20 实测）。字节级可复现只对 24 承诺 |
| 运行时依赖 | **零**：无需 `npm install`、无 `node_modules`、运行期不访问网络 |
| 产物打开 | APPROVAL.html 在任何现代浏览器离线打开；严格 CSP，无外部资源 |

frontmatter 的 `compatibility` 字段声明了同样的要求，采纳规范的平台会向用户展示它。

### 2.3 路径纪律

CLI 拒绝符号链接路径（`SYMLINK_REJECTED`）与相对歧义路径；给 `--output-dir` 等
参数传绝对、规范化、非符号链接路径。macOS 注意 `/tmp` 是符号链接，用真实路径。

## 3. Claude Code

**安装**（个人级，所有项目可用）：

```bash
unzip deliver-dual-audience-report-v0.2.0.zip -d ~/.claude/skills/
```

项目级改放 `<repo>/.claude/skills/`；同名时企业 > 个人 > 项目。技能目录是热加载
的——放入后当前会话即可见，无需重启。

**调用**：

- 用户显式调用：输入 `/deliver-dual-audience-report`；
- 模型自动触发：请求命中 `description` 中的使用条件时，Claude 经 Skill 工具自动加载。

**运行**：Claude 通过 Bash 工具执行 `scripts/review-delivery.mjs`，走正常权限流；
确保会话 PATH 上的 `node` 满足 §2.2（Homebrew 安装 node@24 后可用
`PATH="/opt/homebrew/opt/node@24/bin:$PATH"` 前缀）。

**实测记录（2026-08-20）**：安装到 `~/.claude/skills/` 后本会话技能清单实时刷新为
v0.2 描述；固定版官方验证器 `skills-ref validate` 通过；Node 24 下 init 冒烟通过。

## 4. Claude Cowork（含 claude.ai）

Cowork 不读取本机 `~/.claude/skills/`，技能随账号同步。上传路径：

1. 打开 **Customize → Skills → ＋ → Upload a skill**；
2. 直接上传 `deliver-dual-audience-report-v0.2.0.zip`——Cowork 要求 ZIP 根即技能
   目录，本发布物的布局天然满足，无需重新打包；
3. 需要启用 **code execution**（Team/Enterprise 由管理员开启，可组织级分发）。

frontmatter 校验：claude.ai/Cowork 上传只接受规范六字段并硬校验长度（name ≤64、
description ≤1024、compatibility ≤500）。本 Skill 实测 28/758/254 字符，全部合规。

**运行时注意**：Cowork 的代码执行沙箱（云端为受出网白名单限制的托管沙箱，桌面版
为本地 VM）自带 Node 版本可能低于 24（第三方对桌面 VM 的拆解曾观测到 Node 22）。
本 CLI 已在 Node 22 全流程实测通过（§2.2），可直接使用；但字节可复现承诺只在
Node 24 有效——若在 Cowork 中做正式交付，建议在会话内让 Agent 先打印
`node --version` 并把版本记入交付说明。

审批人侧不受影响：APPROVAL.html 下载到本地后离线打开即可审阅并导出回执。

## 5. OpenAI Codex（CLI / IDE / 云端）

Codex（CLI 0.148+ 实测）原生支持 Agent Skills，且本 Skill 自带的
`agents/openai.yaml` 正是 Codex 的产品元数据文件（`display_name`、
`default_prompt`、`allow_implicit_invocation` 均被消费）。

**安装**（推荐跨工具互操作目录，Codex 与 Kimi 共用）：

```bash
mkdir -p ~/.agents/skills
unzip deliver-dual-audience-report-v0.2.0.zip -d ~/.agents/skills/
```

项目级放 `<repo>/.agents/skills/`。旧目录 `~/.codex/skills/` 仍被兼容读取，但属
遗留路径；不要在两个目录里同时放同名技能。

**调用**：会话中 `$deliver-dual-audience-report` 显式提及，或 `/skills` 浏览；
描述命中时隐式触发（`openai.yaml` 已允许隐式调用）。按技能开关在
`~/.codex/config.toml` 的 `[[skills.config]]` 配置，改后需重启。

**运行时注意**：

- 本地沙箱执行宿主二进制，默认**断网**——本 CLI 运行期零网络依赖，不受影响；
  但宿主 PATH 上需有满足 §2.2 的 node；
- **Codex 云端**镜像默认只带 Node 18/20/22：在环境 setup script（该阶段有网）中
  安装 Node 24，或接受在 Node 22 上运行（功能实测可用，见 §2.2）；
- Codex 会整段加载 AGENTS.md 而按需加载技能——不要把本 Skill 正文复制进
  AGENTS.md，写一行指引即可。

**实测记录（2026-08-20）**：`codex features list` 确认 `skill_search` 为 stable；
安装副本通过固定版官方验证器；Node 24 下 init 冒烟通过。

## 6. Kimi（Kimi Code CLI 与 Kimi Work）

**Kimi Code CLI**（命令 `kimi`）原生支持开放 Agent Skills 格式。

**安装**：上一节的 `~/.agents/skills/` 互操作目录 Kimi 会自动发现，与 Codex 共用
一份安装即可；专属目录为 `~/.kimi-code/skills/`（用户级）与
`<repo>/.kimi-code/skills/`（项目级），也可在 `~/.kimi-code/config.toml` 的
`extra_skill_dirs` 追加目录，或用 `kimi --skills-dir <dir>` 临时指定。

**调用**：`/skill:deliver-dual-audience-report` 显式调用，或描述命中自动触发。

**运行时注意**：Kimi Code 单二进制安装自身不需要 Node——技能脚本经宿主 shell
执行，因此 §2.2 的 Node 要求是**用户自装前置**；确认 `node --version` 满足要求。

**Kimi Work**（桌面产品，内核即 Kimi Code）：在其 Skills 面板上传/启用技能，
支持本地上传；上传物即本 ZIP。桌面端未公开磁盘级技能规范，以面板操作为准。

## 7. 完整使用工作流（四平台一致）

Agent 触发技能后按 SKILL.md 的阶段推进；人只在两处介入：授权与审阅。

```text
1  init      Agent 创建草稿合同（你确认标题、语言、输出目录与公开范围）
2  撰写      Agent 从已核实证据填 review-document.json（4–15 块，T2≤7）
3  render    生成 <base>_AGENT.md + <base>_APPROVAL.html
4  审阅      你在浏览器离线打开 APPROVAL.html：逐块 PASS/EDIT/TOPIC/HOLD，
             可随手记、全局主题、部分审阅与断点续审；完成后导出回执
5  validate  Agent 用 validate packet 校验回执真伪与绑定
6  consume   Agent 消费回执产出下一轮（全 PASS 即定稿，正文逐字节不变）
```

手动运行 CLI（任一平台的技能安装目录内）：

```bash
node <skills-dir>/deliver-dual-audience-report/scripts/review-delivery.mjs --help
```

命令细节、拆分交付与跨轮协议见技能内
`references/review-protocols.md`；写作要求（零上下文直白语言、termRef 术语绑定、
结构化可视化）见 `references/audience-contracts.md`。

## 8. 故障排查

| 症状 | 原因与处理 |
|---|---|
| `SYMLINK_REJECTED` | 路径含符号链接（macOS 的 `/tmp` 等）；改用真实绝对路径 |
| render 报 `CSP_INVALID`（replace 时） | 旧产物出自不同版本的生成器，配对校验按设计拒绝；在新的空目录全新 render，旧产物留档 |
| 回执被拒 | 回执与文档的 id/轮次/摘要不匹配，或内容被改动；从工作台重新导出 |
| 技能不出现（Codex） | 检查目录（`~/.agents/skills/` 或遗留 `~/.codex/skills/`），重启 CLI；`codex features list` 确认 skills 特性开启 |
| 技能不出现（Kimi） | `kimi doctor` 校验配置；确认目录或 `extra_skill_dirs` |
| Cowork 上传被拒 | 确认 ZIP 根即技能目录且 frontmatter 仅含规范字段（本发布物已满足；勿自行改包） |
| 产物字节与记录摘要不一致 | 检查 node 版本——可复现承诺仅限 Node 24（§2.2） |

## 9. 隐私与边界

- 真实业务内容只写入你授权的私有输出目录；APPROVAL.html/AGENT.md/回执都含业务
  正文，不要提交进公开仓库或上传到未授权服务；
- Cowork/Codex 云端会话中生成的产物存于对应平台的工作区，注意平台侧的数据边界；
- 技能授权的是"生成与校验"，不授权对外发布、执行外部系统操作或代替人拍板——
  四动作裁决永远属于审批人。
