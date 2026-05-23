import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../../providers/anthropic.js';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('anthropic');
    expect(provider.name).toBe('Anthropic');
  });

  it('should translate Anthropic text responses to OpenAI-compatible output', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'msg_123',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'Hello from Claude' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    } as any);

    const result = await provider.chatCompletion(
      'anthropic-key',
      [{ role: 'user', content: 'Hi' }],
      'claude-opus-4-7',
    );

    expect(result.choices[0].message.content).toBe('Hello from Claude');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.total_tokens).toBe(15);
    expect(result._routed_via?.platform).toBe('anthropic');
  });

  it('should translate OpenAI tool definitions into Anthropic request fields', async () => {
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'msg_123',
          model: 'claude-opus-4-7',
          content: [{
            type: 'tool_use',
            id: 'tool_1',
            name: 'get_weather',
            input: { city: 'Karachi' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'anthropic-key',
      [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Weather?' },
      ],
      'claude-opus-4-7',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Fetch weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'required',
      },
    );

    expect(capturedBody.system).toBe('You are helpful.');
    expect(capturedBody.tools[0].name).toBe('get_weather');
    expect(capturedBody.tool_choice.type).toBe('any');
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"city":"Karachi"}');
  });

  it('should validate key using models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as any);
    expect(await provider.validateKey('valid')).toBe(true);
  });

  it('validateKey returns false on confirmed 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('bad')).toBe(false);
  });
});