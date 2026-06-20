import { generateCookies, type CookieResult } from './cookie-generator';

const QWEN_ORIGIN = 'https://chat.qwen.ai';

/**
 * Gets a specific cookie value for chat.qwen.ai
 */
async function getCookie(name: string): Promise<string | null> {
  try {
    const cookie = await chrome.cookies.get({
      url: QWEN_ORIGIN,
      name: name,
    });
    return cookie ? cookie.value : null;
  } catch (e) {
    console.error(`[Qwen Service] Failed to get cookie ${name}:`, e);
    return null;
  }
}

/**
 * Sets a specific cookie for chat.qwen.ai
 */
async function setCookie(name: string, value: string): Promise<void> {
  try {
    await chrome.cookies.set({
      url: QWEN_ORIGIN,
      name: name,
      value: value,
      domain: 'chat.qwen.ai',
      path: '/',
      secure: true,
      sameSite: 'lax',
    });
  } catch (e) {
    console.error(`[Qwen Service] Failed to set cookie ${name}:`, e);
    throw e;
  }
}

/**
 * Retrieves the active JWT token from cookies or localStorage
 */
export async function getQwenToken(): Promise<string | null> {
  // 1. First, check the cookie jar (extremely direct)
  let token = await getCookie('token');
  if (token) {
    return token;
  }

  // 2. Fallback: Query active chat.qwen.ai tabs and run a script to extract from localStorage
  try {
    const tabs = await chrome.tabs.query({ url: `${QWEN_ORIGIN}/*` });
    if (tabs.length > 0 && tabs[0].id !== undefined) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const value = localStorage.getItem(key || '');
            if (value && value.includes('eyJ')) {
              try {
                const parsed = JSON.parse(value);
                return parsed.token || parsed.accessToken || parsed.access_token || value;
              } catch {
                if (value.startsWith('eyJ')) return value;
              }
            }
          }
          return null;
        },
      });
      if (results && results[0]?.result) {
        token = results[0].result;
        if (token) {
          await setCookie('token', token);
        }
        return token;
      }
    }
  } catch (e) {
    console.error('[Qwen Service] Failed to extract token from localStorage:', e);
  }

  return null;
}

/**
 * Generates and updates fresh ssxmod_itna security cookies
 */
export async function updateQwenCookies(): Promise<CookieResult> {
  try {
    console.log('[Qwen Service] Generating fresh security cookies...');
    const result = generateCookies();
    await setCookie('ssxmod_itna', result.ssxmod_itna);
    await setCookie('ssxmod_itna2', result.ssxmod_itna2);
    console.log('[Qwen Service] Security cookies updated successfully!');
    return result;
  } catch (e) {
    console.error('[Qwen Service] Failed to update security cookies:', e);
    throw e;
  }
}

/**
 * Creates a new chat session to generate a fresh chat_id
 */
