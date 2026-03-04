import * as crypto from 'crypto';

const BASE_URL = 'https://svc-drcn.developer.huawei.com';
const QA_TIMEOUT_MS = parseInt(process.env.ARKTS_QA_TIMEOUT_MS || '120000', 10);

interface StreamResult {
  answer: string;
  thinking: string;
  suggestions: Array<{ title: string; url: string }>;
  stepInfo: string;
}

// 生成 32 位十六进制 ID
// 每次调用都生成新的，完全无状态，避免并发冲突
const generateAnonymousId = (): string => {
  return crypto.randomBytes(16).toString('hex');
};

// 创建新会话
export const createDialog = async (anonymousId: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/intelligentcustomer/v1/public/dialog/id`, {
    method: 'POST',
    signal: AbortSignal.timeout(QA_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/consumer/cn/`
    },
    body: JSON.stringify({
      origin: 0,
      type: 1001,
      anonymousId
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create dialog: ${response.status}`);
  }

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`API error: ${data.message}`);
  }

  return data.result.dialogId;
};

// 发送问题并获取流式响应
export const askQuestion = async (
  query: string,
  dialogId: string,
  anonymousId: string,
  includeThinking: boolean = false
): Promise<StreamResult> => {
  const response = await fetch(`${BASE_URL}/intelligentcustomer/v1/public/dialog/submission`, {
    method: 'POST',
    signal: AbortSignal.timeout(QA_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/consumer/cn/`,
      'Accept': 'text/event-stream'
    },
    body: JSON.stringify({
      type: 1001,
      query,
      dialogId,
      channel: 1,
      origin: 0,
      subType: 2,
      thinkType: 1,
      anonymousId
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to submit question: ${response.status}`);
  }

  const text = await response.text();
  return parseSSEResponse(text, includeThinking);
};

// 解析 SSE 响应
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

      const data = JSON.parse(jsonStr);

      if (data.code !== 0) continue;
      if (!data.result) continue;

      const r = data.result;

      // 最终结果标记
      if (r.isFinal === true && !r.streamingText) {
        break;
      }

      // 更新答案文本
      if (r.streamingText) {
        result.answer = r.streamingText;
      }

      // 更新思考过程
      if (includeThinking && r.thinking) {
        result.thinking = r.thinking;
      }

      // 更新步骤信息
      if (r.stepInfo) {
        result.stepInfo = r.stepInfo;
      }

      // 更新建议链接
      if (r.suggestions && Array.isArray(r.suggestions)) {
        result.suggestions = r.suggestions.map((s: { title: string; url: string }) => ({
          title: s.title.trim(),
          url: s.url
        }));
      }
    } catch (e) {
      // 忽略解析错误
    }
  }

  return result;
};

// 主要的问答函数
// 完全无状态：每次调用都生成新的 anonymousId 和 dialogId
// 优点：1. 并发调用互不干扰  2. 不会因为会话过期而返回空内容  3. 无需文件存储
export const huaweiQA = async (
  query: string,
  _newSession: boolean = false, // 参数保留但不再使用，每次都是新会话
  includeThinking: boolean = false
): Promise<string> => {
  // 每次调用都生成全新的 anonymousId 和 dialogId
  const anonymousId = generateAnonymousId();

  console.error('[huawei-qa] Creating new dialog...');
  const dialogId = await createDialog(anonymousId);

  console.error(`[huawei-qa] Asking: ${query.substring(0, 50)}...`);

  const result = await askQuestion(
    query,
    dialogId,
    anonymousId,
    includeThinking
  );

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
};

// 批量问答函数 - 并行处理多个问题
export const huaweiQABatch = async (
  queries: string[],
  _newSession: boolean = false,
  includeThinking: boolean = false
): Promise<Array<{ query: string; answer: string; success: boolean; error?: string }>> => {
  console.error(`[huawei-qa] Batch processing ${queries.length} questions in parallel...`);

  // 并行处理所有问题
  const results = await Promise.all(
    queries.map(async (query) => {
      try {
        const answer = await huaweiQA(query, _newSession, includeThinking);
        return { query, answer, success: true };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[huawei-qa] Error processing query: "${query.substring(0, 30)}..." - ${errorMsg}`);
        return { query, answer: '', success: false, error: errorMsg };
      }
    })
  );

  const successCount = results.filter(r => r.success).length;
  console.error(`[huawei-qa] Batch completed: ${successCount}/${results.length} successful`);

  return results;
};
