import express, { Request, Response } from 'express';
import { DocsSearcher } from './search.js';
import { TOOLS, handleToolCall } from './index.js';

const PORT = parseInt(process.env.ARKTS_MCP_PORT || '9527', 10);

export function startHttpServer(searcher: DocsSearcher): void {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', docs: searcher.getTotalDocs() });
  });

  // List tools
  app.get('/tools', (_req: Request, res: Response) => {
    res.json({ tools: TOOLS });
  });

  // Call tool
  app.post('/tools/:name', async (req: Request, res: Response) => {
    const { name } = req.params;
    const args = req.body || {};

    try {
      const result = await handleToolCall(name, args);
      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Convenience endpoints
  app.get('/search', async (req: Request, res: Response) => {
    const query = req.query.q as string;
    const limitArg = req.query.limit as string;
    const limit = limitArg ? parseInt(limitArg, 10) : 50; // 默认50条，设为0返回全部

    if (!query) {
      res.status(400).json({ error: 'Missing query parameter: q' });
      return;
    }

    const results = searcher.search(query, limit);
    res.json({ query, count: results.length, results });
  });

  app.get('/doc/:objectId', (req: Request, res: Response) => {
    const { objectId } = req.params;
    const result = searcher.getDocByObjectId(objectId);

    if (!result) {
      res.status(404).json({ error: `Document not found: ${objectId}` });
      return;
    }

    res.json({
      title: result.metadata.title,
      url: result.metadata.url,
      content: result.content
    });
  });

  app.get('/topics', (_req: Request, res: Response) => {
    res.json({
      total: searcher.getTotalDocs(),
      topics: searcher.listTopics()
    });
  });

  // Reload index
  app.post('/reload', (_req: Request, res: Response) => {
    searcher.reloadIndex();
    res.json({ success: true, total: searcher.getTotalDocs() });
  });

  // SSE endpoint for streaming
  app.get('/sse', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ type: 'ready', docs: searcher.getTotalDocs() })}\n\n`);

    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    res.on('close', () => {
      clearInterval(keepAlive);
    });
  });

  app.listen(PORT, () => {
    console.error(`[arkts-assistant] HTTP server listening on port ${PORT}`);
    console.error(`[arkts-assistant] Endpoints:`);
    console.error(`  GET  /health     - Health check`);
    console.error(`  GET  /tools      - List available tools`);
    console.error(`  POST /tools/:name - Call a tool`);
    console.error(`  GET  /search?q=  - Search documents`);
    console.error(`  GET  /doc/:id    - Get document by objectId`);
    console.error(`  GET  /topics     - List topics`);
    console.error(`  POST /reload     - Reload document index`);
  });
}
