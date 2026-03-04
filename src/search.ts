import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

// 使用 createRequire 导入 CommonJS 模块
const require = createRequire(import.meta.url);
const Segmentit = require('segmentit');

// 初始化分词器
const segmenter = new Segmentit.Segment();
Segmentit.useDefault(segmenter);

// ============================================================
// 类型定义
// ============================================================

export interface DocEntry {
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
  keywords?: string[];
}

export interface SearchResult {
  title: string;
  objectId: string;
  preview: string;
  url: string;
  path: string;
  score: number;
}

// 新索引结构类型
interface MainIndexEntry {
  title: string;
  catalog: string;
  rel_path: string;
  keywords: string[];
}

interface Metadata {
  version: string;
  generatedAt: string;
  totalDocs: number;
  totalKeywords: number;
  catalogs: { name: string; count: number; file: string }[];
}

interface KeywordIndex {
  [keyword: string]: string[];
}

// ============================================================
// DocsSearcher 类
// ============================================================

export class DocsSearcher {
  private docsDir: string;
  private indexDir: string;

  // 新索引结构
  private mainIndex: Map<string, MainIndexEntry> = new Map();
  private keywordIndex: KeywordIndex = {};
  private catalogIndex: { [catalogName: string]: string[] } = {}; // 分类索引
  private metadata: Metadata | null = null;

  // 缓存的分类索引（按需加载）
  private catalogCache: Map<string, Map<string, DocEntry>> = new Map();

  // 兼容旧索引
  private legacyDocs: DocEntry[] = [];
  private useLegacyIndex = false;

  constructor(docsDir: string) {
    this.docsDir = docsDir;
    this.indexDir = path.join(docsDir, 'index');
    this.loadIndex();
  }

  private loadIndex(): void {
    // 优先尝试加载新索引结构
    const metadataPath = path.join(this.indexDir, 'metadata.json');
    const mainIndexPath = path.join(this.indexDir, 'main_index.json');
    const keywordIndexPath = path.join(this.indexDir, 'keyword_index.json');

    if (fs.existsSync(metadataPath) && fs.existsSync(mainIndexPath)) {
      try {
        // 加载元数据
        this.metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

        // 加载主索引
        const mainIndexData: { [key: string]: MainIndexEntry } =
          JSON.parse(fs.readFileSync(mainIndexPath, 'utf-8'));
        this.mainIndex = new Map(Object.entries(mainIndexData));

        // 加载关键词索引
        if (fs.existsSync(keywordIndexPath)) {
          this.keywordIndex = JSON.parse(fs.readFileSync(keywordIndexPath, 'utf-8'));
        }

        // 加载分类索引
        const catalogIndexPath = path.join(this.indexDir, 'catalog_index.json');
        if (fs.existsSync(catalogIndexPath)) {
          this.catalogIndex = JSON.parse(fs.readFileSync(catalogIndexPath, 'utf-8'));
        }

        this.useLegacyIndex = false;
        console.error(`[arkts-assistant] Loaded new index: ${this.mainIndex.size} documents, ${Object.keys(this.keywordIndex).length} keywords, ${Object.keys(this.catalogIndex).length} catalogs`);
        return;
      } catch (error) {
        console.error(`[arkts-assistant] Failed to load new index: ${error}`);
      }
    }

    // 回退到旧索引
    const legacyIndexPath = path.join(this.docsDir, 'docs_index.json');
    if (fs.existsSync(legacyIndexPath)) {
      try {
        this.legacyDocs = JSON.parse(fs.readFileSync(legacyIndexPath, 'utf-8'));
        this.useLegacyIndex = true;
        console.error(`[arkts-assistant] Loaded legacy index: ${this.legacyDocs.length} documents`);
        return;
      } catch (error) {
        console.error(`[arkts-assistant] Failed to load legacy index: ${error}`);
      }
    }

    console.error(`[arkts-assistant] No index found. Please run: npm run generate-index`);
  }

