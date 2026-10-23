# StarPicker

GitHub Star Lists behave like tags: a repository can belong to several lists or none. StarPicker adds Issues-style filtering to the Stars page.

## 安装

1. 在浏览器安装 `Tampermonkey`, `Violentmonkey` 或 `ScriptCat` 脚本管理器插件；
2. 点击 [`starpicker.user.js`](https://raw.githubusercontent.com/Napreth/StarPicker/main/starpicker.user.js) 在脚本管理器中安装脚本；
3. 在 GitHub Star 页面中使用筛选器功能。

## 查询语法

查询语法参照 GitHub Issue 的查询语法

```text
author:DIYgod,hicccc77 topic:wechat,cli stars:>=1000
type:source,fork language:typescript,python
list:"收藏","我的"
no:list
has:list
updated:>=20260812
updated:20250611-20250912
forks:10..100
"command line" AND (stars:>1000 OR forks:>=100)
```

- `author:` 为仓库所有者，`list:` 为列表名称或 URL 中的列表标识，`topic:` 为仓库 topic，`language:` 为主要语言；完整匹配，不区分大小写。`language:@none` 表示没有主要语言。
- `type:` 取 GitHub 原生类型：`public`、`private`、`source`、`fork`、`sponsorable`、`mirror`、`template`，支持 OR 多选。
- `no:list`（也可写 `list:@none`）表示未加入任何列表，`has:list`（`list:@any`）表示至少属于一个列表。
- 空格或 `AND` 表示同时满足，`OR` 表示满足任一条件；AND 优先于 OR，括号最多嵌套五层。`-` 和 `NOT (...)` 用于排除。
- 逗号多值取 OR。手写重复限定符仍取 AND，例如 `topic:cli topic:javascript`；这类查询不提供菜单底部快捷清除。
- `stars:` / `forks:` 支持精确值、`>`、`>=`、`<`、`<=`、`10..100`、`*..100` 和 `100..*`，也接受别名 `star:` / `fork:`，支持 0。
- `updated:`（别名 `update:`）接受 `YYYYMMDD` 日期、比较条件和 `YYYYMMDD-YYYYMMDD` 范围；范围包含两端完整本地日。兼容旧版 `YYYY-MM-DD` 和 `..` 范围。
- “within 24 hours”使用精确的本地 `YYYYMMDDhhmmss` 截止时间；按月选项使用日历月，并正确处理月底。
- 双引号包裹带空格或逗号的值；无限定符文本搜索仓库名称和描述。任意复杂布尔查询仍可直接提交；菜单编辑以支持的维度组合规则为准。

## 数据与状态

脚本先读取全部收藏分页，再执行查询。Type 保留 GitHub 原生分类的含义，按需读取对应类型的完整分页后合并；Language 从仓库卡片读取。URL 的 `q` 保存查询，`sp_sort` 独立保存排序；分页请求移除本地查询参数，避免截断结果。

List 按需读取各列表的全部成员分页，最多并发两项请求；列表目录在页面内缓存 5 分钟。创建和删除使用 GitHub 当前登录会话提供的表单，成功后刷新目录与成员数据。Topic 按需读取 GitHub 公共 REST API，同一用户的数据在页面内缓存 5 分钟；私有仓库的 topic 使用当前登录会话读取仓库页面。加载失败或限流会显示错误和 Retry。不会持久化私有仓库数据。

适配 GitHub 当前 Stars 页面，支持 Turbo / PJAX 切换。GitHub 页面结构或接口变化可能需要更新脚本。

## 开发

无需安装依赖，使用 Node.js：

```sh
npm run check
npm test
```
