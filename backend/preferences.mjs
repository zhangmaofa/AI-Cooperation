import { z } from "zod";

export const preferenceSchema = z
  .object({
    mode: z.enum(["system", "light", "dark"]),
    accent: z.enum(["green", "blue", "purple", "orange"]),
    fontScale: z.union([
      z.literal(1),
      z.literal(1.15),
      z.literal(1.3),
      z.literal(1.5),
    ]),
    notifications: z.boolean(),
  })
  .strict();
export const defaultPreferences = Object.freeze({
  mode: "system",
  accent: "green",
  fontScale: 1.15,
  notifications: true,
});
export function preferences(store) {
  const saved = preferenceSchema.safeParse(
    store.setting("preferences", defaultPreferences),
  );
  return saved.success ? saved.data : { ...defaultPreferences };
}