  // 按需加载分类索引
  private loadCatalogIndex(catalogFile: string): Map<string, DocEntry> | null {
    if (this.catalogCache.has(catalogFile)) {
      return this.catalogCache.get(catalogFile)!;
    }

    const catalogPath = path.join(this.indexDir, catalogFile);
    if (!fs.existsSync(catalogPath)) {
      return null;
    }

    try {
      const data: { [key: string]: DocEntry } = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
      const index = new Map(Object.entries(data));
      this.catalogCache.set(catalogFile, index);
      return index;
    } catch (error) {
      console.error(`[arkts-assistant] Failed to load catalog ${catalogFile}: ${error}`);
      return null;
    }
  }

  // 根据 objectId 获取完整的文档条目
  private getFullDocEntry(objectId: string): DocEntry | null {
    if (this.useLegacyIndex) {
      return this.legacyDocs.find(d => d.objectId === objectId) || null;
    }

    const mainEntry = this.mainIndex.get(objectId);
    if (!mainEntry) {
      return null;
    }

    // 找到对应的分类文件
    const catalogInfo = this.metadata?.catalogs.find(c => c.name === mainEntry.catalog);
    if (!catalogInfo) {
      // 返回基本信息
      return {
        title: mainEntry.title,
        headings: [],
        preview: '',
        char_count: 0,
        image_count: 0,
        url: '',
        path: '',
        rel_path: mainEntry.rel_path,
        catalog: mainEntry.catalog,
        objectId: objectId,
        nodeName: 'document',
        keywords: mainEntry.keywords
      };
    }

    // 从分类索引获取完整信息
    const catalogIndex = this.loadCatalogIndex(catalogInfo.file);
    if (catalogIndex) {
      return catalogIndex.get(objectId) || null;
    }

    return null;
  }

  // ============================================================
  // 分词功能
  // ============================================================

  // 中文停用词
  private static readonly STOP_WORDS = new Set([
    '的', '是', '在', '和', '了', '与', '及', '等', '中', '为',
    '对', '将', '可', '以', '能', '也', '并', '或', '如', '该',
    '此', '其', '这', '那', '有', '被', '从', '到', '由', '按',
    '个', '一', '不', '无', '多', '少', '大', '小', '上', '下',
    '来', '去', '说', '看', '做', '用', '当', '会', '要', '让',
    '通过', '可以', '需要', '如果', '一个', '这个', '进行', '使用',
    '支持', '包含', '如下', '例如', '说明', '注意', '如下所示',
    '方法', '参数', '返回', '类型', '对象', '接口', '功能', '系统',
    '应用', '开发', '调用', '设置', '获取', '创建', '添加', '删除',
    '描述', '定义', '数据', '信息', '值', '名称', '以下', '查找', '关于',
    '如何', '实现', '什么', '怎么', '怎样', '为什么', '哪些'
  ]);

  // 中文连接词（用于拆分词组）
  private static readonly CONNECTOR_WORDS = new Set([
    '和', '与', '及', '或', '以及', '并且', '或者', '且', '并'
  ]);

