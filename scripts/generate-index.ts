#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 类型定义
// ============================================================

interface DocIndex {
  title: string;
  headings: string[];
  preview: string;
  char_count: number;
  image_count: number;
  url: string;
  path: string;
  rel_path: string;
  catalog: string;
  objectId: string;
  nodeName: string;
  keywords: string[];  // 新增：关键词
}

// 倒排索引：关键词 -> 文档ID列表
interface InvertedIndex {
  [keyword: string]: string[];
}

// 分类索引：使用对象而非数组，支持 O(1) 查找
interface CatalogIndex {
  [objectId: string]: DocIndex;
}

// 元数据
interface IndexMetadata {
  version: string;
  generatedAt: string;
  totalDocs: number;
  totalKeywords: number;
  catalogs: {
    name: string;
    count: number;
    file: string;
  }[];
}

interface GenerateOptions {
  docsDir: string;
  outputDir: string;
  fileExtensions: string[];
  maxPreviewLength: number;
}

// ============================================================
// 中文分词与关键词提取
// ============================================================

// 停用词表（英文统一使用小写）
const STOP_WORDS = new Set([
  // 单字停用词
  '的', '是', '在', '和', '了', '与', '及', '等', '中', '为',
  '对', '将', '可', '以', '能', '也', '并', '或', '如', '该',
  '此', '其', '这', '那', '有', '被', '从', '到', '由', '按',
  '个', '一', '不', '无', '多', '少', '大', '小', '上', '下',
  '来', '去', '说', '看', '做', '用', '当', '会', '要', '让',
  // 双字停用词
  '通过', '可以', '需要', '如果', '一个', '这个', '进行', '使用',
  '支持', '包含', '如下', '例如', '说明', '注意', '如下所示',
  '方法', '参数', '返回', '类型', '对象', '接口', '功能', '系统',
  '应用', '开发', '调用', '设置', '获取', '创建', '添加', '删除',
  '说明', '描述', '定义', '数据', '信息', '值', '名称', '以下',
  // 文件扩展名
  'txt', 'md', 'json', 'markdown', 'html', 'xml', 'css', 'js', 'ts',
  // URL相关
  'https', 'http', 'www', 'com', 'cn', 'org', 'net', 'io',
  'huawei', 'developer', 'consumer', 'harmonyos', 'guides',
  // 设备类型
  'phone', 'pc', 'tablet', 'tv', 'wearable', '2in1',
  'tvw', 'earable',
  // 通用词
  'guide', 'api', 'doc', 'docs', 'index', 'readme',
  'version', 'arkts',
  'apis', 'section', 'overview',
  // 代码关键字
  'this', 'from', 'import', 'export',
  // 无用缩写/残留
  'cc', 'oh', 'bility', 'uia', 'fa',
  // 工具名
  'dev', 'eco', 'studio', 'deveco',
  // 其他
  'huks', 'hunks', 'ark'
]);

// 技术关键词优先级提升
const TECH_KEYWORDS = new Set([
  // API 模块名
  'ohos', 'arkui', 'typescript', 'javascript',
  'ability', 'activity', 'service', 'provider', 'manager',
  'bundle', 'resource', 'storage', 'database', 'network',
  'camera', 'audio', 'video', 'image', 'media', 'sensor',
  'bluetooth', 'wifi', 'nfc', 'usb', 'serial',
  // 常用类名
  'component', 'page', 'window', 'dialog', 'button', 'text',
  'image', 'list', 'grid', 'scroll', 'swiper', 'tabs',
  'animation', 'gesture', 'event', 'state', 'prop', 'builder',
  // 技术术语
  'async', 'await', 'promise', 'callback', 'emit', 'subscribe',
  'permission', 'security', 'privacy', 'encrypt', 'decrypt',
  'http', 'rest', 'json', 'xml', 'websocket', 'socket'
]);

