# ArkTS Assistant

ArkTS 开发助手 MCP Server，基于自定义文档库为 AI 编程助手提供文档检索能力。

## 致谢与声明

本项目基于 [arkts-helper](https://github.com/LongLiveY96/arkts-helper) 进行二次开发，感谢原作者 **LongLiveY96** 的开源贡献。

### 本项目的主要改进

| 改进项 | 说明 |
|--------|------|
| **更丰富的本地文档** | 收录了 7000+ 篇 HarmonyOS/ArkTS 官方文档，覆盖 API 参考、开发指南等多个分类 |
| **中文分词搜索** | 集成 [segmentit](https://github.com/leizongmin/node-segmentit) 中文分词库，支持智能分词、停用词过滤、连接词拆分，中文搜索更精准 |
| **多级索引结构** | 采用主索引 + 关键词倒排索引 + 分类索引的多级结构，关键词/分类查找复杂度 O(1) |
| **路径关键词提取** | 自动从文件夹名称提取版本号（V1/V2）、Kit名称等关键词，即使文档标题不包含也能被搜索到 |
| **URL 自动提取** | 支持 Markdown 格式链接自动提取，文档顶部的官方链接会被索引到 url 字段 |

### 保留的核心功能

- 华为官方智能问答（ask_ai）- 支持匿名态和登录态
- 批量问答并行处理（ask_ai_batch）
- Cookie 登录凭证管理（set_ai_auth）

## 功能特性

### 📂 本地文档

| 工具 | 功能 |
|------|------|
| `find_docs` | 关键词搜索文档（支持中文分词） |
| `read_doc` | 读取完整文档内容 |
| `list_doc_topics` | 列出文档分类 |
| `reload_docs` | 重新加载文档索引 |

### 🤖 华为智能问答

| 工具 | 功能 |
|------|------|
| `ask_ai` | 向华为开发者官方智能问答助手提问 |
| `ask_ai_batch` | 批量并行提问，提升效率 |
| `set_ai_auth` | 设置登录凭证，突破匿名态次数限制 |
| `read_more` | 读取被截断的完整回答内容 |

## 快速开始

### 1. 安装依赖

```bash
cd arkts-assistant
npm install
npm run build
```

### 2. 准备文档

将文档放入 `static/docs/` 目录，支持 `.md`、`.txt`、`.markdown` 格式。

```
static/docs/
├── api/                    # API 参考文档
│   └── Ability Kit/
│       └── xxx.txt
├── guide/                  # 开发指南
│   └── 应用框架/
│       └── xxx.txt
└── index/                  # 索引文件（自动生成）
    ├── main_index.json
    ├── keyword_index.json
    ├── catalog_index.json
    └── catalog_*.json
```

### 3. 生成索引

```bash
npm run generate-index
```

索引文件会自动生成到 `static/docs/index/` 目录。

## 使用方式

### 方式一：Claude Code / Cursor 配置 (推荐)

在 AI 助手配置文件中添加 MCP 服务器：

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "arkts-assistant": {
      "command": "node",
      "args": ["/path/to/arkts-assistant/dist/index.js"],
      "env": {}
    }
  }
}
```

**Cursor** (设置 → MCP):
```json
{
  "mcpServers": {
    "arkts-assistant": {
      "command": "node",
      "args": ["/path/to/arkts-assistant/dist/index.js"]
    }
  }
}
```

### 方式二：HTTP 服务模式

启动 HTTP 服务后，可以通过 REST API 访问：

```bash
npm run start:http
```

API 端点：
- `GET /health` - 健康检查
- `GET /search?q=关键词&limit=数量` - 搜索文档（默认返回50条，`limit=0`返回全部）
- `GET /doc/:objectId` - 获取完整文档
- `GET /topics` - 列出所有主题
- `POST /reload` - 重新加载索引

### 方式三：开发模式

```bash
# stdio 模式
npm run dev