  // 分词函数：使用 segmentit 分词库
  private tokenize(query: string): string[] {
    const tokens: Set<string> = new Set();

    // 1. 提取 API 模块名（如 @ohos.xxx）
    const apiMatches = query.match(/@[\w.]+/gi) || [];
    apiMatches.forEach(m => tokens.add(m.toLowerCase()));

    // 2. 提取版本号（如 V1、V2）
    const versionMatches = query.match(/V\d+/gi) || [];
    versionMatches.forEach(m => tokens.add(m.toLowerCase()));

    // 3. 提取英文单词
    const englishWords = query.match(/[A-Za-z]+/g) || [];
    englishWords.forEach(w => {
      if (w.length >= 2 && !/^(v\d+)$/i.test(w)) { // 排除版本号重复
        tokens.add(w.toLowerCase());
        // 处理驼峰命名，如 "ButtonComponent" -> "button", "component"
        const camelParts = w.split(/(?=[A-Z])/).filter(p => p.length >= 2);
        camelParts.forEach(p => tokens.add(p.toLowerCase()));
      }
    });

    // 4. 使用 segmentit 进行中文分词
    const chinesePhrase = query.match(/[\u4e00-\u9fa5]+/g) || [];
    chinesePhrase.forEach(phrase => {
      // 使用 segmentit 分词
      try {
        const segments = segmenter.doSegment(phrase);
        for (const seg of segments) {
          const word = seg.w;
          if (word && word.length >= 1) {
            // 检查是否包含连接词，如果包含则拆分
            let splitParts = [word];
            for (const connector of DocsSearcher.CONNECTOR_WORDS) {
              const newParts: string[] = [];
              for (const part of splitParts) {
                if (part.includes(connector)) {
                  const subParts = part.split(connector).filter((p: string) => p.length >= 2);
                  newParts.push(...subParts);
                } else {
                  newParts.push(part);
                }
              }
              splitParts = newParts;
            }

            // 添加拆分后的词
            for (const part of splitParts) {
              if (part.length >= 2 && !DocsSearcher.STOP_WORDS.has(part)) {
                tokens.add(part);
              }
            }
          }
        }
      } catch (e) {
        // 分词失败时降级处理
        console.error('Segmentation error:', e);
      }
    });

    // 5. 按空格分割的原始词，并处理连接词
    const spaceSeparated = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);
    spaceSeparated.forEach(k => {
      // 检查是否包含连接词
      let hasConnector = false;
      for (const connector of DocsSearcher.CONNECTOR_WORDS) {
        if (k.includes(connector)) {
          hasConnector = true;
          // 拆分并添加各部分
          const parts = k.split(connector).filter(p => p.length >= 2);
          parts.forEach(p => tokens.add(p));
        }
      }
      if (!hasConnector) {
        tokens.add(k);
      }
    });

