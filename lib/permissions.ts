type Resolver = (approved: boolean) => void;
const pending = new Map<string, Resolver>();

export function waitForApproval(id: string, timeoutMs = 120000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, timeoutMs);
    pending.set(id, (approved) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(approved);
    });
  });
}

export function resolveApproval(id: string, approved: boolean): boolean {
  const fn = pending.get(id);
  if (!fn) return false;
  fn(approved);
  return true;
}
