# pi-rollback 0.6.2 已确认 Bug（外部复现指南）

> 状态更新（2026-11-26）：外部 agent 已提交修复包 `pi-rollback-0.6.2-fixed.zip`；本文件记录的 4 项 bug 已在源码复核中逐项修复，并已应用到生产扩展目录 `~/.pi/agent/local/pi-rollback-0.6.2-local.1/`。修复前生产副本备份在同级 `pi-rollback-0.6.2-local.1.before-fixes/`。本文件保留作历史复现记录。
> 注意：`reproduce-bugs.mjs` 是针对**修复前**版本的一次性脚本；在已修复源码上运行时，4 项均应显示 `FAIL REPRODUCED`（表示旧 bug 不再出现），而不是 `PASS REPRODUCED`。回归验证请使用包内新增/更新的 `bun test`（92 pass / 0 fail）。

适用版本：`pi-rollback` 0.6.2（`/home/stan/.pi/agent/local/pi-rollback-0.6.2-local.1`，
其 `index.ts` / `journal.ts` / `prune.ts` / `README.md` / `package.json` / `LICENSE`
与 `/home/stan/pi-rollback` 工作副本逐字节一致）。

现有测试：`bun test` → 89 pass / 0 fail。以下 4 项是测试未覆盖、但可以稳定复现的真实缺陷。
严重程度按“是否会导致错误恢复”排序。

探针方法说明：本仓库的 `index.ts` 默认导出一个 `extension(pi, ctx)` 工厂，可通过
`pi.on(...)` / `pi.registerCommand(...)` 捕获扩展注册的命令和 hook，再用一个最小
`ExtensionAPI` + `ExtensionCommandContext` 假对象驱动；不修改源文件，不依赖已安装的 Pi 运行时。
`captureExtension()` 的构造代码见 `reproduce-bugs.mjs`。

---

## BUG 1（严重）：同名检查点在选择器里会恢复错的点

**位置**：`index.ts:577-606`（`buildRestoreMenu`）、`index.ts:713-716`（`findCheckpoint` 的 label 分支）

**机制**：

1. `buildRestoreMenu` 为每个 checkpoint 构造 `RestoreOption`，`args` 只有
   `{ targetLabel: checkpoint.label }`，没有携带 entryId。
2. 当多个 checkpoint 同名时，菜单只是把重复显示文字加 ` (#2)`、`(#3)` 后缀
   （`index.ts:600-605`），以便 `pickOption` 能按显示文字反查 option。
3. 但真正执行时，`rollback` 仍只把 `targetLabel` 交给 `findCheckpoint`；而
   `findCheckpoint` 用 `all.findLast(cp => cp.label === targetLabel)`，**永远命中最新那条**。
4. 所以菜单第 2 条（旧 checkpoint）看似可选，实际恢复的是最新同名 checkpoint。

**触发条件**：两个同名 checkpoint（例如 `/checkpoint before refactor` 连续执行两次），且它们
的 `createdAt` 落在同一分钟（显示文字里 `relativeTime` 相同，才会出现 ` (#2)` 后缀）。
即使时间不同，只要两个 checkpoint 同名，label 定位本身就只指向最新那条，是同一类缺陷。

**复现**（`reproduce-bugs.mjs` 中的 `bug1DuplicateLabels()`）：
- checkpoint A（旧）= 文件 `state-A`，checkpoint B（新）= `state-B`，当前 = `state-C`。
- 菜单显示：`before refactor · 0s ago` 与 `before refactor · 0s ago (#2)`。
- 用 UI `select` 选第 2 项（旧）。
- 预期：导航到旧 checkpoint，文件恢复为 `state-A`。
- 实际：导航到新 checkpoint（`target.resolvedEntryId = 新 checkpoint`），文件恢复为 `state-B`。

**修复方向**：让 `RestoreOption` 携带可唯一定位的字段（checkpoint 的 `entryId` 或
`resolvedEntryId`），并在执行回滚时按该字段而非 label 定位；或在 label 重复时，
给 `args.targetLabel` 使用带序号的唯一别名并让 `resolveLabelQuery` / `findCheckpoint` 解析。

---

## BUG 2（中）：`targetEntryId` 与 `targetLabel` 冲突被静默接受

**位置**：`index.ts:703-717`（`findCheckpoint` 的歧义校验）

**机制**：

```ts
const counts = [args.count, args.runCount, args.turnCount].filter(v => v !== undefined);
if ((args.targetEntryId || args.targetLabel) && counts.length) throw ...;
if (counts.length > 1) throw ...;
```

这里只检查了 `count/runCount/turnCount` 之间的互斥，以及它们与 target 的互斥；
**没有检查 `targetEntryId` 与 `targetLabel` 同时出现**。之后的分支顺序是
`targetEntryId` 优先、`targetLabel` 次之，因此两者同时给出时，
label 被无声忽略，不会报 "Rollback target is ambiguous"。

**复现**（`reproduce-bugs.mjs` 中的 `bug2ConflictingTargets()`）：
调用 `/rollback {"targetEntryId":"<新 checkpoint 的 entryId>","targetLabel":"旧 label"}`。
预期：报歧义错误（与 `count`/`runCount` 同时给出时的行为一致）。
实际：`ok:true`，回滚到 `targetEntryId` 指定的 checkpoint，返回的 `targetLabel` 还是那个被忽略的值。

