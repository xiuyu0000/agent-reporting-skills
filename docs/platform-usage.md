# `deliver-dual-audience-report` 跨平台使用指南

> - 文档状态：现行
> - 适用版本：v0.2.1 候选 ZIP（摘要以 [claude-code-handoff.md](claude-code-handoff.md) §1 为准）
> - 覆盖平台：Claude Code、Claude Cowork（含 claude.ai）、OpenAI Codex、Kimi（Kimi Code CLI 与 Kimi Work）
> - 事实基线：本文的平台机制核对于 2026-08-20，来源为各平台官方文档与本机实测；平台行为会演进，冲突时以平台当前文档为准
> - 2026-09-03 补记：安装机制（目录、热加载、上传入口）的核对时间仍为 2026-08-20/24；§7 的升级步骤是 2026-09-03 随 v0.2.1 版本线切换新写的指引，“替换已安装版本”未逐平台实测，其中推断部分逐条标注为“按平台机制推断，未在本轮实测”

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

发布物是确定性 ZIP：`dist/deliver-dual-audience-report-v0.2.1.zip`，顶层目录即
技能目录 `deliver-dual-audience-report/`。安装前核对 SHA-256（当前值见
[claude-code-handoff.md](claude-code-handoff.md) §1 的候选快照表）：

```bash
shasum -a 256 deliver-dual-audience-report-v0.2.1.zip
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
unzip deliver-dual-audience-report-v0.2.1.zip -d ~/.claude/skills/
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
2. 直接上传 `deliver-dual-audience-report-v0.2.1.zip`——Cowork 要求 ZIP 根即技能
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

**安装**：两个用户级目录都被 Codex 扫描，且都是现行受支持路径，按需要二选一。

| 目录 | 定位 | 何时选它 |
|---|---|---|
| `~/.codex/skills/` | Codex 自身的默认目录。其内置的 skill-installer 系统技能声明安装到 `$CODEX_HOME/skills/<skill-name>`（默认 `~/.codex/skills`），即 Codex 第一方工具今天的落点 | 只在 Codex 里使用本 Skill，或希望与 Codex 自带安装器保持一致 |
| `~/.agents/skills/` | 跨工具互操作目录，Kimi 也会自动发现（见 §6） | 希望一份安装同时服务 Codex 与 Kimi |

```bash
# Codex 默认目录
mkdir -p ~/.codex/skills
unzip deliver-dual-audience-report-v0.2.1.zip -d ~/.codex/skills/

