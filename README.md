# Smart Hub - 智能中枢 · SillyTavern 扩展

从魔法棒扩展菜单一键打开的**独立对话插件**：独立 API 对话 + 自动必应联网搜索，支持附加酒馆完整聊天记录（无视隐藏与正则）与向量 + 重排序记忆检索。

## ✨ 功能特性

| 功能 | 说明 |
|---|---|
| 💬 独立对话窗口 | 从魔法棒菜单或扩展设置一键打开，气泡式聊天 UI，走独立 API，与酒馆聊天完全隔离，历史自动保存 |
| 🔌 独立 API 连接 | 任意 OpenAI 兼容接口（one-api / new-api / ollama / vllm / llamacpp 等），窗口内 ⚙ 即可配置 |
| ⟳ 拉取模型 | 一键拉取 `/v1/models` 模型列表，下拉选择 |
| 🔍 必应联网搜索 | 开启后每轮提问自动用必应搜索（国际版/中国版/DuckDuckGo 备用），结果注入上下文，AI 回答自带最新网络信息 |
| 📜 完整聊天记录 | 直接读取会话底层数据，**不受消息隐藏（灯泡）和正则隐藏/替换的影响**，可附加为对话上下文、查看、导出 |
| 🧠 向量 + 重排序 | 独立配置向量和 Rerank 模型，对完整聊天记录（含隐藏消息）建增量向量索引，语义检索 + 重排注入 |

## 📦 安装

### 方式一：扩展管理器安装

酒馆 → 扩展管理器（🧩）→「安装扩展」→ 粘贴仓库地址：

```
https://github.com/w1516970/sillytavern-smart-ext
```

国内网络连不上 GitHub 时，使用加速镜像地址（任选可用的）：

```
https://gh-proxy.com/https://github.com/w1516970/sillytavern-smart-ext
https://ghfast.top/https://github.com/w1516970/sillytavern-smart-ext
```

### 方式二：手动安装

下载 zip（可用镜像前缀加速）：

```
https://gh-proxy.com/https://github.com/w1516970/sillytavern-smart-ext/archive/refs/heads/main.zip
```

解压后把文件夹改名为 `sillytavern-smart-ext`，放入：

```
SillyTavern/public/scripts/extensions/third-party/
```

重启酒馆，在扩展管理器中启用。

### 更新

- 已开启 `auto_update`，扩展管理器会提示新版本，点更新即可
- 也可删除后用上述地址重装
- 详见 [CHANGELOG.md](CHANGELOG.md)

## 🚀 使用

### 1. 启动搜索桥接服务（联网搜索需要）

浏览器无法直连必应（CORS 限制），在**运行酒馆的设备**上启动（零依赖，Node 18+）：

```bash
cd sillytavern-smart-ext/bridge
node server.mjs
# 输出：Smart Hub 搜索桥接服务已启动: http://127.0.0.1:5123
```

### 2. 开始对话

1. 左下角魔法棒（`+` 扩展菜单）→ **💬 Smart Hub 对话**（或扩展设置面板 →「打开独立对话窗口」）
2. 窗口内点 **⚙**：填 API 地址/密钥 → 拉取模型 → 选择模型 → 勾选「对话时联网搜索」
3. 直接开聊。开启搜索后每轮回答前会自动必应搜索，窗口顶部徽章显示搜索开关状态

### 3. 高级功能（扩展设置面板 → ⚙️ 高级选项）

- **附加酒馆完整聊天记录**：把当前会话最近 N 条记录（含被隐藏的消息，无视正则）作为对话上下文
- **向量记忆检索**：配置向量模型（如 `bge-m3`、`text-embedding-3-small`）与 Rerank 模型（如 `bge-reranker-v2-m3`），对完整聊天记录语义检索

## 📁 文件结构

```
sillytavern-smart-ext/
├── manifest.json        # 扩展清单（auto_update 已开启）
├── index.js             # 扩展主逻辑
├── style.css            # 界面样式（对话窗口/气泡/菜单入口）
├── CHANGELOG.md         # 更新日志
├── bridge/
│   └── server.mjs       # 必应搜索桥接服务（零依赖 Node）
└── README.md
```

## ❓ 常见问题

- **扩展管理器报 "Cannot reach the server"** → 国内网络连不上 GitHub，用上方镜像地址安装
- **魔法棒菜单里没有按钮** → 更新到 v1.3.1+ 并强制刷新页面；仍不行可从扩展设置面板的「打开独立对话窗口」进入
- **搜索报错** → 确认 bridge 服务已启动且地址填对（默认 `http://127.0.0.1:5123/search`）
- **拉取模型 401/403** → API 密钥错误；部分本地服务可留空密钥
- **向量/Rerank 失败** → 确认 API 支持 `/v1/embeddings` 与 `/v1/rerank`（SiliconFlow、Jina、本地 llama.cpp 系列等均支持）

## License

MIT