// 提取关键词
function extractKeywords(text: string, title: string, maxKeywords: number = 15): string[] {
  const wordCount = new Map<string, number>();

  // 1. 提取 API 模块名（如 @ohos.xxx）
  const apiMatches = text.match(/@ohos\.[a-zA-Z]+/g) || [];
  const titleApiMatches = title.match(/@ohos\.[a-zA-Z]+/g) || [];
  for (const api of [...apiMatches, ...titleApiMatches]) {
    wordCount.set(api, (wordCount.get(api) || 0) + 10); // 高权重
  }

  // 2. 提取英文技术词汇
  const englishWords = text.match(/[A-Z][a-z]+|[A-Z]{2,}|[a-z]{3,}/g) || [];
  for (const word of englishWords) {
    const lower = word.toLowerCase();
    if (!STOP_WORDS.has(lower) && word.length >= 2) {
      const weight = TECH_KEYWORDS.has(lower) ? 5 : 1;
      wordCount.set(word, (wordCount.get(word) || 0) + weight);
    }
  }

  // 3. 提取中文词汇（2-4字的组合）
  const chineseWords = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  for (const word of chineseWords) {
    if (!STOP_WORDS.has(word)) {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    }
  }

  // 4. 从标题提取关键词（高权重）
  const titleWords = title.match(/[\u4e00-\u9fa5]+|[A-Za-z]+/g) || [];
  for (const word of titleWords) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) {
      wordCount.set(word, (wordCount.get(word) || 0) + 8);
    }
  }

  // 5. 按权重排序
  return Array.from(wordCount.entries())
    .filter(([word]) => !STOP_WORDS.has(word.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

// ============================================================
// 内容提取
// ============================================================

// 提取标题
function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match) {
      const heading = match[1].trim()
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
      if (heading && heading.length < 50) {
        headings.push(heading);
      }
    }
    if (headings.length >= 15) break;
  }

  return headings;
}

// 提取预览文本
function extractPreview(content: string, maxLength: number = 300): string {
  const lines = content.split('\n');
  let text = '';
  let inCatalog = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 检测目录开始
    if (trimmed === '## 目录' || trimmed === '##目录') {
      inCatalog = true;
      continue;
    }

    // 检测目录结束
    if (inCatalog && trimmed.startsWith('## ') && !trimmed.startsWith('###')) {
      inCatalog = false;
    }

    // 跳过目录内容
    if (inCatalog) {
      if (trimmed === '' || trimmed.startsWith('- [') || trimmed.startsWith('-[')) {
        continue;
      }
      if (!trimmed.startsWith('-') && !trimmed.startsWith('*')) {
        inCatalog = false;
      } else {
        continue;
      }
    }

    text += line + '\n';
  }

  // 清理文本
  text = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/[|※▶►]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 截断
  if (text.length > maxLength) {
    text = text.substring(0, maxLength);
    const lastPeriod = Math.max(text.lastIndexOf('。'), text.lastIndexOf('.'));
    if (lastPeriod > maxLength * 0.5) {
      text = text.substring(0, lastPeriod + 1);
    }
  }

  return text;
}

// 生成 objectId
function generateObjectId(title: string, catalog: string, fileName: string): string {
  let objectId = fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);

  if (!objectId || /^[\u4e00-\u9fa5]/.test(fileName)) {
    objectId = title
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 60);

    if (/^[\u4e00-\u9fa5]/.test(objectId)) {
      const hash = (str: string): string => {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
          h = ((h << 5) - h + str.charCodeAt(i)) | 0;
        }
        return Math.abs(h).toString(36);
      };
      objectId = `doc-${hash(fileName + title)}`;
    }
  }

  return objectId || `doc-${Date.now().toString(36)}`;
}

