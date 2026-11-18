export type ReindexItem<T> = { id: string; content: T };

/** Fetch one missing item, make one provider call, and persist it before continuing. */
export async function indexIncrementally<T, R>(options: {
  next: () => Promise<ReindexItem<T> | null>;
  embed: (item: ReindexItem<T>) => Promise<R>;
  persist: (item: ReindexItem<T>, result: R) => Promise<void>;
  onSaved?: (saved: number) => void;
}) {
  let saved = 0;
  let requests = 0;
  while (true) {
    const item = await options.next();
    if (!item) break;
    const result = await options.embed(item);
    requests++;
    await options.persist(item, result);
    saved++;
    options.onSaved?.(saved);
  }
  return { saved, requests };
}