    // 过滤停用词和过短的词
    return Array.from(tokens).filter(t =>
      t.length >= 2 &&
      !DocsSearcher.STOP_WORDS.has(t) &&
      !/^\d+$/.test(t)
    );
  }

  // ============================================================
  // 搜索功能
  // ============================================================

  search(query: string, limit: number = 50): SearchResult[] {
    // 使用分词函数处理查询
    const keywords = this.tokenize(query);
    if (keywords.length === 0) {
      return [];
    }

    if (this.useLegacyIndex) {
      return this.searchLegacy(keywords, limit);
    }

    return this.searchNewIndex(keywords, limit);
  }

  // 新索引搜索（使用倒排索引）
  private searchNewIndex(keywords: string[], limit: number): SearchResult[] {
    // 收集匹配的文档及其分数
    const scoreMap = new Map<string, number>();

    for (const keyword of keywords) {
      const lowerKeyword = keyword.toLowerCase();

      // 1. 关键词索引精确查找 - O(1)
      const exactMatches = this.keywordIndex[lowerKeyword];
      if (exactMatches) {
        for (const docId of exactMatches) {
          scoreMap.set(docId, (scoreMap.get(docId) || 0) + 10);
        }
      }

      // 2. 分类索引查找 - O(1) 精确匹配
      const catalogMatches = this.catalogIndex[lowerKeyword];
      if (catalogMatches) {
        for (const docId of catalogMatches) {
          scoreMap.set(docId, (scoreMap.get(docId) || 0) + 8);
        }
      }

      // 3. 分类模糊匹配 - 遍历分类名
      for (const [catalogName, docIds] of Object.entries(this.catalogIndex)) {
        if (catalogName !== lowerKeyword && catalogName.includes(lowerKeyword)) {
          for (const docId of docIds) {
            scoreMap.set(docId, (scoreMap.get(docId) || 0) + 5);
          }
        }
      }
    }

    // 4. 遍历主索引进行标题、路径匹配（仅当结果不足时）
    if (scoreMap.size < (limit > 0 ? limit : 100)) {
      for (const [objectId, entry] of this.mainIndex.entries()) {
        if (scoreMap.has(objectId)) continue;

        for (const keyword of keywords) {
          const lowerKeyword = keyword.toLowerCase();

          // 标题匹配
          const titleLower = entry.title.toLowerCase();
          if (titleLower.includes(lowerKeyword)) {
            const weight = titleLower === lowerKeyword ? 15 : 10;
            scoreMap.set(objectId, (scoreMap.get(objectId) || 0) + weight);
            break;
          }

          // 路径匹配
          if (entry.rel_path && entry.rel_path.toLowerCase().includes(lowerKeyword)) {
            scoreMap.set(objectId, (scoreMap.get(objectId) || 0) + 5);
            break;
          }
        }
      }
    }

    // 获取匹配结果并排序
    const results: SearchResult[] = [];
    const sortedIds = Array.from(scoreMap.entries())
      .sort((a, b) => b[1] - a[1]);

    for (const [objectId, score] of sortedIds) {
      if (limit > 0 && results.length >= limit) break;

      const entry = this.getFullDocEntry(objectId);
      if (entry) {
        results.push({
          title: entry.title,
          objectId: objectId,
          preview: entry.preview.substring(0, 200) + (entry.preview.length > 200 ? '...' : ''),
          url: entry.url,
          path: entry.rel_path,
          score: score
        });
      }
    }

    return results;
  }

  // 旧索引搜索（线性遍历）
  private searchLegacy(keywords: string[], limit: number): SearchResult[] {
    const results: SearchResult[] = [];

    for (const doc of this.legacyDocs) {
      let score = 0;
      const titleLower = doc.title.toLowerCase();
      const previewLower = doc.preview.toLowerCase();
      const objectIdLower = doc.objectId.toLowerCase();

      for (const keyword of keywords) {
        if (titleLower.includes(keyword)) {
          score += 10;
          if (titleLower === keyword) {
            score += 5;
          }
        }

        if (objectIdLower.includes(keyword)) {
          score += 5;
        }

        if (previewLower.includes(keyword)) {
          score += 2;
          const matches = previewLower.split(keyword).length - 1;
          score += Math.min(matches, 5);
        }

        for (const heading of doc.headings || []) {
          if (heading.toLowerCase().includes(keyword)) {
            score += 3;
          }
        }
      }

      if (score > 0) {
        results.push({
          title: doc.title,
          objectId: doc.objectId,
          preview: doc.preview.substring(0, 200) + (doc.preview.length > 200 ? '...' : ''),
          url: doc.url,
          path: doc.rel_path,
          score
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return limit > 0 ? results.slice(0, limit) : results;
  }

  // ============================================================
  // 文档读取
  // ============================================================

  getDocByObjectId(objectId: string): { content: string; metadata: DocEntry } | null {
    const doc = this.getFullDocEntry(objectId);
    if (!doc) {
      return null;
    }

    const fullPath = path.join(this.docsDir, doc.rel_path);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return { content, metadata: doc };
    } catch (error) {
      console.error(`[arkts-assistant] Failed to read document: ${error}`);
      return null;
    }
  }

  // ============================================================
  // 其他功能
  // ============================================================

  listTopics(): { topic: string; count: number }[] {
    if (this.useLegacyIndex) {
      const topicMap = new Map<string, number>();
      for (const doc of this.legacyDocs) {
        if (doc.catalog) {
          topicMap.set(doc.catalog, (topicMap.get(doc.catalog) || 0) + 1);
        }
      }
      return Array.from(topicMap.entries())
        .map(([topic, count]) => ({ topic, count }))
        .sort((a, b) => b.count - a.count);
    }

    // 使用元数据
    if (this.metadata) {
      return this.metadata.catalogs.map(c => ({ topic: c.name, count: c.count }));
    }

    return [];
  }

  getTotalDocs(): number {
    if (this.useLegacyIndex) {
      return this.legacyDocs.length;
    }
    return this.mainIndex.size;
  }

  reloadIndex(): void {
    // 清除缓存
    this.catalogCache.clear();
    this.mainIndex.clear();
    this.keywordIndex = {};
    this.catalogIndex = {};
    this.metadata = null;
    this.legacyDocs = [];

    this.loadIndex();
  }
}