# 或：跨工具互操作目录，与 Kimi 共用同一份安装
mkdir -p ~/.agents/skills
unzip deliver-dual-audience-report-v0.2.1.zip -d ~/.agents/skills/
```

项目级放 `<repo>/.agents/skills/`。不要在两个目录里同时放同名技能。

**调用**：会话中 `$deliver-dual-audience-report` 显式提及，或 `/skills` 浏览；
描述命中时隐式触发（`openai.yaml` 已允许隐式调用）。新装进上述任一目录的技能
即时可见，不需要重启；按技能开关写在 `~/.codex/config.toml` 的
`[[skills.config]]` 里，只有改这些开关才需要重启 CLI 生效。

**运行时注意**：

- 本地沙箱执行宿主二进制，默认**断网**——本 CLI 运行期零网络依赖，不受影响；
  但宿主 PATH 上需有满足 §2.2 的 node；
- **Codex 云端**镜像默认只带 Node 18/20/22：在环境 setup script（该阶段有网）中
  安装 Node 24，或接受在 Node 22 上运行（功能实测可用，见 §2.2）；
- Codex 会整段加载 AGENTS.md 而按需加载技能——不要把本 Skill 正文复制进
  AGENTS.md，写一行指引即可。

**实测记录**：2026-08-20（CLI 0.148）——`codex features list` 确认 `skill_search`
为 stable；安装副本通过固定版官方验证器；Node 24 下 init 冒烟通过。2026-08-24
（CLI 0.150.1）复核——`skill_search` 与 `skill_mcp_dependency_install` 均为
`stable`/`true`；`~/.codex/skills/` 与 `~/.agents/skills/` 各放一份技能后，同一次
`codex exec` 的技能清单里两者都出现；新装技能未重启任何进程即被列出（用于验证
的探针技能已清理）。

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

## 7. 更新已安装的技能（升级到新候选）

本节适用于本机或平台上已装有旧候选（例如 2026-09-02 的 0.2.0 构建）而要切换到
v0.2.1 候选 ZIP 的情形。各平台的安装机制沿用 §3–§6 的 2026-08-20/24 核对结果；
“替换已安装版本”这一动作本身未在本轮逐平台实测，凡属推断处均已标注。截至
2026-09-03，本仓库维护机上的 `~/.claude/skills/` 与 `~/.agents/skills/` 副本仍是
2026-09-02 的 0.2.0 构建，尚未同步到本候选；同步属安装动作，需用户授权后按本节执行。

### 7.1 通用检查清单（所有平台相同）

1. **先校验再安装**：`shasum -a 256 deliver-dual-audience-report-v0.2.1.zip`，与
   [claude-code-handoff.md](claude-code-handoff.md) §1 候选快照表一致后才继续；
2. **同一技能只保留一份**：先删除（或移走留档）旧技能目录，再解压新 ZIP；不要让
   同名技能同时出现在两个扫描目录，也不要让新旧版本并存；
3. **旧的生成视图仍可打开，但新 CLI 不再受理它**（2026-09-03 实测：用 0.2.0
   运行时渲染一份 W23 时期的 fixture，再用 0.2.1 CLI 处理它）：由 0.2.0 生成的
   `<base>_APPROVAL.html` 内嵌的是它自己的 0.2.0 工作台外壳，是自包含的离线工作台，
   升级后照样能在浏览器打开、把本轮审阅走完并导出回执；不会出现
   `META_IDENTITY_MISMATCH`。但 0.2.1 运行时只接受与自身一致的 generatorVersion
   （现为 0.2.1，DES-014 的无双轨规则）：对旧视图做 `validate delivery` 报
   `CSP_INVALID`（`/approval`、`/approval/csp`）；做 `--replace-generated` 除
   `CSP_INVALID` 外另报 `ARTIFACT_IDENTITY_MISMATCH`（`/approval/meta`）——原因是旧
   外壳的内联脚本/CSP 哈希与生成器 meta 都不同于当前运行时会生成的内容。处理：把旧
   视图移走留档，或在新的空目录全新 render（render 只创建不覆盖，目标已存在报
   `TARGET_EXISTS`），输入仍是未变动的 `review-document.json`（`review-document/1`，
   本轮协议面未变）；不要删除私有输出根目录下的任何内容；
4. **旧回执仍可对未变动的文档消费**：`review-packet/1` 回执绑定的是文档身份
   （id、title、contentVersion、round、reviewDigest），不绑定 APPROVAL.html 本身；
   用 0.2.1 重渲染未变动的 `review-document.json` 得到的 dar-review-digest、
   contentVersion 与 round 与 0.2.0 相同（只有 dar-generator-version 由 0.2.0 变为
   0.2.1），因此从旧视图导出的回执对该文档做 `validate packet` / `consume` 仍然有效。
   只有文档本身改了才需要重新审阅；
5. **验收**：平台技能清单只列出一份 `deliver-dual-audience-report`；
   `node <skills-dir>/deliver-dual-audience-report/scripts/review-delivery.mjs --help`
   能运行；如需确认落盘内容确为本候选，把安装目录内文件的 SHA-256 与
   `dist/deliver-dual-audience-report-v0.2.1.manifest.json` 的 `files` 条目逐一比对。

### 7.2 Claude Code

```bash
rm -rf ~/.claude/skills/deliver-dual-audience-report        # 或项目级 <repo>/.claude/skills/deliver-dual-audience-report
unzip deliver-dual-audience-report-v0.2.1.zip -d ~/.claude/skills/
```

技能目录热加载（§3）；“替换后当前会话即可见”按平台机制推断，未在本轮实测——若
清单仍显示旧描述，重开会话。验收时只输入 `/` 打开命令菜单、不要提交（提交
`/deliver-dual-audience-report` 会直接调用技能），在菜单里找到
`deliver-dual-audience-report` 条目，读其 description 是否与新 SKILL.md 一致，并确认
只有一份。企业/个人/项目三级若各有一份同名技能，按 §3 的优先级只会生效一份——升级
时把所有层级的旧副本一并清掉。

### 7.3 Claude Cowork（含 claude.ai）

1. 打开 **Customize → Skills**；若列表里仍有旧的 `deliver-dual-audience-report`，
   先在面板中移除它（面板移除入口按平台机制推断，未在本轮实测）；
2. 再按 §4 的路径 **＋ → Upload a skill** 上传新 ZIP；
3. 上传后核对面板显示的 description 与新 SKILL.md 一致；**code execution** 仍是前置。

同名技能上传时是否会自动覆盖旧版，本文不作断言（按平台机制推断，未在本轮实测）；
按上面“先移除、再上传、后核对”的顺序操作即可不依赖该行为。

### 7.4 OpenAI Codex（CLI / IDE / 云端）

在你当初使用的那一个目录里替换（§5：`~/.codex/skills/` 或 `~/.agents/skills/`），
且只保留一份：

```bash
rm -rf ~/.codex/skills/deliver-dual-audience-report          # 或 ~/.agents/skills/deliver-dual-audience-report
unzip deliver-dual-audience-report-v0.2.1.zip -d ~/.codex/skills/   # 与被删目录同一父目录
```

2026-08-24 的实测是“新装技能无需重启即被列出”（§5）；替换已有目录后是否同样
即时生效，按平台机制推断、未在本轮实测——若 `/skills` 清单仍显示旧描述，重启 CLI。
`~/.codex/config.toml` 的 `[[skills.config]]` 开关本轮无变化，不需要改。
**Codex 云端**：若你是在环境 setup script 里解压本 ZIP 落盘技能的，把引用换成
v0.2.1 后重新运行 setup，让环境重新落盘新技能（按平台机制推断，未在本轮实测）。

### 7.5 Kimi（Kimi Code CLI 与 Kimi Work）

**Kimi Code CLI**：与 §7.4 相同的目录替换——删掉旧目录（`~/.agents/skills/`、
`~/.kimi-code/skills/` 或 `extra_skill_dirs` 指向的目录，以你当初使用的为准）后解压
新 ZIP，只保留一份；用 `kimi doctor` 与技能清单确认。替换后的生效时机按平台机制
推断，未在本轮实测。

**Kimi Work**：在 Skills 面板移除旧技能后重新上传新 ZIP，并核对面板显示的描述
（面板行为按平台机制推断，未在本轮实测）。

## 8. 完整使用工作流（四平台一致）

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

## 9. 故障排查

| 症状 | 原因与处理 |
|---|---|
| `SYMLINK_REJECTED` | 路径含符号链接（macOS 的 `/tmp` 等）；改用真实绝对路径 |
| validate/replace 报 `CSP_INVALID`（`/approval`、`/approval/csp`） | APPROVAL.html 的 CSP 或内联脚本/样式哈希与当前运行时应生成的不一致——文件被手改，或出自另一版本的工作台外壳；不要手改产物，在新的空目录全新 render，旧产物留档 |
| CLI 对旧版本视图报 `CSP_INVALID`（`/approval`、`/approval/csp`），`--replace-generated` 另报 `ARTIFACT_IDENTITY_MISMATCH`（`/approval/meta`） | validate delivery 或 `--replace-generated` 指向的是上一版本（如 0.2.0）生成的视图，其外壳哈希与生成器 meta 与 0.2.1 运行时不一致；旧视图本身仍可在浏览器打开并走完本轮。把旧视图移走留档或在新的空目录用未变动的 review-document.json 全新 render（§7.1）；旧回执对未变动的文档仍可消费 |
| 工作台报 `META_IDENTITY_MISMATCH` | 载入工作台外壳的 payload/meta 出自另一生成器版本——只会发生在文件被手改或新旧文件被混拼时，CLI 正常生成的视图不会触发；不要手拼产物，用 review-document.json 重新 render |
| 回执被拒 | 回执与文档的 id/轮次/摘要不匹配，或内容被改动；从工作台重新导出 |
| 技能不出现（Codex） | 检查目录（`~/.codex/skills/` 或 `~/.agents/skills/`，两者都是现行受支持路径，见 §5），重启 CLI；`codex features list` 确认 skills 特性开启 |
| 技能不出现（Kimi） | `kimi doctor` 校验配置；确认目录或 `extra_skill_dirs` |
| Cowork 上传被拒 | 确认 ZIP 根即技能目录且 frontmatter 仅含规范字段（本发布物已满足；勿自行改包） |
| 产物字节与记录摘要不一致 | 检查 node 版本——可复现承诺仅限 Node 24（§2.2） |

## 10. 隐私与边界

- 真实业务内容只写入你授权的私有输出目录；APPROVAL.html/AGENT.md/回执都含业务
  正文，不要提交进公开仓库或上传到未授权服务；
- Cowork/Codex 云端会话中生成的产物存于对应平台的工作区，注意平台侧的数据边界；
- 技能授权的是"生成与校验"，不授权对外发布、执行外部系统操作或代替人拍板——
  四动作裁决永远属于审批人。