// 从文件内容顶部提取URL
// 支持格式：
// 1. # [标题](URL) - 标准markdown标题链接
// 2. [标题](URL) - 纯链接（可能有多个）
function extractTopUrl(content: string): { url: string; title: string } | null {
  const firstLine = content.split('\n')[0].trim();

  // 格式1: # [标题](URL)
  const headerMatch = firstLine.match(/^#\s*\[([^\]]+)\]\(([^)]+)\)$/);
  if (headerMatch) {
    return {
      title: headerMatch[1].trim(),
      url: headerMatch[2].trim()
    };
  }

  // 格式2: [标题](URL) - 提取第一个链接
  const linkMatch = firstLine.match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (linkMatch) {
    return {
      title: linkMatch[1].trim(),
      url: linkMatch[2].trim()
    };
  }

  return null;
}

// 从文件名提取标题
function extractTitleFromFileName(fileName: string): string {
  let result = fileName.replace(/\.[^.]+$/, '');
  result = result.replace(/^【[^】]+】\s*/g, '');

  const parts = result.split('_');
  if (parts.length > 1) {
    const lastPart = parts[parts.length - 1];
    if (lastPart && (lastPart.includes('@') || lastPart.includes('(') || /[a-zA-Z]/.test(lastPart))) {
      result = lastPart;
    }
  }

  return result.trim();
}

// ============================================================
// 文件处理
// ============================================================

// 从路径中提取有意义的目录名作为关键词
function extractPathKeywords(relPath: string): string[] {
  const keywords: string[] = [];
  const parts = relPath.split('/');

  for (const part of parts) {
    // 提取版本号（如 V1、V2）- 保留大小写
    const versionMatch = part.match(/V\d+/gi);
    if (versionMatch) {
      keywords.push(...versionMatch.filter(w => !STOP_WORDS.has(w.toLowerCase())));
    }

    // 提取英文关键词（如 ArkUI、Kit 等）
    const englishMatch = part.match(/[A-Za-z]+/g);
    if (englishMatch) {
      keywords.push(...englishMatch.filter(w =>
        w.length >= 2 &&
        w.length <= 30 &&
        !STOP_WORDS.has(w.toLowerCase())
      ));
    }

    // 提取中文关键词（连续的中文字符）
    const chineseMatch = part.match(/[\u4e00-\u9fa5]+/g);
    if (chineseMatch) {
      keywords.push(...chineseMatch.filter(w =>
        w.length >= 2 &&
        w.length <= 10 &&
        !STOP_WORDS.has(w)
      ));
    }
  }

  return [...new Set(keywords)];
}

// 从分类名提取关键词
function extractCatalogKeywords(catalog: string): string[] {
  const keywords: string[] = [];

  // 提取版本号（V1、V2等）
  const versionMatch = catalog.match(/V\d+/gi);
  if (versionMatch) {
    keywords.push(...versionMatch.filter(w => !STOP_WORDS.has(w.toLowerCase())));
  }

  // 提取英文关键词
  const englishMatch = catalog.match(/[A-Za-z]+/g);
  if (englishMatch) {
    keywords.push(...englishMatch.filter(w =>
      w.length >= 2 &&
      !STOP_WORDS.has(w.toLowerCase())
    ));
  }

  // 提取中文关键词（连续的中文字符）
  const chineseMatch = catalog.match(/[\u4e00-\u9fa5]+/g);
  if (chineseMatch) {
    keywords.push(...chineseMatch.filter(w =>
      w.length >= 2 &&
      !STOP_WORDS.has(w)
    ));
  }

  return [...new Set(keywords)];
}

function processFile(filePath: string, docsDir: string, catalog: string): DocIndex | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    const relPath = path.relative(docsDir, filePath).replace(/\\/g, '/');

    // 尝试从文件顶部提取URL和标题（新格式）
    const topInfo = extractTopUrl(content);

    // 提取标题
    let title = fileName
      .replace(/\.[^.]+$/, '')
      .replace(/_/g, ' ')
      .replace(/-/g, ' ');

    // 如果顶部有链接格式的标题，优先使用
    if (topInfo && topInfo.title) {
      title = topInfo.title;
    } else {
      const fileTitle = extractTitleFromFileName(fileName);
      if (fileTitle && fileTitle.length > 2) {
        title = fileTitle;
      }
    }

    // 提取其他信息
    const headings = extractHeadings(content);
    const preview = extractPreview(content);
    const charCount = content.length;
    const imageCount = (content.match(/!\[|<img/g) || []).length;
    const objectId = generateObjectId(title, catalog, fileName);

    // 提取关键词（使用标题和预览文本）
    let keywords = extractKeywords(preview + ' ' + content.substring(0, 2000), title);

    // 添加分类关键词
    const catalogKeywords = extractCatalogKeywords(catalog);
    for (const kw of catalogKeywords) {
      if (!keywords.includes(kw)) {
        keywords.push(kw);
      }
    }

    // 添加路径关键词
    const pathKeywords = extractPathKeywords(relPath);
    for (const kw of pathKeywords) {
      if (!keywords.includes(kw)) {
        keywords.push(kw);
      }
    }

    return {
      title,
      headings,
      preview,
      char_count: charCount,
      image_count: imageCount,
      url: topInfo ? topInfo.url : '',  // 如果有顶部URL则使用，否则为空
      path: '',
      rel_path: relPath,
      catalog,
      objectId,
      nodeName: 'document',
      keywords
    };
  } catch (error) {
    console.error(`处理文件失败: ${filePath}`, error);
    return null;
  }
}

