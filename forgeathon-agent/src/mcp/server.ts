// Local MCP server (Streamable HTTP) hosted by the extension. TrueForge connects to it as a remote MCP server,
// so the AGENT decides what to read and change; the extension only provides the capabilities.
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DecisionStore } from './decisions';
import { TOOLS, ToolContext, killAll } from './tools';

export interface EditorMcpServer {
  port: number;
  ctx: ToolContext;
  close(): Promise<void>;
}

function buildServer(ctx: ToolContext, onCall?: (name: string, args: unknown) => void): McpServer {
  const server = new McpServer({ name: 'forge-editor', version: '0.1.0' });
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.shape,
        annotations: t.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true },
      },
      async (args: any) => {
        onCall?.(t.name, args);
        const r = await t.handler(args, ctx);
        return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError ?? false };
      },
    );
  }
  return server;
}

export async function startMcpServer(opts: {
  root: string;
  port: number;
  decisions?: DecisionStore;
  onCall?: (name: string, args: unknown) => void;
}): Promise<EditorMcpServer> {
  const ctx: ToolContext = { root: opts.root, decisions: opts.decisions ?? new DecisionStore(), processes: new Set() };
  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end('not found');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end('Method not allowed (stateless MCP server: POST only)');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const server = buildServer(ctx, opts.onCall);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String((e as Error).message) }, id: null }),
        );
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    port,
    ctx,
    close: () =>
      new Promise<void>((resolve) => {
        killAll(ctx);
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
