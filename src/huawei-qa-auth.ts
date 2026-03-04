/**
 * 华为智能问答 - 登录态版本
 *
 * 使用登录态 Cookie 调用 API，绕过匿名态的次数限制
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BASE_URL = 'https://svc-drcn.developer.huawei.com';
const QA_TIMEOUT_MS = parseInt(process.env.ARKTS_QA_TIMEOUT_MS || '120000', 10);

// Cookie 配置文件路径
function resolveConfigDir(): string {
  const overrideDir = process.env.ARKTS_MCP_CONFIG_DIR;
  if (overrideDir && overrideDir.trim().length > 0) {
    return overrideDir;
  }

  // Windows: use %APPDATA%\arkts-mcp
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'arkts-mcp');
  }

  // Linux/macOS: prefer XDG, fallback to ~/.config
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg, 'arkts-mcp');
  }

  return path.join(os.homedir(), '.config', 'arkts-mcp');
}

const CONFIG_DIR = resolveConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface Config {
  cookie?: string;
  lastUpdated?: string;
}

interface StreamResult {
  answer: string;
  thinking: string;
  suggestions: Array<{ title: string; url: string }>;
  stepInfo: string;
  dialogRecordId?: string;
}

// ============ Cookie 管理 ============

/**
 * 读取配置
 */
const loadConfig = (): Config => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.error('[huawei-qa-auth] Failed to load config:', e);
  }
  return {};
};

/**
 * 保存配置
 */
const saveConfig = (config: Config): void => {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[huawei-qa-auth] Failed to save config:', e);
  }
};

/**
 * 获取 Cookie
 */
export const getCookie = (): string | null => {
  const config = loadConfig();
  return config.cookie || null;
};

/**
 * 设置 Cookie
 */
export const setCookie = (cookie: string): void => {
  const config = loadConfig();
  config.cookie = cookie;
  config.lastUpdated = new Date().toISOString();
  saveConfig(config);
  console.error('[huawei-qa-auth] Cookie saved successfully');
};

export const getConfigFilePath = (): string => {
  return CONFIG_FILE;
};

/**
 * 检查 Cookie 是否有效（简单验证）
 */
export const validateCookie = async (cookie: string): Promise<boolean> => {
  try {
    // 尝试创建会话来验证 Cookie
    const response = await fetch(`${BASE_URL}/intelligentcustomer/v1/dialog/id`, {
      method: 'POST',
      signal: AbortSignal.timeout(QA_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://developer.huawei.com',
        'Referer': 'https://developer.huawei.com/',
      },
      body: JSON.stringify({
        origin: 0,
        type: 1001,
      })
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.code === 0;
  } catch (e) {
    return false;
  }
};

// ============ API 调用 ============

/**
 * 创建会话（登录态）
 */
const createDialogAuth = async (cookie: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/intelligentcustomer/v1/dialog/id`, {
    method: 'POST',
    signal: AbortSignal.timeout(QA_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://developer.huawei.com',
      'Referer': 'https://developer.huawei.com/',
    },
    body: JSON.stringify({
      origin: 0,
      type: 1001,
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create dialog: ${response.status} - ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`API error: ${data.message || JSON.stringify(data)}`);
  }

  return data.result.dialogId;
};

/**
 * 提交问题（登录态）
 *
 * 必传参数分析：
 * - query: 问题内容（必传）
 * - type: 1001 表示 HarmonyOS 开发问答（必传）
 * - dialogId: 会话 ID（必传）
 * - channel: 1 表示来源渠道（建议传）
 * - origin: 0 表示来源（建议传）
 * - subType: 2 表示子类型（建议传）
 * - thinkType: 1 表示思考类型（可选，开启深度思考）
 */
const askQuestionAuth = async (
  query: string,
  dialogId: string,
  cookie: string,
  includeThinking: boolean = false
): Promise<StreamResult> => {
  const response = await fetch(`${BASE_URL}/intelligentcustomer/v1/dialog/submission`, {
    method: 'POST',
    signal: AbortSignal.timeout(QA_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://developer.huawei.com',
      'Referer': 'https://developer.huawei.com/',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      type: 1001,
      query,
      dialogId,
      channel: 1,
      origin: 0,
      subType: 2,
      thinkType: includeThinking ? 1 : 0,
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to submit question: ${response.status} - ${text.substring(0, 200)}`);
  }

  const text = await response.text();
  return parseSSEResponse(text, includeThinking);
};

/**
 * 解析 SSE 响应
 *
 * 响应格式：
 * data: {"resJson":"{\"code\":0,\"message\":\"success\",\"result\":{...}}","returnCode":"0"}
 */
