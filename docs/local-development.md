# 本地开发与验证环境

> - 文档状态：现行
> - 最后更新：2026-08-23
> - 作用：记录在本机准备开发/验证环境的最小步骤、门禁的正确跑法，以及已复现的执行注意事项。本文只记录可复现的操作事实，不定义需求（见 [spec.md](spec.md)）也不定义工程决定（见 [design.md](design.md)）。

## 1. 适用范围

本文只覆盖**仓库开发与验证**。真实试点不适用本文：它必须按
[claude-code-handoff.md](claude-code-handoff.md) §6 在独立干净工作树中、以经校验后私有解压的发布
ZIP 作为唯一运行时执行。本文不放宽该纪律的任何一条。

## 2. 工具链

| 组件 | 版本 | 用途 | 获取方式 |
|---|---|---|---|
| Node.js | `24.19.0`（合同区间 `>=24 <25`） | 全部 npm 门禁与 CLI | 版本管理器 + 仓库根 `.node-version` |
| npm | 随 Node 分发 | `npm ci` 锁定依赖 | — |
| Python | `3.11` | 运行固定版 Skill 验证器 | 与 CI 同版本 |
| `skills-ref` | 钉在 `69ef37e9424c0a7ea9dd2293b559e43ec8176379` | `npm run validate:skill` | `agentskills` 仓库 `skills-ref` 子目录 |
| Playwright 浏览器 | 随 `@playwright/test` `1.62.1` | `npm run test:browser` | `npx playwright install` |

缺少 `skills-ref` 时 `validate:skill` 以 rc=3 退出并提示
`unable to execute pinned Skill validator`——这是本机缺工具，不是 Skill 缺陷。

### 2.1 Node 版本解析（重要）

[design.md](design.md) §16 已把「宿主没有 Node 24」的控制手段定为**安装文档与 preflight 报错**，
CLI 运行时**不做**版本硬拦截。这是有意的：审批台与 CLI 需要能在自带 Node 低于 24 的宿主
（例如 Cowork 的代码执行沙箱、Codex 云端镜像）里继续可用，硬拦截会让技能在这些平台直接不可用。
面向使用者的两层表述（合同运行时 Node 24 vs 实测可运行 22/26，字节可复现只对 24 承诺）见
[platform-usage.md](platform-usage.md) §2.2；本节只补它没覆盖的那一面——**本地开发机**的解析行为。

代价是宿主侧的版本正确性由使用者保证，而这里有一个容易踩空的地方：使用版本管理器时，
仓库内由根目录 `.node-version` 自动切到 24.19.0，**仓库外的目录不受它约束**——而试点输出根、
私有运行时根恰恰都在仓库外。把版本管理器的默认版本设为当前合同运行时即可消除该缺口：

```bash
fnm default 24.19.0
```

（`nvm` 对应 `nvm alias default 24.19.0`。）声明了 `.node-version`、`.nvmrc` 或 `engines`
的其他项目仍按各自声明切换，不受该默认值影响。执行 CLI 前用 `node --version` 复核一次最稳妥。

## 3. 一次性准备

在**新的**工作树里执行（`npm ci` 会删除并重建 `node_modules`，不要在已有依赖目录上运行）：

```bash
npm ci
npx playwright install chromium webkit firefox
```

固定版 Skill 验证器与 CI 钉的是同一个 commit：

```bash
uv tool install --python 3.11 "git+https://github.com/agentskills/agentskills@69ef37e9424c0a7ea9dd2293b559e43ec8176379#subdirectory=skills-ref"
```

## 4. 本地门禁

[AGENTS.md](../AGENTS.md)「Verification and handoff」列出的代码门禁清单在本机逐条可跑。
其中 `npm run test:browser` 的跑法见 §5。

## 5. 浏览器 lane：跑法与一个已修复的用例竞态

CI **从不**同时跑三个引擎：`.github/workflows/validate.yml` 把 chromium 与 webkit 放在
matrix 的两个独立 job，firefox 走独立的 smoke job。本地建议用同样的形态，它最接近 CI 结论：

```bash
npm run test:browser -- --project=chromium
npm run test:browser -- --project=webkit
npm run test:browser -- --project=firefox
```

不带 `--project` 时会一次装载三个引擎，Playwright 默认取 CPU 核数的一半作为 worker 数
（10 核机器上为 5），最多 5 个浏览器实例并发。这条路径曾在机器饱和时暴露出一个**真实的
用例竞态**（已在本波次修复，见下）。

