// A message task, unlike a timer, is neither clamped to 4 ms when chained
// nor throttled in a hidden page, and input still runs ahead of it.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
