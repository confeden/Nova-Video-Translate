/** Pages where the user creates an API key (the only URLs the "Получить ключ" buttons may open). */
export const GEMINI_KEYS_URL = 'https://aistudio.google.com/api-keys';
export const GROQ_KEYS_URL = 'https://console.groq.com/keys';

export function isKeyPageUrl(url: unknown): url is string {
  return url === GEMINI_KEYS_URL || url === GROQ_KEYS_URL;
}

/** Opens a key page in a new tab: through the host (extension: tabs.create in the background) when it offers it, else an anchor-style window.open. */
export async function openKeyPage(host: { openKeyPage?(url: string): Promise<void> }, url: string): Promise<void> {
  if (!isKeyPageUrl(url)) return;
  try {
    if (host.openKeyPage) {
      await host.openKeyPage(url);
      return;
    }
  } catch {
    /* fall through to window.open */
  }
  window.open(url, '_blank', 'noopener');
}
