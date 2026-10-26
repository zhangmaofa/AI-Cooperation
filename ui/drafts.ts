import { useEffect, useState } from "react";
const prefix = "ai-cooperation:draft:v1:";
export function useDraftState<T>(
  key: string,
  initial: T,
  valid?: (value: unknown) => boolean,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(prefix + key);
      if (!raw) return initial;
      const saved = JSON.parse(raw);
      if (
        valid
          ? valid(saved)
          : initial === null
            ? saved === null
            : typeof saved === typeof initial
      )
        return saved;
    } catch {}
    return initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(prefix + key, JSON.stringify(value));
    } catch {
      window.dispatchEvent(new Event("cooperation:draft-error"));
    }
  }, [key, value]);
  return [value, setValue] as const;
}
export function clearDraft(keyPrefix: string) {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(prefix + keyPrefix)) localStorage.removeItem(key);
  } catch {}
}
