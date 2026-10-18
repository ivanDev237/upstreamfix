const processGroups = new Set<number>();
const temporaryCleanups = new Set<() => Promise<void>>();
let handlersInstalled = false;
let shutdownStarted = false;

export function trackProcessGroup(pid: number): () => void {
  processGroups.add(pid);
  installSignalHandlers();
  return () => {
    processGroups.delete(pid);
    uninstallSignalHandlersIfIdle();
  };
}

export function registerTemporaryCleanup(cleanup: () => Promise<void>): () => void {
  temporaryCleanups.add(cleanup);
  installSignalHandlers();
  return () => {
    temporaryCleanups.delete(cleanup);
    uninstallSignalHandlersIfIdle();
  };
}

export async function terminateProcessGroup(pid: number, graceMs = 100): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
  signalGroup(pid, 'SIGKILL');
  processGroups.delete(pid);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try { process.kill(pid, signal); } catch { /* The process already exited. */ }
    }
  }
}

function installSignalHandlers(): void {
  if (handlersInstalled) return;
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  handlersInstalled = true;
}

function uninstallSignalHandlersIfIdle(): void {
  if (!handlersInstalled || processGroups.size > 0 || temporaryCleanups.size > 0) return;
  process.off('SIGINT', handleSigint);
  process.off('SIGTERM', handleSigterm);
  handlersInstalled = false;
}

function handleSigint(): void {
  void shutdown('SIGINT');
}

function handleSigterm(): void {
  void shutdown('SIGTERM');
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const pids = [...processGroups];
  for (const pid of pids) signalGroup(pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const pid of pids) signalGroup(pid, 'SIGKILL');
  processGroups.clear();
  await Promise.allSettled([...temporaryCleanups].map((cleanup) => cleanup()));
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
