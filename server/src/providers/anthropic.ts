import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

const API_BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

type AnthropicTextBlock = {
  type: 'text';
  text: string;
};

type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
};

type AnthropicResponse = {
  id: string;
  model: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type AnthropicStreamEvent = {
  type: string;
  index?: number;
  message?: {
    id?: string;
    model?: string;
  };
  content_block?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  error?: {
    message?: string;
  };
};

export class AnthropicProvider extends BaseProvider {
  readonly platform = 'anthropic' as const;
  readonly name = 'Anthropic';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const body = buildRequest(modelId, messages, options);

    const res = await this.fetchWithTimeout(`${API_BASE}/messages`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(await this.formatError(res));
    }

    const data = await res.json() as AnthropicResponse;
    const response = toOpenAiResponse(data, modelId);
    response._routed_via = { platform: 'anthropic', model: modelId };
    return response;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body = { ...buildRequest(modelId, messages, options), stream: true };

    const res = await this.fetchWithTimeout(`${API_BASE}/messages`, {
      method: 'POST',
      headers: this.headers(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(await this.formatError(res));
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let responseId = this.makeId();
    let responseModel = modelId;
    let sawToolCall = false;
    let finishReason: string | null = null;
    const toolStates = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const raw = trimmed.slice(6);
        if (raw === '[DONE]') return;

        let evt: AnthropicStreamEvent;
        try {
          evt = JSON.parse(raw) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        if (evt.type === 'message_start') {
          responseId = evt.message?.id ?? responseId;
          responseModel = evt.message?.model ?? responseModel;
          continue;
        }

        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' && typeof evt.index === 'number') {
          toolStates.set(evt.index, {
            id: evt.content_block.id ?? `tool_${evt.index}`,
            name: evt.content_block.name ?? 'tool',
            args: '',
          });
          continue;
        }

        if (evt.type === 'content_block_start' && evt.content_block?.type === 'text' && evt.content_block.text) {
          yield textChunk(responseId, responseModel, evt.content_block.text);
          continue;
        }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
          yield textChunk(responseId, responseModel, evt.delta.text);
          continue;
        }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && typeof evt.index === 'number') {
          const state = toolStates.get(evt.index);
          if (state) state.args += evt.delta.partial_json ?? '';
          continue;
        }

        if (evt.type === 'content_block_stop' && typeof evt.index === 'number') {
          const state = toolStates.get(evt.index);
          if (!state) continue;
          sawToolCall = true;
          toolStates.delete(evt.index);
          yield toolCallChunk(responseId, responseModel, state.id, state.name, state.args || '{}');
          continue;
        }

        if (evt.type === 'message_delta') {
          finishReason = mapStopReason(evt.delta?.stop_reason ?? null, sawToolCall);
          continue;
        }

        if (evt.type === 'error') {
          throw new Error(`Anthropic API error: ${evt.error?.message ?? 'stream failed'}`);
        }

        if (evt.type === 'message_stop') {
          yield finishChunk(responseId, responseModel, finishReason ?? (sawToolCall ? 'tool_calls' : 'stop'));
          return;
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
      method: 'GET',
      headers: this.headers(apiKey, false),
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }

  private headers(apiKey: string, json = true): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async formatError(res: Response): Promise<string> {
    const err = await res.json().catch(() => ({}));
    const msg = (err as any).error?.message ?? res.statusText;
    return `Anthropic API error ${res.status}: ${msg}`;
  }
}

function buildRequest(modelId: string, messages: ChatMessage[], options?: CompletionOptions): Record<string, unknown> {
  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content.length > 0) {
        systemParts.push(message.content);
      }
      continue;
    }

    if (message.role === 'user') {
      anthropicMessages.push({
        role: 'user',
        content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }],
      });
      continue;
    }

    if (message.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (typeof message.content === 'string' && message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
      }
      for (const toolCall of message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        });
      }
      anthropicMessages.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] });
      continue;
    }

    anthropicMessages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? message.name ?? 'tool',
        content: typeof message.content === 'string' ? message.content : '',
      }],
    });
  }

  const { tools, tool_choice } = toAnthropicTools(options?.tools, options?.tool_choice);
  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: options?.max_tokens ?? 1024,
    messages: mergeMessages(anthropicMessages),
  };

  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.top_p !== undefined) body.top_p = options.top_p;
  if (tools.length > 0) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;

  return body;
}

function mergeMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const message of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === message.role) {
      prev.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  return merged;
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function toAnthropicTools(tools?: ChatToolDefinition[], toolChoice?: ChatToolChoice): {
  tools: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
} {
  if (!tools || tools.length === 0 || toolChoice === 'none') {
    return { tools: [] };
  }

  const anthropicTools = tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: (tool.function.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
  }));

  if (!toolChoice || toolChoice === 'auto') {
    return { tools: anthropicTools, tool_choice: { type: 'auto' } };
  }

  if (toolChoice === 'required') {
    return { tools: anthropicTools, tool_choice: { type: 'any' } };
  }

  return {
    tools: anthropicTools,
    tool_choice: { type: 'tool', name: toolChoice.function.name },
  };
}

function toOpenAiResponse(data: AnthropicResponse, requestedModel: string): ChatCompletionResponse {
  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const block of data.content ?? []) {
    if (block.type === 'text') {
      textParts.push(block.text);
      continue;
    }

    toolCalls.push({
      id: block.id,
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      },
    });
  }

  const promptTokens = data.usage?.input_tokens ?? 0;
  const completionTokens = data.usage?.output_tokens ?? 0;
  const content = textParts.join('');

  return {
    id: data.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || requestedModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content.length > 0 ? content : (toolCalls.length > 0 ? null : ''),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mapStopReason(data.stop_reason, toolCalls.length > 0),
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function mapStopReason(stopReason: string | null, sawToolCalls: boolean): string {
  if (sawToolCalls || stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  return 'stop';
}

function textChunk(id: string, model: string, text: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { content: text },
      finish_reason: null,
    }],
  };
}

function toolCallChunk(id: string, model: string, toolId: string, name: string, args: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          id: toolId,
          type: 'function',
          function: {
            name,
            arguments: args,
          },
        }],
      },
      finish_reason: null,
    }],
  };
}

function finishChunk(id: string, model: string, finishReason: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: finishReason,
    }],
  };
}