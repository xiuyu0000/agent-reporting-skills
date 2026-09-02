# VIZ-001 · 审批 HTML 表达清晰度与可视化变更请求

> - 文档状态：**已获用户 2026-09-02 批准并实施**（W23 已完成；本文已纳入 [README.md](README.md) §1 索引）
> - 提出日期：2026-09-02
> - 提出依据：用户 2026-09-02 反馈（三条：表达不够直白/可视化不足、可视化格式缺陷、解释与表格的衔接缺陷）
> - 落地波次：W23（UI-008、UI-009、CTR-003、SKL-004、REL-009，任务卡见 [task.md](task.md) §5，波次记录见其 §9）
> - 影响判定结论：**不构成 [spec.md](spec.md) 需求条款变更**，因此未另立 ADR。实测确认 `docs/spec.md` 摘要在本轮前后完全一致（`2459bf72…8279124b`）
> - 红线执行结果：第 3.4 节四条红线全程成立，未越线
> - 交付偏差：第 6 节阶段 3 的第二个新节点 `matrix` **未实施**，原因是字节预算耗尽（见第 11 节），属红线 L3 下的取舍
> - 遗留发现：第 8 节记录一条**与本次反馈无关的既有契约/实现背离**，本轮未动，仍需用户单独裁决

---

## 目录