**注意（邻近风险，未计入主 bug）**：`targetEntryId` 分支同时匹配
`checkpoint.entryId === id || checkpoint.resolvedEntryId === id`
（`index.ts:709`）。若 A 的 `entryId` 恰好等于 B 的 `resolvedEntryId`，传 A 的 entryId 会命中 B。
这是有意的兼容别名匹配还是缺陷，需作者确认。

**修复方向**：把歧义校验改为“所有 target 选择器中最多一个”，
即 `(args.targetEntryId ? 1 : 0) + (args.targetLabel ? 1 : 0) + counts.length > 1` 时抛错。

---

## BUG 3（中）：`/redo` 之后注入旧的“Rollback ok”结果提示

**位置**：`index.ts:1142-1148`、`index.ts:1161-1170`（`rollbackContextNote`）、
`index.ts:1350-1390`（`runRedo`）

**机制**：

- `latestRollbackResult(entries)` 取当前分支上最后一个 v1 result 条目。
- `emittedResultKey` 是一个闭包变量，记录上一次已经播报过的
  `${createdAt}:${ok}:${files}` key，且只按 key 去重。
- `/redo` 导航回到分叉前的 source entry（`index.ts:1387`），那条分支上仍有第一次回滚的
  result 条目。由于之前已经播报过第二次回滚的 key，旧的 key 与 `emittedResultKey` 不同，
  于是 `rollbackContextNote` 又把旧结果当作“新结果”播报一次。

**复现**（`reproduce-bugs.mjs` 中的 `bug3StaleNoteAfterRedo()`）：
1. 回滚① → context 提示 `rollback-before-1-0`。
2. 新回合写文件 → 回滚② → context 提示 `rollback-before-1-1`。
3. 执行 `/redo`，下一次 context 又收到
   `Rollback ok: restored 0 file(s) to "rollback-before-1-0".`

**预期**：redo 后不应出现回滚结果提示（或应播报 redo 专属提示）。

**修复方向**：把“已播报 result”的跟踪与当前分支位置绑定（例如把 result entryId 也纳入 key，
并在导航/redo 时重置 `emittedResultKey`），而不是只用一个进程级全局 key。

---

## BUG 4（低）：文档允许的 `PI_ROLLBACK_PRUNE=true/false` 环境变量被拒绝

**位置**：`prune.ts:156-160`（`parseToggle`），文档：`README.md:132`

**机制**：

```ts
if (value === true || value === 1 || value === "1") return true;
if (value === false || value === 0 || value === "0") return false;
throw new Error("PI_ROLLBACK_PRUNE must be 0, 1, false, or true");
```

README 明确写 `PI_ROLLBACK_PRUNE` 接受 `0`、`1`、`false`、`true`。但真实环境变量
`process.env.PI_ROLLBACK_PRUNE` 永远是字符串；`"true"` 和 `"false"` 都会抛错，
`parsePruneConfig` 捕获后返回 `disabled` 配置，自动清理被关闭并打警告：
`Automatic rollback pruning disabled: PI_ROLLBACK_PRUNE must be 0, 1, false, or true`。
JSON 设置文件里写布尔 `true` 可以工作，因此环境变量覆盖无法兑现文档承诺。

**复现**（`reproduce-bugs.mjs` 中的 `bug4PruneToggleStrings()`）：
`parsePruneConfig({ PI_ROLLBACK_PRUNE: "true" })` → `enabled:false` + 警告。
对照：`"1"` → enabled，`"0"` → disabled，布尔 `true` → enabled。

**修复方向**：`parseToggle` 增加
`if (value === "true") return true; if (value === "false") return false;`
（建议忽略大小写/首尾空白，并与文档保持一致）。

---

## 已排除的误报（不要当成 bug 再报）

- `npm rm lodash` / `git rm file.txt` / `echo rm foo` 被判为破坏性命令：
  `journal.ts` 明确记录这是有意的保守误报（宁可多建检查点）。
- `resolveLabelQuery` 对真实 checkpoint 条目的 `entryId` 子串匹配：在真实数据形态下工作正常。
- `/checkpoints <text>` 按消息文本过滤：在忠实 harness 下正常。
- `redo.mutations` 的顺序（selected 降序 → reverse 成升序）：正确。
- 默认 LLM 回滚目标“少一轮”：此前复现是 harness 构造错误，真实行为正常。
- context-note 的 `CustomMessage` 结构、JSON 里带 `continuePrompt`：均与 Pi API 一致。
- `/rollback {...json...} -- 追加提示` 混合写法会 JSON 解析失败，但 README 未把这种混合写法列为支持形式（人类写法和 JSON 写法是分开文档化的），故不计入 bug。

## 验证方式

```bash
cd pi-rollback          # 即本 zip 解压后的目录
bun test                # 期望 89 pass / 0 fail（原测试不含以上回归）
bun reproduce-bugs.mjs  # 期望四个 BUG 都输出 REPRODUCED（BUG 4 会打印警告）
```

`reproduce-bugs.mjs` 只在本进程内构造假 API 和临时目录，不碰外部 Pi 会话、不修改项目源文件。
