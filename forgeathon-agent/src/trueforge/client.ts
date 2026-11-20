// TrueForge client: the ONLY way this extension talks to an AI model. It creates sessions, sends turns and renders
// streamed events through the TrueForge TypeScript SDK. It never calls a model provider directly.
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

export interface ToolCallInfo {
  id: string;
  /** Real tool name (unwrapped when it arrives through deferred `call_tool`). */
  name: string;
  server?: string;
  args: any;
  viaDeferred: boolean;
}

export type Approval = { status: 'allow' } | { status: 'deny'; reason: string };

export interface RunHooks {
  onSession?(sessionId: string, agent: string): void;
  onText?(messageId: string, delta: string): void;
  onToolCall?(t: ToolCallInfo): void;
  onToolResult?(toolCallId: string, preview: string): void;
  onNote?(msg: string): void;
  /** Called for every tool call TrueForge pauses on (tool approval). Resolve with the user's decision. */
  approve(t: ToolCallInfo): Promise<Approval>;
}

export interface RunResult {
  status: 'done' | 'cancelled' | 'error';
  output?: string;
  error?: string;
  agent: string;
  sessionId?: string;
  /** true once the agent called a tool with side effects (propose_*, run_command): restarting elsewhere could repeat them */
  hadSideEffects: boolean;
}

const SIDE_EFFECT_TOOLS = new Set(['propose_edit', 'propose_write', 'run_command']);
const CONTINUE_PROMPT = 'You were interrupted by a temporary model error. Continue the task from where you stopped. Do not repeat tool calls whose results you already have.';
const MAX_RATE_LIMIT_WAITS = 6;

/** How long to wait (ms) if the error is a provider rate limit / quota error, else undefined. Honours "retry in 43s". */
export function rateLimitWaitMs(error: string | undefined): number | undefined {
  if (!error || !/\b429\b|quota|rate.?limit|resource_exhausted|too many requests/i.test(error)) return undefined;
  const m = /retry (?:in|after)\s*([\d.]+)\s*s/i.exec(error);
  const secs = m ? Math.ceil(parseFloat(m[1])) + 1 : 30;
  return Math.min(Math.max(secs, 5), 90) * 1000;
}

export interface ResilienceOptions {
  agents: string[]; // primary first, then fallback(s)
  maxRetries: number;
  backoffMs?: number;
  /** Fail an attempt (so retry/fallback kicks in) if the model produces nothing for this long. The last agent gets 3x. */
  firstTokenTimeoutMs?: number;
}

function messageText(m: any): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => p?.text ?? '').join('');
  return '';
}

export function unwrapToolCall(call: any): ToolCallInfo {
  let args: any = {};
  try {
    args = JSON.parse(call.function?.arguments || '{}');
  } catch {
    args = {};
  }
  const info = call.toolInfo ?? {};
  if (info.type === 'mcp') return { id: call.id, name: info.name, server: info.serverName, args, viaDeferred: false };
  if (info.name === 'call_tool' && args.tool_name) {
    return { id: call.id, name: args.tool_name, server: args.mcp_server, args: args.input ?? {}, viaDeferred: true };
  }
  return { id: call.id, name: info.name ?? call.function?.name ?? 'unknown', args, viaDeferred: false };
}

export class TrueForgeRunner {
  private client: TrueForge;
  private currentSession: string | undefined;
  private abort: AbortController | undefined;
  private stopped = false;

