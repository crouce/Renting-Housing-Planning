export type CalculationProgress = {
  phase: 'walking' | 'lines' | 'routes';
  label: string;
  completedDirections: number;
  totalDirections: number;
  requests: { walking: number; lines: number; transit: number };
  reused: { walking: number; lines: number; transit: number };
};
export type CalculationEvent<T> =
  | { type: 'progress'; progress: CalculationProgress }
  | { type: 'snapshot'; result: T }
  | { type: 'result'; result: T }
  | { type: 'error'; message: string };

/** Network chunks need not align with JSON lines or UTF-8 characters. */
export async function readCalculationStream<T>(
  response: Response,
  onEvent: (event: CalculationEvent<T>) => void,
  signal: AbortSignal,
) {
  if (!response.ok || !response.body)
    throw new Error('通勤计算连接失败，请稍后补查。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let complete = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as CalculationEvent<T>;
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'result') complete = true;
    onEvent(event);
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!complete)
      throw new Error('计算连接已中断，已完成结果保留，可继续补查。');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
