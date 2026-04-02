#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { DocsSearcher } from './search.js';
import { huaweiQA, huaweiQABatch } from './huawei-qa.js';
import { huaweiQAAuth, huaweiQAAuthBatch, getConfigFilePath, getCookie, setCookie, validateCookie } from './huawei-qa-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find package root by looking for package.json
function findPackageRoot(startDir: string): string {
  let currentDir = startDir;
  while (currentDir !== path.parse(currentDir).root) {
    const pkgJsonPath = path.join(currentDir, 'package.json');
    try {
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (pkg.name === 'arkts-assistant-mcp-server') {
          return currentDir;
        }
      }
    } catch {
      // Continue searching
    }
    currentDir = path.dirname(currentDir);
  }
  // Fallback to relative path
  return path.resolve(__dirname, '../static/docs');
}

// Default docs directory (static/docs subdirectory)
const packageRoot = findPackageRoot(__dirname);
const DEFAULT_DOCS_DIR = path.join(packageRoot, 'static/docs');

// Allow override via environment variable
const DOCS_DIR = process.env.ARKTS_DOCS_DIR || DEFAULT_DOCS_DIR;

const searcher = new DocsSearcher(DOCS_DIR);

// ============ Resource Cache for Long QA Results ============
const CONTENT_THRESHOLD = 1500; // Characters threshold for truncation
const resourceCache = new Map<string, { content: string; query: string; timestamp: number }>();
let resourceIdCounter = 0;

function generateResourceId(): string {
  return `qa-result-${++resourceIdCounter}-${Date.now()}`;
}

function addToResourceCache(query: string, content: string): string {
  const resourceId = generateResourceId();
  resourceCache.set(resourceId, {
    content,
    query,
    timestamp: Date.now()
  });

  // Clean up old resources (older than 1 hour)
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, data] of resourceCache.entries()) {
    if (data.timestamp < oneHourAgo) {
      resourceCache.delete(id);
    }
  }

  return resourceId;
}

function getAvailableResources(): Resource[] {
  return Array.from(resourceCache.entries()).map(([id, data]) => ({
    uri: `arkts-qa://${id}`,
    name: `QA: ${data.query.substring(0, 50)}${data.query.length > 50 ? '...' : ''}`,
    description: `华为智能问答结果 - ${new Date(data.timestamp).toLocaleString()}`,
    mimeType: 'text/markdown'
  }));
}