// ============================================================
// 目录扫描
// ============================================================

function scanDirectory(docsDir: string, extensions: string[]): DocIndex[] {
  const results: DocIndex[] = [];

  function walk(dir: string) {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        if (!item.startsWith('.') && item !== 'node_modules') {
          walk(fullPath);
        }
      } else if (stat.isFile()) {
        const ext = path.extname(item).toLowerCase();
        if (extensions.includes(ext)) {
          const relPath = path.relative(docsDir, fullPath);
          const parts = relPath.split(path.sep);
          let catalog = '未分类';

          // 根据路径确定分类
          if (parts.length >= 2) {
            for (let i = parts.length - 2; i >= 0; i--) {
              if (parts[i] !== 'guide' && parts[i] !== 'api' && !parts[i].startsWith('.')) {
                catalog = parts[i];
                break;
              }
            }
          }

          console.log(`处理: ${relPath}`);
          const docIndex = processFile(fullPath, docsDir, catalog);
          if (docIndex) {
            results.push(docIndex);
          }
        }
      }
    }
  }

  walk(docsDir);
  return results;
}

// ============================================================
// 索引生成与写入
// ============================================================

function buildInvertedIndex(docs: DocIndex[]): InvertedIndex {
  const invertedIndex: Map<string, string[]> = new Map();

  for (const doc of docs) {
    for (const keyword of doc.keywords) {
      const lowerKeyword = keyword.toLowerCase();
      if (!invertedIndex.has(lowerKeyword)) {
        invertedIndex.set(lowerKeyword, []);
      }
      invertedIndex.get(lowerKeyword)!.push(doc.objectId);
    }
  }

  // 转换为普通对象
  const result: InvertedIndex = {};
  for (const [key, value] of invertedIndex.entries()) {
    result[key] = value;
  }

  return result;
}

function buildCatalogIndex(docs: DocIndex[]): CatalogIndex {
  const index: CatalogIndex = {};
  for (const doc of docs) {
    index[doc.objectId] = doc;
  }
  return index;
}

function saveIndexFiles(
  docs: DocIndex[],
  outputDir: string
): IndexMetadata {
  // 确保输出目录存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 按分类分组
  const catalogGroups = new Map<string, DocIndex[]>();
  for (const doc of docs) {
    const list = catalogGroups.get(doc.catalog) || [];
    list.push(doc);
    catalogGroups.set(doc.catalog, list);
  }

  // 清理旧的分类索引文件
  const existingFiles = fs.readdirSync(outputDir);
  for (const file of existingFiles) {
    if (file.startsWith('catalog_') && file.endsWith('.json')) {
      fs.unlinkSync(path.join(outputDir, file));
    }
  }

  // 写入各分类索引
  const catalogInfo: IndexMetadata['catalogs'] = [];

  for (const [catalog, catalogDocs] of catalogGroups.entries()) {
    // 分类文件名（处理特殊字符）
    const safeName = catalog
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 50);
    const fileName = `catalog_${safeName}.json`;
    const filePath = path.join(outputDir, fileName);

    // 构建分类索引（Map 结构）
    const catalogIndex = buildCatalogIndex(catalogDocs);

    fs.writeFileSync(filePath, JSON.stringify(catalogIndex, null, 2), 'utf-8');

    catalogInfo.push({
      name: catalog,
      count: catalogDocs.length,
      file: fileName
    });

    console.log(`  分类 [${catalog}]: ${catalogDocs.length} 个文档 -> ${fileName}`);
  }

  // 构建并写入倒排索引
  console.log('\n构建关键词倒排索引...');
  const invertedIndex = buildInvertedIndex(docs);
  const keywordIndexFile = path.join(outputDir, 'keyword_index.json');
  fs.writeFileSync(keywordIndexFile, JSON.stringify(invertedIndex, null, 2), 'utf-8');
  console.log(`  关键词总数: ${Object.keys(invertedIndex).length}`);

  // 构建分类索引（分类名 -> 文档ID列表）
  console.log('\n构建分类索引...');
  const catalogIndex: { [catalogName: string]: string[] } = {};
  for (const doc of docs) {
    const catalogName = doc.catalog.toLowerCase();
    if (!catalogIndex[catalogName]) {
      catalogIndex[catalogName] = [];
    }
    catalogIndex[catalogName].push(doc.objectId);
  }
  const catalogIndexFile = path.join(outputDir, 'catalog_index.json');
  fs.writeFileSync(catalogIndexFile, JSON.stringify(catalogIndex, null, 2), 'utf-8');
  console.log(`  分类总数: ${Object.keys(catalogIndex).length}`);

  // 写入主索引（精简版，只包含基本信息的映射）
  const mainIndex: { [objectId: string]: { title: string; catalog: string; rel_path: string; keywords: string[] } } = {};
  for (const doc of docs) {
    mainIndex[doc.objectId] = {
      title: doc.title,
      catalog: doc.catalog,
      rel_path: doc.rel_path,
      keywords: doc.keywords
    };
  }
  const mainIndexFile = path.join(outputDir, 'main_index.json');
  fs.writeFileSync(mainIndexFile, JSON.stringify(mainIndex, null, 2), 'utf-8');

  // 生成元数据
  const metadata: IndexMetadata = {
    version: '2.0',
    generatedAt: new Date().toISOString(),
    totalDocs: docs.length,
    totalKeywords: Object.keys(invertedIndex).length,
    catalogs: catalogInfo.sort((a, b) => b.count - a.count)
  };

  const metadataFile = path.join(outputDir, 'metadata.json');
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf-8');

  return metadata;
}