# HTTP 模式
npm run dev:http
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ARKTS_DOCS_DIR` | 文档目录路径 | 项目 `static/docs` 目录 |
| `ARKTS_MCP_PORT` | HTTP 服务端口 | 9527 |

## 工具详解

### find_docs

搜索文档库。

**参数：**
- `query` (必填): 搜索关键词，支持中英文，多个关键词用空格分隔
- `limit` (可选): 返回结果数量，默认 50 条。设为 0 返回所有结果，最多 1000 条

**示例：**
```
find_docs({ query: "State Prop 装饰器" })
find_docs({ query: "List 列表组件", limit: 20 })
find_docs({ query: "V1V2", limit: 0 })  // 返回所有匹配结果
```

### read_doc

读取文档的完整内容。

**参数：**
- `objectId` (必填): 文档的唯一标识符，从搜索结果中获取

**示例：**
```
read_doc({ objectId: "arkts-state" })
```

### list_doc_topics

列出文档的所有主题分类。

### reload_docs

重新加载文档索引。当文档库更新后调用此工具。

### ask_ai

向华为开发者官方智能问答助手提问。

**参数：**
- `query` (必填): 要问的问题，使用中文效果更好
- `newSession` (可选): 是否开启新会话，默认 false

**示例：**
```
ask_ai({ query: "List组件怎么实现懒加载" })
ask_ai({ query: "Navigation怎么实现页面跳转并传参" })
```

**注意：** 匿名模式有次数限制，可通过 `set_ai_auth` 设置 Cookie 解除限制。

### set_ai_auth

设置 AI 问答的登录凭证。

**参数：**
- `cookie` (必填): 完整的 Cookie 字符串

**获取 Cookie 方法：**
1. 打开浏览器，登录 developer.huawei.com
2. 打开开发者工具 (F12) → Network 标签
3. 在页面上使用智能问答功能提问
4. 找到 `dialog/submission` 请求
5. 复制 Request Headers 中的 Cookie 值

**示例：**
```
set_ai_auth({ cookie: "your_full_cookie_value_here" })
```

### ask_ai_batch

批量并行提问，一次调用处理多个问题。

**参数：**
- `queries` (必填): 问题列表，最多 10 个
- `newSession` (可选): 是否开启新会话，默认 false

**示例：**
```
ask_ai_batch({ queries: ["Navigation组件用法", "List性能优化", "@State和@Prop区别"] })
```

### read_more

读取被截断的完整回答内容。

**参数：**
- `resourceId` (必填): 从 ask_ai 返回结果中获取

**示例：**
```
read_more({ resourceId: "qa-result-1-1706123456789" })
```

## 搜索算法

采用多级索引结构和中文分词：

### 索引结构

| 索引文件 | 结构 | 查找复杂度 | 用途 |
|---------|------|-----------|------|
| `keyword_index.json` | 哈希表 | O(1) | 关键词精确匹配 |
| `catalog_index.json` | 哈希表 | O(1) | 分类精确匹配 |
| `main_index.json` | 哈希表 | O(1) | 文档信息查找 |
| `catalog_*.json` | 哈希表 | O(1) | 分类详情按需加载 |

### 搜索流程

1. **关键词精确匹配** - O(1) 哈希查找
2. **分类精确匹配** - O(1) 哈希查找
3. **分类模糊匹配** - O(k) 遍历分类名（k=分类数量，约135个）
4. **标题/路径匹配** - O(n) 遍历文档（仅在结果不足时触发）

### 权重设置

- **标题匹配**：权重 10 (精确匹配 +5)
- **分类匹配**：权重 8
- **关键词匹配**：权重 10
- **路径匹配**：权重 5

**中文分词**：使用 segmentit 分词库，自动处理连接词（和、与、及、或等）。

### 性能参考

| 文档数 | 搜索耗时 |
|-------|---------|
| 2,000 | ~300ms |
| 10,000 | ~500ms (预估) |
| 100,000 | 需要引入更高级索引 |

如果文档量超过 10 万，建议考虑：
- **Trie 树**：前缀搜索、自动补全
- **B+ 树**：范围查询、磁盘存储优化
- **全文搜索引擎**：如 Meilisearch、Elasticsearch

## 许可证

MIT
