import type { ModelProvider, ModelRequest, ModelResponse } from '../../contracts/src/index';

/** An intentionally local, deterministic stand-in. It performs no tool calls. */
export class MockModelProvider implements ModelProvider {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const previous = [...request.history].reverse().find((message) => message.role === 'user');
    const normalized = request.text.toLowerCase();
    let text: string;
    if (request.memories?.length && /\b(remember|memory|preference|prefer|favorite|favourite|saved)\b/.test(normalized)) {
      text = `Your saved facts:\n${request.memories.map((fact) => fact.text).join('\n')}\nThis is a deterministic memory lookup in the local demo.`;
    } else if (/\b(remind|reminder|schedule|calendar|meeting|book|send|email|search|research|weather)\b/.test(normalized)) {
      text = 'This is the deterministic Plause demo, so I cannot interpret that request as a natural-language action. Send reminder help for durable local reminders, action help for the simulated calendar and exact approvals, or research help for explicit source-linked search when configured. This reply has not performed an action. Apple Messages and real calendars are not connected.';
    } else if (/\b(remember|memory|earlier|previous|before)\b/.test(normalized) && previous) {
      text = `In this conversation, you previously said: “${previous.text.slice(0, 700)}”. This is recent chat context, not a saved long-term memory.`;
    } else {
      text = `Plause demo: I received “${request.text.slice(0, 700)}”. This reply comes from a deterministic local mock, not a cloud AI model.`;
    }
    return { text, inputTokens: Math.ceil((request.text.length + (request.memories?.reduce((total, fact) => total + fact.text.length, 0) ?? 0) + request.history.reduce((total, message) => total + message.text.length, 0)) / 4), outputTokens: Math.ceil(text.length / 4) };
  }
}

export function isSupportRequest(text: string): boolean {
  return /^(?:(?:(?:i (?:need|want)|please)[ \t]+)?(?:help|agent|support|human|human support|live support|live agent|talk to (?:a )?human)|(?:can|could) i (?:please )?(?:talk|speak) to (?:a )?human)[.!?\s]*$/i.test(text.trim());
}

export const LOCAL_SUPPORT_NOTICE = 'Human support requested. Automatic replies are paused. This local demo has no staffed support team; use the operator controls to inspect the handoff and resume the demo.';