// Define MCP tools
const TOOLS: Tool[] = [
  {
    name: 'find_docs',
    description: `搜索 ArkTS 开发文档。

## 使用场景
当用户询问以下内容时，应主动使用此工具搜索相关文档：
- ArkTS 语法特性和语言约束
- ArkUI 组件用法（Button、Text、Column、Row、List、Grid 等）
- 状态管理装饰器（@State、@Prop、@Link、@Observed、@ObjectLink 等）
- 动画和转场效果
- 导航和路由
- 系统能力和 API
- 错误码和问题排查

## 使用示例

示例1 - 用户问："@State 和 @Prop 有什么区别？"
调用：find_docs({ query: "State Prop 装饰器" })

示例2 - 用户问："怎么实现页面跳转？"
调用：find_docs({ query: "Navigation 路由 页面跳转" })

示例3 - 用户问："List 组件怎么用？"
调用：find_docs({ query: "List 列表组件" })

## 搜索技巧
- 使用中文关键词效果更好
- 可以组合多个关键词，用空格分隔
- 搜索组件时加上"组件"后缀
- 搜索装饰器时可以带@符号

返回匹配的文档列表，包含标题、预览和 objectId（用于 read_doc 获取完整内容）。`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，支持中英文，多个关键词用空格分隔。例如："State管理"、"Button组件"、"Navigation路由"'
        },
        limit: {
          type: 'number',
          description: '返回结果数量，默认50条。设为0返回所有结果（最多1000条），传正数则限制在1-1000之间。',
          default: 50
        }
      },
      required: ['query']
    }
  },
  {
    name: 'read_doc',
    description: `读取文档的完整内容。

## 使用场景
在使用 find_docs 搜索后，根据返回的 objectId 读取文档的完整 Markdown 内容。

## 使用流程
1. 先调用 find_docs 搜索相关文档
2. 从搜索结果中选择最相关的文档
3. 使用该文档的 objectId 调用此工具获取完整内容

## 使用示例

示例 - 搜索后读取完整文档：
1. 调用：find_docs({ query: "State装饰器" })
2. 从结果中找到 objectId: "arkts-state"
3. 调用：read_doc({ objectId: "arkts-state" })

返回文档的完整 Markdown 内容，包含代码示例和详细说明。`,
    inputSchema: {
      type: 'object',
      properties: {
        objectId: {
          type: 'string',
          description: '文档的唯一标识符，从 find_docs 的搜索结果中获取'
        }
      },
      required: ['objectId']
    }
  },
  {
    name: 'list_doc_topics',
    description: `列出文档的所有主题分类。

## 使用场景
- 了解文档库的整体结构
- 查看有哪些主题分类
- 统计各分类的文档数量

返回所有主题分类及其文档数量。`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'reload_docs',
    description: `重新加载文档索引。

## 使用场景
当文档库更新后，使用此工具重新加载索引，使搜索结果包含最新文档。

返回重新加载后的文档总数。`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'ask_ai',
    description: `向华为开发者官方智能问答助手提问。

## 使用场景
当需要获取更全面、更权威的鸿蒙开发答案时使用此工具：
- 复杂的开发问题（整合了官方文档 + 社区经验）
- 需要代码示例和最佳实践
- 错误排查和问题解决
- 获取最新的开发建议

## 与 find_docs 的区别
- find_docs：搜索本地文档，返回原始文档内容
- ask_ai：调用华为官方 AI，返回整合后的智能回答

## 使用示例

示例1 - 用户问："Navigation 怎么实现页面跳转并传参？"
调用：ask_ai({ query: "Navigation 怎么实现页面跳转并传参" })

示例2 - 用户问："List 组件性能优化有哪些方法？"
调用：ask_ai({ query: "List 组件性能优化方法" })

返回华为官方智能助手的回答，包含参考链接。`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要问的问题，使用中文效果更好'
        },
        newSession: {
          type: 'boolean',
          description: '是否开启新会话（默认 false，复用之前的会话上下文）',
          default: false
        }
      },
      required: ['query']
    }
  },
  {
    name: 'set_ai_auth',
    description: `设置 AI 问答的登录凭证，用于突破匿名态的次数限制。

## 使用场景
当 ask_ai 提示次数限制或需要登录时，使用此工具设置登录凭证。

## 如何获取 Cookie
1. 打开浏览器，登录 developer.huawei.com
2. 打开开发者工具 (F12) → Network 标签
3. 在页面上使用智能问答功能提问
4. 找到 dialog/submission 请求
5. 复制 Request Headers 中的 Cookie 值

## 使用示例
set_ai_auth({ cookie: "your_full_cookie_value_here" })

设置成功后，后续的 ask_ai 调用将使用登录态，无次数限制。`,
    inputSchema: {
      type: 'object',
      properties: {
        cookie: {
          type: 'string',
          description: '完整的 Cookie 字符串，从浏览器开发者工具中复制'
        }
      },
      required: ['cookie']
    }
  },
  {
    name: 'ask_ai_batch',
    description: `批量向华为开发者官方智能问答助手提问（并行处理）。

## 使用场景
当需要同时查询多个问题时使用此工具：
- 一次调用处理多个相关问题
- 服务器端并行执行，大幅节省时间
- 适用于需要查询多个不同主题的场景

## 与 ask_ai 的区别
- ask_ai：单次提问，多个问题需要多次调用
- ask_ai_batch：批量提问，一次调用处理多个问题（并行执行）

## 使用示例

示例1 - 批量查询不同主题：
调用：ask_ai_batch({ queries: ["Navigation 组件用法", "List 性能优化", "@State 和 @Prop 区别"] })

示例2 - 批量查询相关问题：
调用：ask_ai_batch({ queries: ["如何实现页面跳转", "如何传递参数", "如何返回数据"] })

## 性能优势
假设单个问题响应时间 60 秒：
- 串行调用 3 个问题：60s + 60s + 60s = 180 秒
- 批量并行调用：约 60 秒（取决于最慢的问题）`,
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: '问题列表，支持中英文。例如：["Navigation 组件用法", "List 性能优化"]'
        },
        newSession: {
          type: 'boolean',
          description: '是否开启新会话（默认 false，复用之前的会话上下文）',
          default: false
        }
      },
      required: ['queries']
    }
  },
  {
    name: 'read_more',
    description: `读取被截断的完整回答内容。

## 使用场景
当 ask_ai 返回的内容被截断时，使用此工具读取完整内容。

## 使用流程
1. 调用 ask_ai 获取回答
2. 如果回答中包含 "内容过长已缓存" 的提示和 resourceId
3. 使用该 resourceId 调用此工具读取完整内容

## 使用示例
read_more({ resourceId: "qa-result-1-1706123456789" })

返回完整的 Markdown 格式回答内容。`,
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'string',
          description: '资源 ID，从 ask_ai 的回答中获取'
        }
      },
      required: ['resourceId']
    }
  }
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'find_docs': {
      const query = args.query as string;
      // limit: 默认50，传0表示不限制（最多1000），传正数则限制在1-1000之间
      let limit: number;
      if (args.limit === undefined || args.limit === null) {
        limit = 50;  // 默认50条
      } else if (args.limit === 0) {
        limit = 0;   // 0表示不限制
      } else {
        limit = Math.max(1, Math.min(args.limit as number, 1000));  // 1-1000之间
      }

      const results = searcher.search(query, limit);

      if (results.length === 0) {
        return `未找到匹配 "${query}" 的文档。\n\n建议：\n- 尝试使用不同的关键词\n- 使用更通用的搜索词\n- 检查文档索引是否已创建`;
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   objectId: ${r.objectId}\n   预览: ${r.preview}\n   URL: ${r.url}`
      ).join('\n\n');

      return `找到 ${results.length} 个相关文档：\n\n${formatted}`;
    }

    case 'read_doc': {
      const objectId = args.objectId as string;
      const result = searcher.getDocByObjectId(objectId);

      if (!result) {
        return `未找到文档: ${objectId}\n\n请先使用 find_docs 搜索获取正确的 objectId。`;
      }

      return `# ${result.metadata.title}\n\nURL: ${result.metadata.url}\n\n---\n\n${result.content}`;
    }

    case 'list_doc_topics': {
      const topics = searcher.listTopics();
      const total = searcher.getTotalDocs();

      if (topics.length === 0) {
        return `当前文档库为空或索引未创建。\n\n请运行: npm run generate-index 生成索引文件。`;
      }

      const formatted = topics.map(t => `- ${t.topic}: ${t.count} 个文档`).join('\n');

      return `文档总数: ${total}\n\n主题分类:\n${formatted}`;
    }

    case 'reload_docs': {
      searcher.reloadIndex();
      const total = searcher.getTotalDocs();
      return `文档索引已重新加载，当前共有 ${total} 个文档。`;
    }

    case 'ask_ai': {
      const query = args.query as string;
      const newSession = (args.newSession as boolean) || false;

      try {
        // 优先使用登录态
        const cookie = getCookie();
        let answer: string;

        if (cookie) {
          console.error('[arkts-assistant] Using authenticated mode for Huawei QA');
          try {
            answer = await huaweiQAAuth(query, newSession);
          } catch (authError) {
            console.error('[arkts-assistant] Auth mode failed, falling back to anonymous:', authError);
            answer = await huaweiQA(query, newSession);
          }
        } else {
          console.error('[arkts-assistant] Using anonymous mode for Huawei QA (no cookie configured)');
          answer = await huaweiQA(query, newSession);
        }

        // Check if content exceeds threshold
        if (answer.length > CONTENT_THRESHOLD) {
          const resourceId = addToResourceCache(query, answer);
          const preview = answer.substring(0, CONTENT_THRESHOLD);
          const lastNewline = preview.lastIndexOf('\n');
          const cleanPreview = lastNewline > CONTENT_THRESHOLD * 0.5 ? preview.substring(0, lastNewline) : preview;

          return `${cleanPreview}\n\n---\n**⚠️ 内容过长已缓存**\n\n完整回答共 ${answer.length} 字符，已超出显示限制。\n\n**获取完整内容方式：**\n调用工具：\`read_more({ resourceId: "${resourceId}" })\`\n\n> 提示：缓存有效期为 1 小时`;
        }

        return answer;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return `华为智能问答调用失败: ${errorMsg}\n\n建议使用 find_docs 搜索本地文档作为备选。`;
      }
    }

    case 'read_more': {
      const resourceId = args.resourceId as string;

      if (!resourceId) {
        return '错误：resourceId 参数不能为空';
      }

      const resource = resourceCache.get(resourceId);
      if (!resource) {
        return `未找到资源: ${resourceId}\n\n可能的原因：\n1. 资源 ID 不正确\n2. 资源已过期（超过1小时）\n\n请重新调用 ask_ai 获取新的回答。`;
      }

      return resource.content;
    }

    case 'set_ai_auth': {
      const cookie = args.cookie as string;

      if (!cookie || cookie.trim().length === 0) {
        return '错误：Cookie 不能为空';
      }

      try {
        // 先保存 Cookie（无论验证结果如何都保存）
        setCookie(cookie);

        // 验证 Cookie 是否有效
        console.error('[arkts-assistant] Validating cookie...');
        const isValid = await validateCookie(cookie);

        if (isValid) {
          return `✅ Cookie 设置成功！

Cookie 已验证有效并保存。后续的 ask_ai 调用将使用登录态，无次数限制。

配置文件位置：
${getConfigFilePath()}`;
        } else {
          return `⚠️ Cookie 已保存，但验证未通过

Cookie 已保存到配置文件，但 API 验证失败。可能的原因：
1. Cookie 刚过期，请重新登录获取
2. Cookie 格式不完整，请确保复制了完整的 Cookie 字符串
3. 网络问题，验证请求失败

配置文件位置：
${getConfigFilePath()}

您可以尝试使用 ask_ai 测试是否正常工作。`;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return `设置 Cookie 时发生错误: ${errorMsg}`;
      }
    }

    case 'ask_ai_batch': {
      const queries = args.queries as string[];
      const newSession = (args.newSession as boolean) || false;

      if (!queries || !Array.isArray(queries) || queries.length === 0) {
        return '错误：queries 参数必须是非空数组';
      }

      if (queries.length > 10) {
        return '错误：最多支持同时提问 10 个问题';
      }

      try {
        // 优先使用登录态
        const cookie = getCookie();
        let results: Array<{ query: string; answer: string; success: boolean; error?: string }>;

        if (cookie) {
          console.error('[arkts-assistant] Using authenticated mode for Huawei QA batch');
          try {
            results = await huaweiQAAuthBatch(queries, newSession);
          } catch (authError) {
            console.error('[arkts-assistant] Auth mode failed, falling back to anonymous:', authError);
            results = await huaweiQABatch(queries, newSession);
          }
        } else {
          console.error('[arkts-assistant] Using anonymous mode for Huawei QA batch (no cookie configured)');
          results = await huaweiQABatch(queries, newSession);
        }

        // 格式化输出
        let output = `## 批量问答结果 (${results.length} 个问题)\n\n`;

        results.forEach((result, index) => {
          output += `### 问题 ${index + 1}: ${result.query}\n\n`;

          if (result.success) {
            // Check if content exceeds threshold
            if (result.answer.length > CONTENT_THRESHOLD) {
              const resourceId = addToResourceCache(result.query, result.answer);
              const preview = result.answer.substring(0, 500);
              const lastNewline = preview.lastIndexOf('\n');
              const cleanPreview = lastNewline > 250 ? preview.substring(0, lastNewline) : preview;

              output += `${cleanPreview}\n\n...**内容过长已缓存** (共 ${result.answer.length} 字符)\n`;
              output += `调用 \`read_more({ resourceId: "${resourceId}" })\` 获取完整内容\n\n`;
            } else {
              output += `${result.answer}\n\n`;
            }
          } else {
            output += `❌ 失败: ${result.error || 'Unknown error'}\n\n`;
          }

          output += `---\n\n`;
        });

        const successCount = results.filter(r => r.success).length;
        output += `> 统计：${successCount}/${results.length} 个问题成功回答`;

        return output;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return `批量问答调用失败: ${errorMsg}\n\n建议使用 find_docs 搜索本地文档作为备选。`;
      }
    }

    default:
      return `未知工具: ${name}`;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--http')) {
    // HTTP mode
    const { startHttpServer } = await import('./http-server.js');
    startHttpServer(searcher);
  } else {
    // stdio mode (default)
    const server = new Server(
      {
        name: 'arkts-assistant-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await handleToolCall(name, args || {});
      return {
        content: [{ type: 'text', text: result }],
      };
    });

    // Resource handlers
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: getAvailableResources(),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const match = uri.match(/^arkts-qa:\/\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }

      const resourceId = match[1];
      const resource = resourceCache.get(resourceId);

      if (!resource) {
        throw new Error(`Resource not found: ${resourceId}`);
      }

      return {
        contents: [{
          uri,
          mimeType: 'text/markdown',
          text: resource.content
        }]
      };
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('[arkts-assistant] Server started in stdio mode');
  }
}

main().catch((error) => {
  console.error('[arkts-assistant] Fatal error:', error);
  process.exit(1);
});

export { handleToolCall, TOOLS };
