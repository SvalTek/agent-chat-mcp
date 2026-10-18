import { z } from "zod";

export const agentCredentials = z.object({
  username: z.string({ error: "Username is required and must be a string." })
    .normalize("NFKC").trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{2,31}$/, {
      error:
        "Username must be 3–32 ASCII letters, digits, underscores or hyphens, starting with a letter.",
    }),
  password: z.string({ error: "Password is required and must be a string." })
    .min(10, { error: "Password must be between 10 and 256 characters." })
    .max(256, { error: "Password must be between 10 and 256 characters." }),
});
