# pi-provider

pi 的自定义 provider / model 管理扩展。在终端里通过一个交互式向导，即可完成 `~/.pi/agent/models.json`（配置格式见 [Custom Models 文档](https://pi.dev/docs/latest/models)）中自定义 provider 的添加、删除与修改，无需手工编辑 JSON。

## 功能

- **`/pi-provider` 命令**：随时打开管理菜单。

- **添加 provider（分步向导）**：

  1. Provider 名称；
  2. API 类型：`openai-completions` · `openai-responses` · `anthropic-messages` · `google-generative-ai`；
  3. Base URL（按 API 类型自动预填常见默认值）；
  4. API key：可选「无（用 `/login` / `--api-key` 鉴权）」、「环境变量（`$VAR`）」、「Shell 命令（`!cmd`）」或「字面量」，与 pi 的[值解析规则](https://pi.dev/docs/latest/models#value-resolution)一致；
  5. 自定义请求头（可选，`name=value, name2=value2` 格式）；
  6. **模型选择**：优先请求 provider 自己的 `/models` 接口拉取模型列表；失败时回退到 [OpenRouter 目录](https://openrouter.ai/api/v1/models)，以固定高度、支持搜索与多选的列表展示。列表中的模型可以勾选，也支持手动输入未列出的模型 id；
  7. **元数据转换**：对选中的每个模型，从 OpenRouter 获取元数据并转换成 pi `models.json` 的模型配置（上下文窗口、最大输出 tokens、输入模态、每百万 token 价格、推理与思考等级映射）。没有匹配到元数据的模型只生成基础配置 `{ "id": … }`；
  8. 确认后合入 `~/.pi/agent/models.json`（保留已有 provider 与未知字段，写入为原子操作，不会写坏文件）。

- **删除 provider**：选择要删除的 provider，确认后移除。

- **修改 provider**：

  - Provider 级配置：`baseUrl`、`api`、`apiKey`、`headers`、`authHeader`、重命名，或直接编辑原始 JSON；
  - 模型级配置：`name`、`api`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`cost`、`thinkingLevelMap`、`compat`、原始 JSON 编辑、删除，或从 provider 列表 / OpenRouter 目录重新选择、刷新模型。

任何修改完成后，在 pi 里执行 `/model` 即可重新加载 `models.json`（pi 每次打开 `/model` 都会重载，无需重启）。

## 安装

其它用户可以通过 GitHub 安装（仓库公开，无需 SSH key 也可用 HTTPS）：

```bash
# 推荐：HTTPS（无需配置 SSH）
pi install https://github.com/wefantasy/pi-provider

# 或使用 git 简写（无需 .git 后缀、不要用冒号写法）
pi install git:github.com/wefantasy/pi-provider

# 或使用 SSH 形式
pi install git:git@github.com:wefantasy/pi-provider
```

也可以不安装、临时运行：

```bash
pi -e https://github.com/wefantasy/pi-provider
```

> 注意：包名请写 `github.com/wefantasy/pi-provider`（斜杠形式）。不要写成
> `git:github.com:wefantasy/pi-provider.git` —— 冒号会被解析为端口号导致安装失败。

## 使用

- 在 pi 中输入 `/pi-provider` 打开管理菜单，然后按提示选择「添加 / 删除 / 修改」即可。

## 开发

```bash
npm install          # 安装开发依赖（typescript、@types/node）
npm run typecheck    # tsc --noEmit（通过全局 pi 安装解析类型）
npm test             # 逻辑 + 多选组件 + 向导端到端测试（需联网访问 OpenRouter）
```

测试覆盖：store 的读写/合并（针对临时的 `PI_CODING_AGENT_DIR`）、OpenRouter 元数据到 pi 配置的转换、可搜索多选组件，以及添加/删除/修改的完整流程（通过脚本化 UI 驱动）。

## 配置字段来源对照

| pi `models.json` 字段 | 来源 |
| ---------------------- | ------ |
| `id` | 模型 id（始终写入） |
| `name` | OpenRouter `name` |
| `input` | `architecture.input_modalities`（仅保留 text/image，其余丢弃） |
| `contextWindow` | `context_length` / `top_provider.context_length` |
| `maxTokens` | `top_provider.max_completion_tokens` |
| `cost` | `pricing`（按 token 计价换算为每百万 token 价格） |
| `reasoning` / `thinkingLevelMap` | `reasoning.supported_efforts` / `supported_parameters` |

未匹配到元数据的模型 id 生成最小配置 `{ "id": … }`，其余字段均使用 pi 的默认值。