const parseSSEResponse = (text: string, includeThinking: boolean): StreamResult => {
  const result: StreamResult = {
    answer: '',
    thinking: '',
    suggestions: [],
    stepInfo: ''
  };

  const lines = text.split('\n');

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;

    try {
      const jsonStr = line.substring(6).trim();
      if (!jsonStr) continue;

      // 处理两种可能的响应格式
      let data: Record<string, unknown>;
      const outerData = JSON.parse(jsonStr);

      // 格式1: {"resJson": "{...}", "returnCode": "0"}
      if (outerData.resJson && typeof outerData.resJson === 'string') {
        data = JSON.parse(outerData.resJson);
      }
      // 格式2: 直接的 {"code": 0, "result": {...}}
      else {
        data = outerData;
      }

      if (data.code !== 0) continue;
      if (!data.result) continue;

      const r = data.result as Record<string, unknown>;

      // 记录 dialogRecordId
      if (r.dialogRecordId) {
        result.dialogRecordId = r.dialogRecordId as string;
      }

      // 最终结果标记
      if (r.isFinal === true && !r.streamingText) {
        break;
      }

      // 更新答案文本
      if (r.streamingText) {
        result.answer = r.streamingText as string;
      }

      // 更新思考过程
      if (includeThinking && r.thinking) {
        result.thinking = r.thinking as string;
      }

      // 更新步骤信息
      if (r.stepInfo) {
        result.stepInfo = r.stepInfo as string;
      }

      // 更新建议链接
      if (r.suggestions && Array.isArray(r.suggestions)) {
        result.suggestions = r.suggestions.map((s: { title: string; url: string }) => ({
          title: s.title.trim(),
          url: s.url
        }));
      }
    } catch (e) {
      // 忽略解析错误，继续处理下一行
    }
  }

  return result;
};

// ============ 主函数 ============

/**
 * 登录态问答（主入口）
 *
 * @param query 问题内容
 * @param newSession 是否强制新会话（暂未实现会话复用）
 * @param includeThinking 是否包含思考过程
 * @returns 格式化的答案
 */
export const huaweiQAAuth = async (
  query: string,
  newSession: boolean = false,
  includeThinking: boolean = false
): Promise<string> => {
  // 获取 Cookie
  const cookie = getCookie();

  if (!cookie) {
    return `**错误：未配置登录 Cookie**

请按以下步骤配置：

1. 打开浏览器，登录 [华为开发者联盟](https://developer.huawei.com)
2. 打开开发者工具 (F12) → Network 标签
3. 在页面上使用智能问答功能提问
4. 找到 \`dialog/submission\` 请求
5. 复制 Request Headers 中的 \`Cookie\` 值
6. 将 Cookie 保存到配置文件：
   \`${CONFIG_FILE}\`

配置文件格式：
\`\`\`json
{
  "cookie": "你的完整 Cookie 值"
}
\`\`\`
`;
  }

  try {
    // 创建新会话
    console.error('[huawei-qa-auth] Creating dialog with auth...');
    const dialogId = await createDialogAuth(cookie);
    console.error(`[huawei-qa-auth] Dialog created: ${dialogId}`);

    // 提问
    console.error(`[huawei-qa-auth] Asking: ${query.substring(0, 50)}...`);
    const result = await askQuestionAuth(query, dialogId, cookie, includeThinking);

    // 格式化输出
    let output = result.answer;

    if (result.suggestions.length > 0) {
      output += '\n\n---\n**参考链接：**\n';
      result.suggestions.forEach((s, i) => {
        output += `${i + 1}. [${s.title}](${s.url})\n`;
      });
    }

    if (includeThinking && result.thinking) {
      output += '\n\n---\n<details><summary>思考过程</summary>\n\n';
      output += result.thinking;
      output += '\n\n</details>';
    }

    return output;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // 检查是否是认证错误
    if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
      return `**错误：Cookie 已过期或无效**

请重新获取 Cookie 并更新配置文件：
\`${CONFIG_FILE}\`

获取方法：
1. 重新登录 developer.huawei.com
2. 从开发者工具复制新的 Cookie
`;
    }

    throw error;
  }
};

// ============ 批量处理 ============

/**
 * 批量问答（登录态）
 * 并行处理多个问题，提升效率
 */
export const huaweiQAAuthBatch = async (
  queries: string[],
  newSession: boolean = false,
  includeThinking: boolean = false
): Promise<Array<{ query: string; answer: string; success: boolean; error?: string }>> => {
  console.error(`[huawei-qa-auth] Batch processing ${queries.length} questions in parallel...`);

  // 并行处理所有问题
  const results = await Promise.all(
    queries.map(async (query) => {
      try {
        const answer = await huaweiQAAuth(query, newSession, includeThinking);
        return { query, answer, success: true };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[huawei-qa-auth] Error processing query: "${query.substring(0, 30)}..." - ${errorMsg}`);
        return { query, answer: '', success: false, error: errorMsg };
      }
    })
  );

  const successCount = results.filter(r => r.success).length;
  console.error(`[huawei-qa-auth] Batch completed: ${successCount}/${results.length} successful`);

  return results;
};

// ============ 导出兼容接口 ============

/**
 * 统一入口：优先使用登录态，失败则降级到匿名态
 */
export const huaweiQASmart = async (
  query: string,
  newSession: boolean = false,
  includeThinking: boolean = false
): Promise<string> => {
  const cookie = getCookie();

  if (cookie) {
    try {
      return await huaweiQAAuth(query, newSession, includeThinking);
    } catch (error) {
      console.error('[huawei-qa] Auth mode failed, falling back to anonymous mode:', error);
    }
  }

  // 降级到匿名态（导入原有模块）
  const { huaweiQA } = await import('./huawei-qa.js');
  return huaweiQA(query, newSession, includeThinking);
};