// ============================================================
// 主函数
// ============================================================

function generateIndex(options: GenerateOptions): void {
  const { docsDir, outputDir, fileExtensions, maxPreviewLength } = options;

  console.log(`\n========================================`);
  console.log(`文档索引生成器 v2.0`);
  console.log(`========================================`);
  console.log(`文档目录: ${docsDir}`);
  console.log(`输出目录: ${outputDir}`);
  console.log(`文件类型: ${fileExtensions.join(', ')}`);
  console.log(`========================================\n`);

  // 检查目录
  if (!fs.existsSync(docsDir)) {
    console.error(`错误: 目录不存在 ${docsDir}`);
    process.exit(1);
  }

  // 扫描文件
  console.log('扫描文档...\n');
  const docs = scanDirectory(docsDir, fileExtensions);

  // 检查 objectId 冲突
  const idMap = new Map<string, number>();
  for (const doc of docs) {
    const count = idMap.get(doc.objectId) || 0;
    idMap.set(doc.objectId, count + 1);
    if (count > 0) {
      doc.objectId = `${doc.objectId}-${count}`;
    }
  }

  // 排序
  docs.sort((a, b) => {
    if (a.catalog !== b.catalog) {
      return a.catalog.localeCompare(b.catalog, 'zh-CN');
    }
    return a.title.localeCompare(b.title, 'zh-CN');
  });

  // 生成索引文件
  console.log(`\n========================================`);
  console.log(`生成索引文件...`);
  console.log(`========================================\n`);

  const metadata = saveIndexFiles(docs, outputDir);

  // 输出统计
  console.log(`\n========================================`);
  console.log(`生成完成!`);
  console.log(`========================================`);
  console.log(`总文档数: ${metadata.totalDocs}`);
  console.log(`关键词数: ${metadata.totalKeywords}`);
  console.log(`分类数量: ${metadata.catalogs.length}`);
  console.log(`\n输出文件:`);
  console.log(`  - main_index.json (主索引)`);
  console.log(`  - keyword_index.json (关键词索引)`);
  console.log(`  - metadata.json (元数据)`);
  console.log(`  - catalog_*.json (分类索引 x${metadata.catalogs.length})`);
  console.log(`\n目录: ${outputDir}`);
  console.log(`========================================\n`);
}

// 执行
const docsDir = path.resolve(__dirname, '../static/docs');
const outputDir = path.join(docsDir, 'index');

generateIndex({
  docsDir,
  outputDir,
  fileExtensions: ['.md', '.txt', '.markdown'],
  maxPreviewLength: 300
});