  constructor(public readonly baseUrl: string, timeoutSeconds = 600) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: timeoutSeconds, maxRetries: 0 });
  }

  /** Cancel the running turn. Returns quickly; the stream is force-closed if TrueForge does not close it. */
  async stop(): Promise<void> {
    this.stopped = true;
    const sid = this.currentSession;
    const ac = this.abort;
    const forceClose = setTimeout(() => ac?.abort(), 1500);
    try {
      if (sid) await this.client.sessions.cancel(sid);
    } catch {
      /* best effort: the abort below still stops us listening */
    } finally {
      clearTimeout(forceClose);
      ac?.abort();
    }
  }

  async listAgents(): Promise<string[]> {
    const r: any = await this.client.agents.list();
    const list = r?.data?.data ?? r?.data ?? [];
    return (Array.isArray(list) ? list : []).map((a: any) => a.name);
  }

  private async runOnce(
    agentName: string,
    text: string,
    hooks: RunHooks,
    o: { firstTokenTimeoutMs?: number; resumeSessionId?: string; hadSideEffects?: boolean } = {},
  ): Promise<RunResult> {
    const firstTokenTimeoutMs = o.firstTokenTimeoutMs;
    this.stopped = false;
    const ac = new AbortController();
    this.abort = ac;
    const opts = { abortSignal: ac.signal, timeoutInSeconds: 600, maxRetries: 0 };
    const result: RunResult = { status: 'error', agent: agentName, hadSideEffects: o.hadSideEffects ?? false };
    let timedOut = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () => `No response from the model within ${Math.round((firstTokenTimeoutMs ?? 0) / 1000)}s (endpoint down, overloaded or too slow).`;
    try {
      // Resuming reuses the TrueForge session, so the agent keeps its whole history (nothing is re-read or re-done).
      let session: { id: string };
      if (o.resumeSessionId) {
        session = { id: o.resumeSessionId };
      } else {
        session = (await this.client.sessions.create({ agent: { name: agentName } }, opts)).data;
        hooks.onSession?.(session.id, agentName);
      }
      this.currentSession = session.id;
      result.sessionId = session.id;
      if (firstTokenTimeoutMs && firstTokenTimeoutMs > 0) {
        watchdog = setTimeout(() => {
          timedOut = true;
          void this.client.sessions.cancel(session.id).catch(() => undefined);
          ac.abort();
        }, firstTokenTimeoutMs);
      }

      const events = new Map<string, any>();
      const announced = new Set<string>();
      const pending: any[] = [];
      let turnId: string | undefined;
      let lastEventId: string | undefined;
      let final: any;

      // Tool calls arrive as fragments merged into the base model.message, so announce them once the message is
      // complete (finish reason set) or when any later event shows the model has moved on.
      const flushCalls = () => {
        for (const ev of events.values()) {
          if (ev.type !== 'model.message') continue;
          for (const call of ev.toolCalls ?? []) {
            if (announced.has(call.id) || !(call.function?.name || call.toolInfo)) continue;
            announced.add(call.id);
            const info = unwrapToolCall(call);
            if (SIDE_EFFECT_TOOLS.has(info.name)) result.hadSideEffects = true;
            hooks.onToolCall?.(info);
          }
        }
      };

      const consume = async (stream: AsyncIterable<any>): Promise<'paused' | 'done' | 'closed'> => {
        for await (const event of stream) {
          lastEventId = event.id;
          // Bookkeeping events arrive instantly; anything else means the model is actually responding.
          if (watchdog && !['turn.created', 'mcp.initialize', 'model.message'].includes(event.type)) {
            clearTimeout(watchdog);
            watchdog = undefined;
          }
          if (isEventDelta(event)) {
            const base = events.get(event.id);
            if (base) mergeEventDelta(base, event);
            if (event.content) hooks.onText?.(event.id, event.content);
            if (event.finishReason) flushCalls();
            continue;
          }
          events.set(event.id, event);
          if (event.type !== 'model.message') flushCalls();
          switch (event.type) {
            case 'turn.created':
              turnId = event.turnId ?? event.turn_id;
              break;
            case 'tool.response': {
              const body = typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? '');
              hooks.onToolResult?.(event.toolCallId ?? event.tool_call_id, body.slice(0, 300));
              break;
            }
            case 'thread.created':
              hooks.onNote?.(`Subagent started: ${event.title ?? event.threadId}`);
              break;
            case 'thread.context_compaction.started':
              hooks.onNote?.('Context compaction started (older history is being summarised)');
              break;
            case 'thread.context_compaction.finished':
              hooks.onNote?.('Context compaction finished');
              break;
            case 'tool.approval_required':
              pending.push(event);
              break;
            case 'turn.update':
              if (event.state?.status === 'paused') return 'paused';
              break;
            case 'turn.done':
              final = event.state;
              return 'done';
          }
        }
        flushCalls();
        return 'closed';
      };

      let stream: AsyncIterable<any> = await this.client.sessions.createTurnStream(
        session.id,
        { input: [{ type: 'user.message', content: text }] },
        opts,
      );
      for (;;) {
        const outcome = await consume(stream);
        if (outcome === 'closed') {
          if (timedOut && !this.stopped) {
            result.error = timeoutError();
            return result;
          }
          if (this.stopped) {
            result.status = 'cancelled';
            return result;
          }
          result.error = 'The TrueForge stream closed unexpectedly.';
          return result;
        }
        if (outcome === 'done') break;

        // Paused: answer every pending approval (this is where the diff review happens), then continue.
        const answers: any[] = [];
        for (const req of pending.splice(0)) {
          for (const ref of req.toolCalls) {
            const msg = events.get(ref.sourceEventId);
            const call = msg?.toolCalls?.find((c: any) => c.id === ref.id);
            if (!call) continue;
            const decision = await hooks.approve(unwrapToolCall(call));
            if (this.stopped) {
              result.status = 'cancelled';
              return result;
            }
            answers.push({ type: 'user.tool_approval', threadId: req.threadId, toolCallId: ref.id, approval: decision });
          }
        }
        if (answers.length === 0) {
          result.error = 'TrueForge paused for something this editor cannot answer (question or sign-in). Run was stopped.';
          await this.client.sessions.cancel(session.id).catch(() => undefined);
          return result;
        }
        const resume = await this.client.sessions.subscribeToTurn(session.id, turnId!, { afterEventId: lastEventId }, opts);
        await this.client.sessions.createTurnEvents(session.id, turnId!, { events: answers }, opts);
        stream = resume;
      }

      if (final?.status === 'done') {
        result.status = 'done';
        result.output = messageText(final.output);
      } else if (final?.status === 'cancelled') {
        result.status = 'cancelled';
      } else {
        result.status = 'error';
        result.error = final?.message ?? 'The turn ended with an error.';
      }
      return result;
    } catch (e) {
      if (timedOut && !this.stopped) {
        result.error = timeoutError();
        return result;
      }
      if (this.stopped || ac.signal.aborted) {
        result.status = 'cancelled';
        return result;
      }
      result.error = describeError(e, this.baseUrl);
      return result;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      this.abort = undefined;
    }
  }

  /** Retry with exponential backoff per agent, then fall back to the next configured agent (second model). */
  async runResilient(text: string, hooks: RunHooks, opts: ResilienceOptions): Promise<RunResult> {
    let last: RunResult = { status: 'error', agent: opts.agents[0], hadSideEffects: false, error: 'No agent configured.' };
    const base = opts.backoffMs ?? 1000;
    for (let a = 0; a < opts.agents.length; a++) {
      const agent = opts.agents[a];
      const isLast = a === opts.agents.length - 1;
      const firstTokenTimeoutMs = opts.firstTokenTimeoutMs ? opts.firstTokenTimeoutMs * (isLast ? 3 : 1) : undefined;
      let resumeSessionId: string | undefined;
      let rateWaits = 0;
      let hadSideEffects = false;
      for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        const r = await this.runOnce(agent, resumeSessionId ? CONTINUE_PROMPT : text, hooks, { firstTokenTimeoutMs, resumeSessionId, hadSideEffects });
        if (r.status !== 'error') return r;
        last = r;
        hadSideEffects = r.hadSideEffects;
        // Provider rate limit (e.g. free-tier requests per minute): wait as long as the provider asks, then continue the
        // SAME session. This never repeats work, so it is safe even after edits were proposed.
        const rlWait = rateLimitWaitMs(r.error);
        if (rlWait !== undefined && r.sessionId && rateWaits < MAX_RATE_LIMIT_WAITS) {
          rateWaits++;
          attempt--; // a rate-limit wait does not use up a retry
          hooks.onNote?.(`"${agent}" hit a rate limit. Waiting ${Math.round(rlWait / 1000)}s, then continuing the same run (${rateWaits}/${MAX_RATE_LIMIT_WAITS})...`);
          if (await this.sleepUnlessStopped(rlWait)) return { ...r, status: 'cancelled' };
          resumeSessionId = r.sessionId;
          continue;
        }
        resumeSessionId = undefined;
        if (r.hadSideEffects) return r; // restarting elsewhere could repeat side effects; surface the error instead
        if (attempt < opts.maxRetries) {
          const wait = base * 2 ** attempt;
          hooks.onNote?.(`"${agent}" failed (${r.error}). Retrying in ${(wait / 1000).toFixed(0)}s (${attempt + 1}/${opts.maxRetries})...`);
          if (await this.sleepUnlessStopped(wait)) return { ...r, status: 'cancelled' };
        }
      }
      if (a + 1 < opts.agents.length) hooks.onNote?.(`"${agent}" is unavailable. Switching automatically to fallback agent "${opts.agents[a + 1]}".`);
    }
    last.error = `No model could be reached. Last error: ${last.error}`;
    return last;
  }

  private sleepUnlessStopped(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.stopped) {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - t0 >= ms) {
          clearInterval(iv);
          resolve(false);
        }
      }, 50);
    });
  }
}

export function describeError(e: unknown, baseUrl: string): string {
  const err = e as any;
  const msg = String(err?.message ?? e);
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ECONNREFUSED' || /fetch failed|ECONNREFUSED|Failed to fetch/i.test(msg)) {
    return `TrueForge server not reachable at ${baseUrl}. Start it with: npx @truefoundry/trueforge@latest`;
  }
  if (err?.statusCode === 404 && /agent/i.test(msg + JSON.stringify(err?.body ?? ''))) {
    return `Agent not found in TrueForge. Run: npm run setup:trueforge`;
  }
  return err?.statusCode ? `${msg} (HTTP ${err.statusCode})` : msg;
}
