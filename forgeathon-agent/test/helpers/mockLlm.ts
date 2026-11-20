// Minimal scripted OpenAI-compatible /chat/completions server, used ONLY by tests to stand in for a real model.
import * as http from 'node:http';

export type Step = { kind: 'text'; text: string } | { kind: 'tool'; match: string; args: unknown } | { kind: 'slow' } | { kind: 'hang' } | { kind: 'http'; status: number; body?: string };

export interface MockOpts {
  port: number;
  /** Decide the reply given the number of tool results seen since the last user message and the last tool result text. */
  script: (toolResults: string[], userText: string) => Step;
}

export function startMockLlm(o: MockOpts): Promise<{ close(): Promise<void>; requests: number }> {
  const state = { requests: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    state.requests++;
    const msgs: any[] = body.messages ?? [];
    let lastUser = -1;
    msgs.forEach((m, i) => {
      if (m.role === 'user') lastUser = i;
    });
    const toolResults = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    const userMsg = msgs[lastUser]?.content;
    const userText = typeof userMsg === 'string' ? userMsg : JSON.stringify(userMsg ?? '');
    const step = o.script(toolResults, userText);

    if (step.kind === 'http') {
      res.writeHead(step.status, { 'content-type': 'application/json' }).end(step.body ?? JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }));
      return;
    }
    if (step.kind === 'hang') return; // accept the connection and never answer (blackholed endpoint)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta: any, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: body.model ?? 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const done = () => {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    if (step.kind === 'text') {
      send({ role: 'assistant', content: '' });
      for (const w of step.text.split(/(?<= )/)) send({ content: w });
      send({}, 'stop');
      return done();
    }
    if (step.kind === 'slow') {
      send({ role: 'assistant', content: '' });
      const iv = setInterval(() => send({ content: 'thinking ' }), 100);
      res.on('close', () => clearInterval(iv));
      return;
    }
    const tools: any[] = body.tools ?? [];
    const found = tools.map((t) => t.function?.name as string).find((n) => n && n.endsWith(step.match));
    const name = found ?? step.match;
    send({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${state.requests}`, type: 'function', function: { name, arguments: '' } }] });
    send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] });
    send({}, 'tool_calls');
    done();
  });
  return new Promise((resolve) => {
    server.listen(o.port, '127.0.0.1', () =>
      resolve({
        get requests() {
          return state.requests;
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      } as any),
    );
  });
}