1. [需求描述](#1-需求描述)
2. [根因定位](#2-根因定位)
3. [是否影响整体需求契约的判定](#3-是否影响整体需求契约的判定)
4. [相关需求条款](#4-相关需求条款)
5. [对整体实现的修改](#5-对整体实现的修改)
6. [具体实施方案](#6-具体实施方案)
7. [验证与门禁](#7-验证与门禁)
8. [需用户单独裁决的既有缺陷](#8-需用户单独裁决的既有缺陷)
9. [未采纳项与理由](#9-未采纳项与理由)
10. [请您裁决的三点](#10-请您裁决的三点)
11. [实施结果](#11-实施结果)

---

## 1. 需求描述

用户在真实使用审批 HTML 后提出三条问题。下面按「用户原话 → 可验证的问题陈述」重述。

### R1 · 内容精炼但不直白，可视化不足

> 「内容上虽然做到了精炼，但是没有做到使用最直白的方式进行表达。把逻辑、流程和复杂的概念尽量通过可视化的方式来呈现。确保可以让一个人从 0 开始，完整、详细地理解全部的完整内容。整体内容的理解门槛较高，可视化也做得不够好。」

可验证陈述：一个零上下文读者打开审批 HTML，从头读到尾，应当能理解每一个决策块并作出判断。当前产出的文档要求读者在脑内重建顺序、分支与对比关系，理解门槛偏高。

**这是一条既有契约的合规缺口，不是契约缺口。** [spec.md](spec.md) §7.2 第 158 行已经以「必须」规定「判断所需的解释、对比、数据、流程和必要术语在同一文件内可见或可原地展开」；第 161 行以「应」规定「复杂关系应在确有帮助时使用内嵌、可访问的可视化」。W15 已经把直白语言写成强制规范（[audience-contracts.md](../skills/deliver-dual-audience-report/references/audience-contracts.md) 第 53 行「These rules are mandatory, not stylistic」），但规则**没有可判定的触发条件**，作者自认清楚即算合规。

### R2 · 可视化格式缺陷：流程图标签与箭头线重叠；可视化形式单一

> 「流程图的内容解释和箭头线重叠，从而导致整体内容表达不清。而且可能是对可视化的方式规定得太严格了，所以可视化方式比较单一，展示的内容也并没有特别直观。」

可验证陈述，拆成两条独立事项：

- **R2a 布局缺陷**：`flow` 图的边标签会与箭头线、其他标签、节点方框互相覆盖，且这是确定性发生的，不是偶发渲染问题。已用真实 CSS 与真实渲染算法复现，与用户截图逐处吻合。
- **R2b 表达力缺陷**：`ContentNode` 判别联合只有 7 个成员（paragraph / list / table / code / callout / steps / flow），其中只有 `flow` 一种图示。对比、阶梯、时间线、分支判断这些关系只能退化成表格或散文。

### R3 · 解释与表格的衔接缺陷：悬停定义被表格截断

> 「当解释的文字在表格靠上位置的时候，它整个悬浮的解释内容会被表格截断，导致展示不全。」

可验证陈述：术语（`termRef`）的悬停定义预览在表格靠上位置被容器裁掉，读者看不到完整定义。同一缺陷也出现在侧栏、折叠上下文区与流程图容器内。

---

## 2. 根因定位

三条问题分属三个不同的实现层，互不重叠。

| 问题 | 根因所在 | 定位 |
|---|---|---|
| R1 | Skill 写作规范层 | 规则有强制措辞但无可判定触发条件；写作阶段的读取门指向了错误的参考文件 |
| R2a | 渲染器几何层 | 固定二列网格布局 + 标签钉在线段中点，无任何避让 |
| R2b | 协议内容模型层 | `ContentNode` 联合成员不足；`FlowNode` 不携带任何布局语义 |
| R3 | 样式裁剪层 | 悬停提示是滚动容器内的绝对定位伪元素，被容器裁剪 |

### 2.1 R2a：布局是确定性冲突，不是渲染意外

[flow-renderer.ts:31-37](../src/workbench/flow-renderer.ts#L31) 按**数组下标**摆放节点，完全不读边集：

```ts
x = 180 + (index % 2) * 360
y = 64  + Math.floor(index / 2) * 120
```

因此列坐标只有 `{180, 540}` 两个值，行距固定 120。[flow-renderer.ts:104-105](../src/workbench/flow-renderer.ts#L104) 再把每条边的标签钉在线段中点上方 9px：

```ts
x = (startX + endX) / 2
y = (startY + endY) / 2 - 9
```

两者相乘，标签位置塌缩成一个**离散格点**：跨列边的 x 恒为 360，y = 55 + 120·r + 60·k（r 为起点行、k 为跨行数）。于是「两条边的标签像素级重合」的充要条件退化成 `2r₁+k₁ == 2r₂+k₂`，在稍多几条边时是常态而非例外。

已确认的冲突模式（每一条都能构造，且用真实算法复现）：

| 模式 | 触发条件 | 唯一的现有缓解为何无效 |
|---|---|---|
| 双向边标签完全重合 | 存在 `A→B` 与 `B→A` | 两个标签坐标相同，后者的 5px 白色描边把前者的字形**擦掉** |
| 不同节点对的标签落到同一格点 | `2r₁+k₁ == 2r₂+k₂`（如跨行边与下一行同行边） | 同上，互相擦除 |
| 标签被无关节点方框吞没 | 同列跨 ≥1 行的边 | 节点组在边层之后绘制（[:113](../src/workbench/flow-renderer.ts#L113) vs [:130](../src/workbench/flow-renderer.ts#L130)），`.flow-node{fill:#e3edfa}` 不透明，标签连同光晕一起消失 |
| 标签两端被跨列节点方框切掉 | 跨列标签宽度 > 80px 的列间隙（约 6 个中文字符） | 同上 |
| 后画的边线/箭头压在先画的标签上 | 任意两条边几何接近 | `paint-order:stroke` 只在**单个** text 元素内部重排填充与描边，对后绘制的兄弟元素无效 |
| 边自己的线穿过自己的标签 | 任意带标签的斜边 | 光晕在此有效，但它会在斜线上打出 5px 缺口，且光晕色 `#fcfcfb`（`--surface`）与图背景 `#f9f9f7`（`--page`）不同，缺口是可见的浅色斑块 |
| 两个自环占用同一列间隙 | 同一行两侧各有自环 | [:48](../src/workbench/flow-renderer.ts#L48) 让左右两列的自环都向**内**弯，互相穿插 |

另有两点会放大后果，一并记录：

- Schema 的 `edges` 既无 `uniqueItems` 也无 `minItems`（[review-document.schema.json](../skills/deliver-dual-audience-report/references/review-document.schema.json) `FlowGraphEdge`），[invariants.ts](../src/protocol/invariants.ts) 只查重复节点 id 与悬空引用。因此「同一对节点两条不同标签的边」——在缺少分支字段时表达 yes/no 分支的唯一手段——是合法输入，而它必然产生像素级堆叠。
- `viewBox` 固定 `0 0 720 …` 且 `.flow svg{width:100%}`。在 320 CSS px 页宽下整图缩放约 0.44 倍，`font:600 15px` 的标签有效字号约 6.6px。这与 [spec.md:520](spec.md) 的「在窄视口下保持可读」直接相关，任何更密的图都会加重它。

### 2.2 R3：滚动容器的垂直裁剪

[content-renderer.ts:56](../src/workbench/content-renderer.ts#L56) 把定义写进 `data-tip`，[:109](../src/workbench/content-renderer.ts#L109) 把表格包进 `div.scroll-region.table-region`。样式（[shell.ts:35](../src/workbench/shell.ts#L35)）：

```css
.scroll-region{max-width:100%;min-width:0;overflow-x:auto}
.term-ref{position:relative;display:inline-block}
.term-ref[data-tip]:hover::after{position:absolute;left:0;bottom:calc(100% + 6px);…}
```

按 CSS Overflow 规范，一个轴为非 `visible` 时，另一轴的 `visible` 计算为 `auto`。因此 `.scroll-region` **同时在垂直方向裁剪**。提示又固定向上展开（`bottom:calc(100% + 6px)`），表格靠上位置的术语，其提示整体落在容器内容盒之上，被完全裁掉。

同一裁剪上下文还包括：`.rail{overflow:auto}`（侧栏）、`.context-fold{overflow:hidden}`（折叠上下文/证据区）、`.flow{overflow:hidden}`（流程图容器）。另有两个与滚动容器无关的失败位：`left:0` 锚定使 34ch 宽的提示在窄容器右侧溢出，而 `body{overflow-x:hidden}` 会吃掉它；靠近粘性 header 的术语其提示会被 header 盖住。

已实测的关键事实（Chrome 148，用逐字提取的真实 `WORKBENCH_STYLE`）：

- `overflow-y:clip` + `overflow-clip-margin` **无效**：一轴为滚动值时 `clip` 计算为 `hidden`，且 `overflow-clip-margin` 对滚动容器定义为无效果。裁剪量与基线完全一致。
- 仅把方向从向上翻成向下（`bottom:…` → `top:…`）**严格优于现状**：向下溢出会撑高 `scrollHeight`（236 → 265）从而可滚动到，向上溢出则永久不可达。这是一处约 10 字节、零 JS、零浏览器兼容风险的止血改动，但不解决右缘与 320px 情况。
- 完整解法只有「让提示脱离裁剪祖先」一类：`popover`（top layer）或 JS 定位的 body 级单例。CSS anchor positioning **不能**作为机制——它在 2026 年仍是 Chromium-only，而本仓库门禁跑 Chromium / WebKit / Firefox 三引擎。

顺带确认一条与本次反馈无关但同源的既有缺陷：当前提示 `pointer-events:none` 且无 Esc 关闭，不满足 WCAG 2.1 SC 1.4.13（Hoverable / Dismissible）。axe-core 没有该项自动规则，所以现有门禁一直通过。修复 R3 时应顺手闭合，而不是复制它。

### 2.3 R1：规范有强制措辞，但没有触发条件

[audience-contracts.md](../skills/deliver-dual-audience-report/references/audience-contracts.md) 已有的规则（第 53–71 行）在措辞上是强制的，失效点有四处：

1. **无可判定触发条件**。「Express logic … as structured content … rather than as long prose」没有定义什么算 long prose，作者自认已结构化即合规。
2. **`flow` 被写成许可上限**。「Use a controlled flow **only when** it makes a relationship materially easier to judge」是一句天花板，不是触发条件；配合 R2b 的单一图种，作者默认不画。
3. **术语规则在最需要的字段上structurally 不可满足**。`title`、`summary`、`whyTier`、`ask`、`objective`、`scope`、`constraints`、`risks`、`openQuestions` 都是纯字符串，**不能**承载 `termRef`。而 `ask` 正是审阅者必须回答的那句话。规则没有说明这条边界，也没有给出绕行办法（把术语放进 `body` 并让这些字段保持无行话）。
4. **阶段门指向了错误的文件**。[SKILL.md:16-17](../skills/deliver-dual-audience-report/SKILL.md#L16) 把 `audience-contracts.md` 归到「**检查**两个产物与跑读者隔离测试之前」读；而写合同的第 3 步（[SKILL.md:59-88](../skills/deliver-dual-audience-report/SKILL.md#L59)）只链接三份 Schema 与 Agent 上下文模板。全部直白语言规则住在前者。**作者按阶段门走完整个写作过程都不会读到管辖写作的规则**，等到验证阶段才读到，此时重写代价最高。这是 R1 单条影响最大的机制性原因。

此外：`FlowNode` 的 `title` 与 `description` 都是必填，`description` 是读者对这张图唯一的散文说明，但 Skill 全文没有任何一行提到 `description` 该写什么，也没说节点 `label` 是面向读者的。文字替代当前输出的是 `A: 标签` 与 `A → B` 这种 **id 形式**（[flow-renderer.ts:145,154-156](../src/workbench/flow-renderer.ts#L145)），对零上下文读者不可读；而 [design.md §11.2](design.md) 与 [§7.3](design.md) 规定的是由「title、description、节点标签和边关系」构成——**当前实现已与设计记录背离**，这一条属于既有一致性缺陷，不是新增改进。

### 2.4 R2b：表达力缺口清单

对零上下文读者所需的解释形态，逐一核对现有节点能否承载：

| 解释任务 | 现状承载 | 退化程度 |
|---|---|---|
| N 个方案 × M 个准则的对比并给出推荐 | `table` | 没有方案身份，没有结论通道；**推荐指向不存在的方案时无法被检出** |
| 现状 / 拟议 对照 | `table` 两列 | 可用，但对照关系不是结构，只是约定 |
| 分支判断（条件 → 两个以上结果） | `flow` | 缺 `kind` 字段，yes/no 分支无身份，两条同源边标签必然堆叠（见 2.1） |
| 有序时间线 / 波次与依赖 | `steps` | 无时间、无负责人、无状态、无步间依赖 |
| 强弱阶梯 / 光谱（用户第三张截图正是此形态） | `table` | 只有行序，没有轴、没有方向、没有量级 |
| 包含层级 | `list` | 单层；`steps`/`callout` 内只允许 paragraph/list/code，不能嵌套 |
| 数量与占比 | 纯文本 | 无 |
| 状态机 | `flow` | 同分支判断 |
| 带注解的示例 | `code` + 散文 | 注解与行无机器关联 |
| 定义 + 反例 | `GlossaryEntry.definition` 一个字符串 | 反例只能塞进定义里，把悬停提示撑长 |

---

## 3. 是否影响整体需求契约的判定

### 3.1 判定方法

[spec.md:14](spec.md)（§1）把全部 CSS 数值与页面 DOM 排除出需求契约，然后**只**重新纳入一个孤岛：§7.2 引用的审批工作台视觉契约，其规范性清单由 [design.md](design.md) DES-019 与 §11.8 维护。因此判定规则是机械的：

> 被改动的东西，是否被 [design.md](design.md) §11.8（第 1400–1406 行）枚举，或被 [spec.md:162/164](spec.md) 的阅读顺序句子枚举？
> 是 → 需求变更；否 → CSS/DOM，属设计层或以下。

同时受 [spec.md:673](spec.md)（§18.2）约束：不得静默扩展 spec 未定义的**产品能力**。

### 3.2 逐项判定

| # | 候选改动 | 判定 | 决定性条款 |
|---|---|---|---|
| c1 | 重写 `flow` 布局算法消除重叠 | **A 缺陷修复** | 边标签几何不在 §11.8 枚举内；[spec.md:14](spec.md) 已排除 CSS/DOM |
| c2 | 消除悬停提示被裁剪 | **A 缺陷修复** | 定义的文件内载体是术语表附录（[spec.md:159](spec.md)、[design.md §11.3](design.md)），悬停仅为补充，故属可用性缺陷 |
| c3 | 给 `FlowNode` 增加可选布局字段 | **B 设计层**；若改为从 `edges` 推导则降为 **A** | spec 全文不出现 `review-document`；但 [design.md §7.1](design.md) 禁止在 `/1` 封闭对象增字段 |
| c4 | 新增 `ContentNode` 成员 | **B 设计层** | [design.md §13.2](design.md) 明文把它定为扩展点并列出四项义务；spec §8.2/§8.3 不枚举节点种类 |
| c5 | 收紧 Skill 写作规范 | **A**，但有一处措辞陷阱 | W15/UI-006 先例：新增强制写作规则**未改 spec** |
| c6 | 改任一 `:root` 调色板 token 或 1280/340 布局常量 | **C 需求变更** | [spec.md:14](spec.md) + [:165](spec.md) + [design.md §11.8](design.md) |
| c7 | 提高工作台字节门 | **C 需求变更**（见 3.4 与第 8 节） | [design.md §11.8](design.md) 把字节门列为 §11.8 不变式，改它即改 §11.8 |
| c8 | 改变阅读顺序（如在决策块之前加总览区） | **C 需求变更** | [spec.md:162](spec.md) + [:164](spec.md) + [:165](spec.md) |

### 3.3 结论

**本次三条反馈的修复方案全部落在 A 与 B，不构成 [spec.md](spec.md) 需求条款变更。因此不另立 ADR，本文即为待审文档。**

三条支撑理由：

1. **R1 是合规缺口，不是契约缺口。** [spec.md:158](spec.md) 的「必须」与 [:161](spec.md) 的「应」已经要求了用户想要的东西。「应」在本文 §1 的规范词表里是「默认要求；只有存在明确、可解释的例外时才能偏离」——一个本该可视化却没有可视化的复杂块，**今天就已经不合规**。修复是让规范可执行，不是新增要求。
2. **R2a、R3 是渲染缺陷。** 两者改的都是不在 §11.8 枚举内的几何，不动任何 token、任何布局常量、任何阅读顺序。
3. **R2b 的节点扩展是设计层。** spec §8.2 只要求「按叙事顺序排列的决策块」，§8.3 只要求「足以完成判断的正文」——**spec 从不枚举节点种类**。节点分类学住在 [design.md](design.md) §7.3 与公共 Schema。[design.md §13.2](design.md) 更是直接把 `ContentNode` 写成扩展点并规定了扩展义务（Schema、renderer、a11y 文本、正反夹具、浏览器测试），[design.md](design.md) §16 风险表也写着「扩展需新节点流程」。而 [spec.md:161](spec.md) 已在行为层授予了「内嵌、可访问的可视化」这项能力，新增节点是**实现一项已授予的能力**，不是 §18.2 所禁止的「静默扩展未定义的产品能力」。

### 3.4 四条红线：越过即变成需求变更

实施必须全程留在线内。任一条被触碰，都必须停下并按 [spec.md:165](spec.md) 先取得用户批准、按 §18.2 完成影响审计。

| 红线 | 具体含义 | 本方案的规避方式 |
|---|---|---|
| **L1 调色板与布局常量** | 不新增、不修改任何 `:root` token；不动 `max-width:1280px` 与 `340px` 侧栏 | 新可视化只复用既有 token 与 `color-mix()` 组合（W15 给表格加表头强调与斑马纹正是这么做的）。`flow` 自己的硬编码色（`#e3edfa`/`#1c4f8f`/`#6f6e69`）不在 §11.8 清单内，可动 |
| **L2 阅读顺序** | 不在决策块之前插入任何新区块；不改折叠默认态 | 放弃「总览/心智模型区」这一诱人但越界的方案（见第 9 节） |
| **L3 字节门** | **不提高** `WORKBENCH_SIZE_LIMIT_BYTES` | 全部改动必须装进现有余量 **23,583 字节**（实测 369,633 / 393,216）。这是本方案的硬预算，直接决定了第 6 节的分期 |
| **L4 规则形状** | 写作规则只能强制**结构**，绝不能强制**图** | [spec.md:161](spec.md) 后半句「不要求每个复杂块强制配图」精确禁止的是「∀ 复杂块 → 含图」这一种规则形状。注意措辞不对称：禁的是「配图」，而正面义务说的是「可视化」，现有规则说的是「structured content — steps, tables, or a flow」。**steps 与 table 不是配图。** 每一条新规则都要过一道检查：「合规的作者是否仍然可以交付一个没有图的复杂块？」答案为否即越线 |

### 3.5 一处仍需用户裁决的层级歧义

c3/c4 在 `/1` 协议内做加法，与 [design.md §7.1](design.md) 的「`/1` 的封闭对象不得增加字段；任何字段新增都发布新的协议版本」存在张力：

- 该句**逐字**禁止的是「增加字段」。`ContentNode` 是判别联合，新增联合成员在文本上不等于给封闭对象增字段，因此 c4 处于文本歧义区。
- 已核实的实际行为：`ContentNode` 是 `oneOf`，每个成员 `additionalProperties:false`。因此**旧的 `/1` 校验器面对未知 `type` 会在每个分支上失败，整体失败关闭**——不会误读，只会拒收。风险是**向前**的版本偏斜，不是向后不兼容。
- 具体偏斜面：发布 ZIP 自带一份 digest 钉死的 `references/review-document.schema.json`（26,325 字节，见 `dist/…manifest.json`）。升级后的 Skill 写出的文档，在 v0.2.0 运行时下不通过校验。
- 由于 Skill 与其运行时**同一个 ZIP 一起发布**，混版使用本就不在支持路径内。

**建议**：在 `/1` 内做加法，并在发布说明中显式声明偏斜；同时把这条判断作为一条 DES 记录写入 [design.md](design.md)，而不是留在代码里。**若您认为必须走 `/2`，请在审核时指出——目前仓库不存在 `review-document` 的迁移机制**（[migration.ts](../src/protocol/migration.ts) 只处理 `prototype-v1` 的 packet/state 规范化，从不遍历内容节点），走 `/2` 会把本次工作量放大一个数量级。

---

## 4. 相关需求条款

实施必须持续满足下列既有条款；本方案不修改其中任何一条。

| 条款 | 内容 | 对本方案的约束 |
|---|---|---|
| [spec.md:158](spec.md) §7.2 | 判断所需的解释、对比、数据、流程和必要术语在同一文件内**可见或可原地展开** | R1 的「必须」级依据；也说明折叠区是被允许的形态 |
| [spec.md:159](spec.md) §7.2 | 悬停提示只能补充说明，不能承载判断所必需的信息 | R3 修复后，提示仍不得成为定义的唯一载体 |
| [spec.md:161](spec.md) §7.2 | 复杂关系**应**在确有帮助时使用内嵌、可访问的可视化，不要求每个复杂块强制配图 | R1/R2b 的正面授权 + L4 红线 |
| [spec.md:518](spec.md) §13.5 | 颜色始终伴随文字、图标或形状，不以颜色作为唯一含义 | 任何新图示的语义必须同时走文字/形状通道 |
| [spec.md:520](spec.md) §13.5 | 窄视口下保持可读且不产生页面级横向滚动 | 320px 下图示必须仍可读（当前 `flow` 已接近失守，见 2.1） |
| [spec.md:521](spec.md) §13.5 | 对有实际信息作用的图示提供等价文字说明 | 每个新节点必须有确定性生成的文字替代 |
| [spec.md](spec.md) §13.3/§13.4 | 不可信内容惰化；不加载任何外部资源 | 渲染器构造元素，绝不接受作者提供的 SVG/HTML 字符串；无图标字体、无外部雪碧图 |
| [spec.md:604](spec.md) | 非目标：跨轮次可视化差异比较 | 不得新增任何以跨轮次视觉 diff 为目的的节点 |
| [design.md §11.3](design.md) §11.3 | 宽表和代码**只**允许在自身可聚焦容器内横向滚动 | R3 修复**不得**移除 `.table-region` 的 `overflow-x:auto`；同时意味着给流程图单独加滚动容器属于 §11.3 修订，不是自由实现选择 |
| [design.md §11.2](design.md) / [§7.3](design.md) | flow 文字替代由 title、description、节点标签与边关系构成 | 当前实现输出 id，已背离；本方案顺带修正 |
| [design.md §13.2](design.md) §13.2 | 新增节点必须同时增加 Schema、renderer、a11y 文本、正反夹具和浏览器测试 | c4 的四项强制义务 |
| [task.md:1379](task.md) §7 | 写 `docs/design.md` 后触发**全局影响审计** | c3/c4 落地时必须执行 |

---

## 5. 对整体实现的修改

### 5.1 受影响模块清单

| 模块 | 改动性质 | 关联问题 |
|---|---|---|
| [src/workbench/flow-renderer.ts](../src/workbench/flow-renderer.ts) | 重写布局与标签放置；修正文字替代改用 label | R2a、R1 |
| [src/workbench/shell.ts](../src/workbench/shell.ts) `WORKBENCH_STYLE` | 悬停提示改为不被裁剪；`flow` 新增几何相关类 | R3、R2a、R2b |
| [src/workbench/content-renderer.ts](../src/workbench/content-renderer.ts) | `termRef` 接线到新提示机制；新增节点的渲染分支 | R3、R2b |
| [src/workbench/interactions.ts](../src/workbench/interactions.ts) | 提示的显示/隐藏/重定位/Esc 关闭 | R3 |
| [src/workbench/i18n.ts](../src/workbench/i18n.ts) | 新节点的 zh-CN / en 文案（穷尽性由 `tests/unit/i18n.test.ts` 断言） | R2b |
| [src/generators/markdown.ts](../src/generators/markdown.ts) | 新节点的 Agent Markdown 等价渲染 | R2b |
| [src/protocol/invariants.ts](../src/protocol/invariants.ts) | 新节点的跨字段不变量；`flow` 重复边检测 | R2b、R2a |
| **[src/cli/validate/document-content.ts](../src/cli/validate/document-content.ts)** | **易漏点**：[:64-69](../src/cli/validate/document-content.ts#L64) 的终结 `else` 分支**默认节点是 flow**，直接读 `node.title/description/nodes/edges`。新节点若不登记会落进该分支并同时逃过内部链接检查与占位符检查 | R2b |
| `references/review-document.schema.json` | 新增 `$defs` 与联合成员 | R2b |
| `src/protocol/schema.generated.ts` / `schema.browser.generated.ts` / `types.generated.ts` | 由 `tools/generate-schema-*.mjs` 重新生成 | R2b |
| [SKILL.md](../skills/deliver-dual-audience-report/SKILL.md) | 写作阶段交叉链接直白语言规则（修 2.3 第 4 点） | R1 |
| [references/audience-contracts.md](../skills/deliver-dual-audience-report/references/audience-contracts.md) | 形式选择表、可数触发条件、termRef 字段边界、读者隔离问题集 | R1 |
| `tests/unit/**`、`tests/browser/**`、`tests/fixtures/**` | 回归与新断言 | 全部 |
| `dist/**`、[docs/claude-code-handoff.md](claude-code-handoff.md) | 候选 ZIP 重切与摘要回填 | 全部 |

### 5.2 现有测试构成的回归面

这些断言会因本次改动而失败或必须重新协商，需要在实施时逐条处理：

| 断言 | 位置 | 处理 |
|---|---|---|
| `.flow-arrow` 数量 == 3、`.flow-loop` 数量 == 1 | `tests/browser/workbench-render.spec.ts:288-289` | **保持**：每边一个箭头、自环仍出 `path.flow-loop` |
| `.flow-alternative` 含 `A → B` | 同上 `:290` | **需重新协商**：文字替代改用 label 后不再出现 id 形式 |
| 自环 `d` 含 `"M 400"` / `"C 330"` | `tests/unit/content-renderer.test.ts:601-602` | **必然失败**：这两行硬钉了旧几何，布局重写即破。改为几何不变量断言（如「自环不与任何节点方框相交」） |
| `polygon.flow-arrow` 共 4 个且 `points` 互不相同 | 同上 `:597-599` | 保持 |
| `a.term-ref` 仍有 `data-tip` 属性 | `tests/browser/workbench-render.spec.ts:295` | **保持**：新提示机制必须继续以 `data-tip` 为数据源 |
| `.table-region` 的 `tabindex == 0` | 同上 `:320` | 保持 |
| 320px 下 `body` 无横滚 **且** `.table-region` 内部有横滚 | 同上 `:530-534` | **这是 R3 的直接张力**：不能靠删掉 `overflow-x:auto` 解决 |
| 17 个调色板 token 逐值相等；`340px`/`1280px` | 同上 `:400-418`、`:492-493` | L1 红线的自动守卫 |
| axe 零 critical/serious（Chromium + WebKit） | 同上 `:496-503` | 新图示文字对比度、提示对比度必须达标 |
| 单元测试用手写 `MiniDocument` 桩，**无 `getBBox`、无 `getComputedTextLength`、无布局** | `tests/unit/content-renderer.test.ts:34-320` | **约束设计**：新布局引擎必须纯算术计算几何（字符计数 + 固定度量），不得依赖浏览器测量 |

### 5.3 体积预算

| 项 | 字节 |
|---|---|
| 上限 `WORKBENCH_SIZE_LIMIT_BYTES` | 393,216 |
| 当前实测 shell | 369,633 |
| **可用余量** | **23,583** |

这是 L3 红线下的硬预算。粗估：R3 的 popover 单例 ≈ 0.9–1.4 KB，R2a 的分层布局引擎 ≈ 3–5 KB，每个新 `ContentNode` 种类（渲染器 + i18n + 不变量 + 浏览器校验器）≈ 3–5 KB。**余量装不下「两个新节点 + 布局重写 + 提示重做」的全集**，因此第 6 节按优先级分期，并在每期结束时实测复核。

---

## 6. 具体实施方案

分四期。每期独立可交付、独立可回滚，前一期的字节实测决定后一期的可行范围。

### 阶段 1 · W23-A：格式缺陷修复（R2a + R3）

只改渲染与样式，不动协议、不动 Schema、不动 Skill 文本。

**任务 UI-008 · 流程图布局与标签避让**

1. 用**分层布局**替换下标网格：从 `edges` 做最长路径分层（层内按首次出现顺序稳定排序），得到 rank；同 rank 内横向排开。默认竖向流，节点数少且链式时可退化为横向。全部几何纯算术计算——单元测试的 DOM 桩没有测量能力（5.2）。
2. 边路由：同层反向边（`A→B` 与 `B→A`）走**对称偏移的弧**而非重合直线；跨层边绕开中间节点的包围盒。
3. 标签放置：改为**沿线法向偏移**（当前只有 y 向偏移，对竖直边等于把字压在线上），并做一趟贪心避让——候选位按「线中点法向 → 沿线滑动 ±」枚举，与已占用矩形、节点包围盒求交，取首个无交位；仍无解时把该标签降级进文字替代并在图上标编号。
4. 标签底板改为与图背景同色的实心 `rect`（`--page`，而非现在与 `--surface` 不匹配的描边光晕），彻底消除浅色斑块与字形互擦。
5. 自环：左右两列不再都朝内弯；朝外弯并按行错开。
6. 文字替代改用 `node.label` 与标签句子，去掉 id 形式——这同时修正 [design.md §11.2](design.md)/[§7.3](design.md) 的既有背离。
7. 窄屏可读性：`viewBox` 宽度随实际布局宽度计算而非恒定 720，并给标签设最小有效字号下限。

**任务 UI-009 · 悬停定义不再被裁剪**

1. 采用 **body 级单例 + `popover`**：一个 `<div popover="manual">` 在 bootstrap 时创建一次，`mouseenter`/`focusin` 时从 `term.getBoundingClientRect()` 计算位置，`showPopover()` 显示。top layer 不被任何祖先 overflow 裁剪。
   - **不**使用 CSS anchor positioning——Chromium-only，本仓库跑三引擎。定位用 JS 算。
   - 保留 `a.term-ref` 上的 `data-tip` 属性作为数据源（`workbench-render.spec.ts:295` 依赖它）。
   - 保留 `.table-region` 的 `overflow-x:auto` 与 `tabindex=0`（`:320`、`:530-534`、[design.md §11.3](design.md)）。
2. 位置策略：优先向下（块末溢出可滚动到，块首溢出不可达），空间不足则翻上；水平方向对 `documentElement.clientWidth` 做钳制。祖先滚动与 `resize` 时重定位或隐藏。
3. 顺带闭合 WCAG 2.1 SC 1.4.13：提示可悬停（去掉 `pointer-events:none`）、Esc 可关闭。**Esc 处理器不得吞掉块级 Esc 契约**（[design.md](design.md) §11.8 键盘不变式）。
4. 保持 [spec.md:159](spec.md)：提示仍只是补充，术语表附录仍是文件内载体，点击仍跳附录。
5. **落地前的止血选项**：若阶段 1 需要先出一版，可先只做 `bottom:` → `top:` 的方向翻转（约 10 字节，零 JS，零兼容风险，实测严格优于现状），再在同一期内完成完整方案。

**验收**：用户三张截图的场景逐一复现并确认消除；三引擎全绿；字节实测并记录余量。

### 阶段 2 · W23-B：写作规范可执行化（R1）

纯 Skill 文本 + 测试，无代码、无 Schema、无需求变更。逐条对照 L4 红线检查措辞。

1. **修复阶段门**（2.3 第 4 点，单条收益最高、成本最低）：在 [SKILL.md](../skills/deliver-dual-audience-report/SKILL.md) 第 3 步「Build the authoritative review document」交叉链接 `audience-contracts.md` 的直白语言小节，使写作阶段就读到管辖写作的规则。
2. **形式选择表**：把 `flow` 的许可上限改写成正面触发条件，按关系类型指定节点种类——≥3 个有序动作 → `steps`；≥2 方案 × ≥2 准则 → 对比节点/`table`；分支或 ≥3 个具名事物间的依赖链 → `flow`（且 `description` 必须写**结论**而不是描述图长什么样）；单条后果警告 → `callout`。**表中不出现「必须配图」**。
3. **可数触发条件**：「一个决策块的 body 若只由 `paragraph` 与 `list` 构成，且正文合计超过 N 显示列，属写作缺陷，须重构为 `steps`、`table` 或 `flow`」。N 复用仓库已有的显示列口径（`review-protocols.md` 已用 32/80 显示列，协议侧已有 `TEXT_WIDTH_EXCEEDED`）。这条**只强制结构，不强制图**，因此留在红线内，且是唯一一条日后可以真正做成校验器的规则。
4. **术语字段边界**：明确写出 `title`/`summary`/`whyTier`/`ask`/`objective`/`scope`/`constraints`/`risks`/`openQuestions`/`nextActions` 是纯字符串、不能承载 `termRef`，因此这些字段必须无行话；需要定义的术语放进 `body`/`currentState`/`facts`/`decisions`。
5. **`flow` 两个必填字符串的写法**：`description` 写这张图的结论，`label` 面向读者、不是块 id 或内部代号。
6. **读者隔离检查给出问题集**：(a) 一句话说明整体在决定什么；(b) 每个 T2 块复述 `ask` 并说明答「是」与答「否」各会发生什么；(c) 列出你无法从本文件定义的术语；(d) 列出你读了两遍的块。任何未答项都是合同缺陷，须修复后重渲染。把结果记入 `continuation.validationEvidence`。诚实标注：这把私下自评变成可复核的记录，**不是**自动门。
7. **配套示例**：新增一份写作示例参考文件，对 `steps`/`table`/`flow`/`callout`/`termRef` 各给一组「Agent 自然会写的散文 → 应当变成的结构」对照。挂在 `SKILL.md` 的阶段读取门下，不内联进 `SKILL.md` 主体（主体须保持低上下文成本，且有 500 行上限）。
8. **用回归测试钉住**：在 `tests/unit/skill-workflow.test.ts` 现有的正则断言组里为每条新规则加一条，使日后编辑不会静默丢失它们——这是让前七项持久化的唯一手段。

> 新增参考文件会连带触碰 `tools/release-build.mjs` 的 `SKILL_FILES` 清单与 `tests/unit/claude-handoff.test.ts` 里硬钉的 `entryCount: 11`；实施时一并更新。

### 阶段 3 · W23-C：内容模型扩展（R2b）

按余量决定做多少。**必须先完成阶段 1 并实测字节，再决定本期范围。**

优先级 0（若余量允许，本期只做这两项）：

- **`FlowGraphEdge.kind?`**（`then`/`yes`/`no`/`else`）：分支身份。这是 R2a 的**根因级**修复杠杆——有了分支身份，渲染器才能把 yes/no 确定性地放到源节点两侧，而不是都堆在线段中点。
- **`FlowGraphNode.kind?`**（`start`/`step`/`decision`/`end`）：驱动形状**并**在文字替代里输出对应词，保证形状不是唯一通道（[spec.md:518](spec.md)）。

优先级 1：

- **`scale` 节点**（有序阶梯 / 光谱 / 占比三合一）：直接回应用户第三张截图那种「载体按强制力弱→强排成一梯」的形态。字段 `title`/`description`/`axis{lowLabel,highLabel}`/`items[{label,position:0..100,display?,note?}]`，渲染为受控 SVG，文字替代按 `flow` 现有的 `<details>` 模式确定性生成。渲染器**不做**数字或本地化格式化，`display` 由作者给出，以保持输出字节确定。
- **`matrix` 节点**（N 方案 × M 准则 + 可选推荐）：`recommended` 指向 `options[].id`，使「推荐指向不存在的方案」可被不变量检出——这是 `table` 结构上做不到的。渲染进现有 `div.scroll-region.table-region`，因而自动继承阶段 1 的 R3 修复。

优先级 2（本期大概率不做，登记备查）：`outline`（有界深度包含层级）、`StepItem` 可选 `when`/`owner`/`status`/`dependsOn`、`GlossaryEntry` 可选 `example`/`counterExample`、`annotatedExample`。

每一项都必须履行 [design.md §13.2](design.md) 的四项义务，并且：

- 在 [document-content.ts](../src/cli/validate/document-content.ts) 登记（否则落进 flow 的终结 `else` 分支，同时逃过两项 CLI 检查）；
- 在 [design.md](design.md) 补 DES 条目与 §7.3 节点表行，并按 [task.md:1379](task.md) 执行全局影响审计；
- 顺带给 `flow.edges` 加重复边检测（2.1 末段）。

### 阶段 4 · W23-D：收口

- REL-009 候选重切：`src/workbench/**`、`skills/**`、Schema 任一变动都会改变分发字节，CI 会 `git diff --exit-code` 校验 `dist/`，**重新生成的 ZIP 与 manifest 必须在同一 PR 内提交**。
- 回填 [claude-code-handoff.md](claude-code-handoff.md) §1 摘要表与 §6.2 预检块；同步 `tests/unit/claude-handoff.test.ts` 的两个摘要常量（该测试会在 ZIP 字节一变、文档还没改时立刻失败）。
- [task.md](task.md) 新增 W23 波次行、任务总表行、任务卡与 §9 日期记录；[README.md](README.md) §1 索引行（含**本文的登记行**）与 §3 波次条目。
- 若本轮触碰 [design.md](design.md)：重算 design SHA-256 回填 [task.md](task.md) 文首与 handoff §1。spec 不变，spec 摘要不动。
- 公开树隐私复扫；`git diff --check`；PR base 为 `codex/v0.2.0`，随后 `-s ours` 同步 `main`。

---

## 7. 验证与门禁

全量门（每期结束都要跑）：

```bash
npm run build && npm run typecheck && npm run lint && npm run check:generated && npm run test:unit && npm run test:e2e && npm run test:acceptance && npm run test:browser && npm run check:bundle-size && npm run check:acceptance-coverage && npm run scan:legacy-surface && npm run verify:dist
```

针对本次的专项证据：

1. **变异验证**：每个缺陷修复都要有一条「回退修复即失败、恢复即通过」的断言。R2a 用几何不变量（标签矩形两两不相交、标签不与节点包围盒相交、标签不与非自身边线相交）；R3 用「首行术语的提示矩形完整落在视口内且不被任一祖先裁剪」。
2. **三引擎**：R3 的定位是命令式几何代码——正是本项目 WebKit 平滑滚动竞态那一类风险的高发区。必须有真实三引擎断言，单元测试不算数。
3. **字节门**：每期结束记录 `实测/393216` 与剩余余量。**任何一期把余量耗尽都必须停下来找我**，不得自行提高上限（L3）。
4. **无障碍**：axe 零 critical/serious；新图示颜色不作为唯一语义通道；320px 下可读且页面无横滚。
5. **零上下文复读**：用阶段 2 的问题集，对修复后的真实文档做一次读者隔离，作为 R1 是否达成的判据。
6. **A01–A22 覆盖**：`check:acceptance-coverage` 须保持 22/22。若新增行为需要新的验收编号，那意味着动了 spec §14.2 的验收表——**那是需求变更，停下来找我**。

---

## 8. 需用户单独裁决的既有缺陷

**与本次三条反馈无关，是审计过程中发现的既有契约/实现背离。本文不擅自修复，请单独裁决。**

工作台字节门的**契约值与实现值不一致，且已持续存在**：

- 实现值：`393216`（[tools/build-workbench.mjs:28](../tools/build-workbench.mjs#L28)、[src/generators/approval.ts:21](../src/generators/approval.ts#L21)，以及发布运行时里的 `Jm=393216`）。
- 契约值：[design.md §11.8](design.md) 的 §11.8 不变式仍写「`358400` 字节门不因视觉系统而放宽」。
- 成因：W11/UI-005 把上限从 358400 提到 393216（[task.md:1194](task.md) 有明确记录），但 W13/DOC-002 在把 §11.8 固化成契约时抄的是旧数字。
- 波及面比初判更广，共 **8 处**：[design.md §6.1](design.md)、[§6.1](design.md)、[§11.1](design.md)、[§11.1](design.md)、[§11.8](design.md)、[§13.1](design.md)、[§16](design.md)，以及 [task.md:1386](task.md)。

**为什么必须由您裁决**：[design.md §11.8](design.md) 规定「实现与本节不一致时**以本节为准并停下澄清**」。按字面，当前状态是一个长期存在的「停下澄清」条件。而修正 [§11.8](design.md) 就是修改 §11.8 的不变式条目，[spec.md:165](spec.md) 把「视觉契约的任何变化」定为需求变更——**因此这条订正本身可能需要 ADR**，尽管它只是把文档改成与已实施、已批准的事实一致（与 2026-08-19 的 §7.2 修订同一性质）。

**建议**：作为一条独立的文档订正处理，与 W23 分离，不与本次功能改动捆绑。本方案在 L3 下**不依赖**这条订正——全部改动装进现有 23,583 字节余量。

---

## 9. 未采纳项与理由

| 方案 | 为何不采纳 |
|---|---|
| 在决策块之前加一个「总览 / 心智模型」区 | 对 R1 收益最大，但改变阅读顺序，是 [spec.md:162/164](spec.md) 明文规定的需求变更（L2）。如果您认为值得，我另写 ADR |
| 恢复 W17 之前的「块内展开定义」按钮 | 技术上最干净地消除 R3，但那是 2026-08-20 您亲自要求去掉的设计。反转需要您的明确批准，不能作为缺陷修复夹带 |
| `overflow-y:clip` + `overflow-clip-margin` | 已实测无效：一轴为滚动值时 `clip` 计算为 `hidden`，且 `overflow-clip-margin` 对滚动容器无效果，裁剪量与基线完全一致。只对 `.context-fold` 那种纯 `overflow:hidden` 的容器有效 |
| 把滚动移到内层包装元素 | 无效。承载 `overflow-x` 的元素无论内外都是术语的祖先，裁剪盒只是平移几像素 |
| 纯 CSS anchor positioning 定位提示 | 2026 年仍是 Chromium-only；本仓库门禁跑 Chromium/WebKit/Firefox 三引擎 |
| 提高字节门以容纳更多可视化 | L3 红线。改 [design.md §11.8](design.md) 即改 §11.8 不变式，触发 [spec.md:165](spec.md) 的需求变更程序 |
| 单独的 decision-tree / state-machine / timeline 节点 | `flow` 加 `kind` 字段即可覆盖，表面积严格更小 |
| 换用外部图表库（mermaid 等） | [spec.md](spec.md) §13.4 禁止加载任何外部资源；CSP 为 `default-src 'none'` |

---

## 10. 请您裁决的三点

用户于 2026-09-02 对三点**全部按本文建议裁决**：

1. **影响判定获认可**——三条反馈的修复不构成 [spec.md](spec.md) 需求变更，不另立 ADR，直接按第 6 节实施。
2. **协议层级**——在 `/1` 内做加法。
3. **第 8 节的既有字节门背离**——作为独立文档订正处理，与 W23 分离，不与本次功能改动捆绑；本轮未动。

本文已按第 3 条以外的裁决落地，并已登记进 [README.md](README.md) §1 的文档索引表。

## 11. 实施结果

### 11.1 三条问题的消除证据

| 问题 | 证据 |
|---|---|
| R2a 流程图重叠 | 新增 69 条几何不变量断言（标签互不相交、不压节点框、不落在他边路径上、每边独立路径、确定性、画布包含全部几何），覆盖用户报告的七节点图与七种病态拓扑。双向变异验证：关闭避让搜索 7 条失败，改回旧的按下标分列布局 5 条失败，还原后 69/69 通过。真实 Chromium 复测同一张图 7 标签 0 冲突 0 `crowded` |
| R3 提示被截断 | 新增浏览器断言对表头首行与表体首行两处各取九点命中测试；Chromium / WebKit / Firefox 三引擎均 9/9 命中且完整落在视口内。宿主 CPU 饱和下三引擎各三次复跑全通过 |
| R1 表达不直白 | 阶段门错位已修（写作阶段现在会读到写作规则）；新增载体选择表、可数缺陷触发条件、termRef 字段边界、flow 两串写法、四问读者隔离题集与工作示例参考文件，全部由 `tests/unit/skill-workflow.test.ts` 的正则断言钉住 |
| R2b 形式单一 | `ContentNode` 由 7 个成员增至 8 个（新增 `scale`：强弱阶梯／光谱／占比）；`FlowGraphNode`/`FlowGraphEdge` 增加可选 `kind`，节点类型驱动形状且同一类型在文字清单中复述为词，形状不作为唯一通道 |

### 11.2 字节预算的实际消耗

| 项 | 字节 |
|---|---|
| 起始余量（369633/393216） | 23583 |
| flow 布局重写 + 术语预览 | −9772 |
| flow `kind` 两个可选枚举 | −2068 |
| `scale` 节点 | −9007 |
| 边几何去重回收 | +372 |
| 预览改为随锚点滚动重定位（修 Firefox 竞态） | −137 |
| 自环标签锚到弧外 | −13 |
| 复审修复：精确线段相交、cubic 采样、水平离屏判定、焦点保持、提示语言标注、预览高度上限 | −1199 |
| 统一曲线采样器、删除三个未引用的 i18n 键 | +81 |
| **落地余量（391376/393216）** | **1840** |

`scale` 的 9007 字节中有 6775 字节**仅**来自「成为 `ContentNode` 联合成员」这一事实——Ajv 在每个 ContentNode 使用点复制联合判别。实测方法：把 `ScaleNode` 从联合里摘掉但保留 `$defs`，生成的浏览器校验器立刻少 6775 字节；把 `note` 从 `InlineNode[]` 改成纯字符串只省 357 字节。因此**任何**新 `ContentNode` 成员的地板价约 6.8 KB，1840 字节装不下第二个，`matrix` 未实施。

### 11.3 顺带修正的既有背离

- flow 文字替代此前输出 `A: 标签` 与 `A → B` 的本地 id 形式，与 [design.md](design.md) §11.3/§7.3 规定的「由 title、description、节点标签和边关系构成」相反。已改为节点 label，同名时才附 id 消歧。
- 旧悬停提示 `pointer-events:none` 且无 `Esc` 关闭，不满足 WCAG 2.1 SC 1.4.13。axe-core 没有该项自动规则，所以既有门禁一直通过。新实现可悬停、可 `Esc` 关闭。

### 11.4 仍未修复的项

- [local-development.md](local-development.md) §5.1 记录的 termRef 跳转竞态**未修**。本轮做了对照实测：带本次改动 12/12 通过，去掉本次改动 10/12 通过，确认它是既有产品竞态且未被本轮加剧。修复要动审批台的焦点/重绘逻辑，仍须另立波次。
- 第 8 节的字节门契约背离未动，理由见该节与上面第 10 节第 3 条。
- `matrix` 节点延后，需先就字节门作出裁决。