export async function createQwenSession(token: string): Promise<string | null> {
  try {
    console.log('[Qwen Service] Creating fresh chat session...');
    const response = await fetch(`${QWEN_ORIGIN}/api/v2/chats/new`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        'source': 'web',
        'version': '0.2.63',
        'timezone': new Date().toString().replace(/GMT\+0800/, 'GMT+0800'),
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({
        title: 'Job Bro Evaluation',
        models: ['qwen3.7-max'],
        chat_mode: 'local',
        chat_type: 't2i',
        timestamp: Date.now(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Session creation failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data?.data?.id || null;
  } catch (e) {
    console.error('[Qwen Service] Session creation failed:', e);
    return null;
  }
}

export interface QwenMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * Converts standard ChatMessages into a single Qwen user message payload
 * combining system instructions and history.
 */
function buildQwenMessagesPayload(messages: QwenMessage[]) {
  const userFid = crypto.randomUUID();
  const assistantFid = crypto.randomUUID();
  const nowInSeconds = Math.floor(Date.now() / 1000);

  // Combine system prompts and chat history into one giant prompt
  let combinedPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      combinedPrompt += `[System Instruction]\n${msg.content}\n\n`;
    } else if (msg.role === 'user') {
      combinedPrompt += `User: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      combinedPrompt += `Assistant: ${msg.content}\n\n`;
    } else if (msg.role === 'tool') {
      combinedPrompt += `[Tool Result]: ${msg.content}\n\n`;
    }
  }

  return {
    fid: userFid,
    parentId: null,
    childrenIds: [assistantFid],
    role: 'user',
    content: combinedPrompt.trim(),
    user_action: 'chat',
    files: [],
    timestamp: nowInSeconds,
    models: ['qwen3.7-max'],
    chat_type: 't2t',
    feature_config: {
      thinking_enabled: true,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: false,
      thinking_mode: 'Thinking',
      thinking_format: 'summary',
      auto_search: true, // Native search
    },
    extra: {
      meta: {
        subChatType: 't2t',
      },
    },
    sub_chat_type: 't2t',
  };
}

/**
 * Sends a non-streaming chat completions request to Qwen using local fetch with spoofed Origin/Referer.
 * Resolves to the final accumulated string (excluding thinking/search output).
 */
export async function sendQwenChat(messages: QwenMessage[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let fullContent = '';
    sendQwenChatStream(
      messages,
      (text) => { fullContent += text; },
      () => resolve(fullContent),
      (err) => reject(new Error(err)),
      signal
    );
  });
}

/**
 * Sends a streaming chat completions request to Qwen using local fetch with spoofed Origin/Referer
 */
export async function sendQwenChatStream(
  messages: QwenMessage[],
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  signal?: AbortSignal
): Promise<void> {
  let keepAliveInterval: ReturnType<typeof setInterval> | undefined;

  try {
    keepAliveInterval = setInterval(() => {
      try {
        chrome.runtime.sendMessage({ type: 'QWEN_PING' }).catch(() => {});
      } catch {}
    }, 10000); // 10s keep-alive ping
  } catch {}

  const cleanupHeartbeat = () => {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = undefined;
    }
  };

  const wrappedOnDone = () => {
    cleanupHeartbeat();
    onDone();
  };

  const wrappedOnError = (err: string) => {
    cleanupHeartbeat();
    onError(err);
  };

  if (signal) {
    if (signal.aborted) {
      cleanupHeartbeat();
      onError('Request aborted');
      return;
    }
    signal.addEventListener('abort', () => {
      cleanupHeartbeat();
    });
  }

  try {
    // 1. Refresh security cookies
    await updateQwenCookies();

    // 2. Retrieve active token
    const token = await getQwenToken();
    if (!token) {
      wrappedOnError('Authentication token not found. Please log in to chat.qwen.ai first!');
      return;
    }

    // 3. Create active session
    const chatId = await createQwenSession(token);
    if (!chatId) {
      wrappedOnError('Failed to initialize a Qwen chat session.');
      return;
    }

    // 4. Build exact Qwen v2.1 Payload aligned with recent Qwen2API commits
    const nowInSeconds = Math.floor(Date.now() / 1000);

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: 'qwen3.7-max',
      parent_id: null,
      messages: [buildQwenMessagesPayload(messages)],
      timestamp: nowInSeconds,
    };

    // 5. Send same-origin-spoofed completions request from extension background
    console.log('[Qwen Service] Initiating completions stream fetch...');
    const response = await fetch(`${QWEN_ORIGIN}/api/v2/chat/completions?chat_id=${chatId}`, {
      method: 'POST',
      credentials: 'include', // Ensure cookies are sent
      signal, // Thread the abort signal through
      headers: {
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        'source': 'web',
        'token': token,
        'bx-v': '2.5.36',
        'version': '0.2.63',
        'timezone': new Date().toString().replace(/GMT\+0800/, 'GMT+0800'),
        'x-request-id': crypto.randomUUID(),
        'x-accel-buffering': 'no',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      wrappedOnError(`Request failed with status ${response.status}: ${errorText}`);
      return;
    }

    if (!response.body) {
      wrappedOnError('No streaming body received from Qwen.');
      return;
    }

    // 6. Decode stream chunks in real-time
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          wrappedOnDone();
          return;
        }

        try {
          const chunkPayload = JSON.parse(dataStr);
          const delta = chunkPayload.choices?.[0]?.delta;
          if (delta?.content) {
            onChunk(delta.content);
          }
        } catch {
          // Ignore parsing errors
        }
      }
    }

    wrappedOnDone();
  } catch (e) {
    console.error('[Qwen Service] Exception in streaming execution:', e);
    wrappedOnError(e instanceof Error ? e.message : String(e));
  }
}