### 5.1 已记录未修复：CPU 饱和下 termRef 跳转不落点

**现象**：`workbench-render.spec.ts` 的
`@A19 render a safe offline shell with language and text alternatives` 在 chromium 上失败：

```text
Error: expect(locator).toBeInViewport() failed
Locator:  locator('#glossary-G-001')
Received: viewport ratio 0
```

**复现条件**：三引擎合并跑 **且** 宿主 CPU 饱和。本机 10 核、用 8 个忙循环把负载平均值压到
16–19 时可按需复现；机器空闲时同一条命令 102 用例全绿，单独跑任一引擎也全绿。

**已排除的两个解释**（各自实测证伪，不要重复走）：

1. *断言超时太短*：把 `toBeInViewport` 超时从默认 5s 提到 15s，它在 15s 内轮询 34 次，
   元素始终 `viewport ratio 0`——不是动画慢，是跳转没落点。
2. *`focus()` 与 `keyboard.press()` 拆分导致按键投错元素*：改用
   `locator.press("Enter")`（聚焦与按键合成一个带可操作性等待的步骤）后，同等负载下仍复现。

**实测到的失败态**（在断言失败点直接读 DOM）：

```json
{"hash":"#glossary-G-001","scrollY":581,"innerHeight":720,"scrollHeight":2921,
 "rect":{"top":2165.6,"height":27.1},"display":"block","visibility":"visible",
 "activeElement":"BODY#","hiddenAncestor":null}
```

即：锚点导航**确实发生了**（`location.hash` 已是 `#glossary-G-001`），目标元素可见且未被隐藏，
但页面停在 `scrollY=581`（目标需要滚到约 2050），且焦点被重置到 `BODY`。这指向审批台自身的
焦点/重绘逻辑与浏览器的锚点滚动相互竞争：`html{scroll-behavior:smooth}` 的平滑滚动在动画
途中被打断，同时持有焦点的节点被替换掉。

**判定与处置**：

- **不是测试用例的写法问题**——两种测试侧修法都已证伪，因此本波次**不改测试**，
  也不改 `playwright.config.ts`：用超时或 retry 掩盖一个产品侧竞态只会让它更难被发现。
- **对交付正确性无影响**：术语表与定义都在同一个文件里、可见且可滚动到达，
  跳转失败只是少了一次自动定位；决议数据、回执与摘要都不受影响。
- **CI 不受影响**：三个引擎本就在不同 job、不同容器里跑，并发度不足以触发。
- **对真实审阅者的影响**：机器极度繁忙时点击术语可能不自动跳转，需要手动滚动。属于体验降级，
  不属于数据或正确性缺陷。

修复要动 `src/workbench/`，属于产品变更，须按 [task.md](task.md) 的波次流程立项并重切候选，
不并入本波次。在那之前，本地按 §5 开头的分 project 形态跑即可稳定复现 CI 的结论。

**同类写法备查**：仓库另有 4 处 `focus()` + `page.keyboard.press()` 拆分写法，均未观测到失败，
本波次未改动：`workbench-render.spec.ts:307`、`workbench-recovery.spec.ts:501`、
`workbench-actions.spec.ts:278`、`workbench-actions.spec.ts:297`。

## 6. 工作树与忽略规则

仓库变更一律在独立工作树 + 独立分支上进行，PR 以 `codex/v0.2.0` 为 base：

```bash
git worktree add -b <branch> ../<dir> origin/codex/v0.2.0
```

`.gitignore` 覆盖四类工具链产物——`node_modules/`、`build/`、`coverage/`、`test-results/`——
它们分别由 `npm ci`、`tools/build.mjs`、Vitest 覆盖率默认输出目录与
`playwright.config.ts` 的 `outputDir` 产生。四者都必须保持被忽略，否则
[claude-code-handoff.md](claude-code-handoff.md) §6.2 的预检
`test -z "$(git status --porcelain)"` 在任何一次构建或测试之后都会失败。

`dist/` 下只有发布产物是跟踪文件。忽略规则写成 `dist/*` 加两条 `!dist/*.zip`、
`!dist/*.manifest.json` 反选，使新构建出来的发布产物对 `git status` 可见；
`dist/.release-txn` 等中间目录仍被忽略。
