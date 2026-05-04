import { z } from "zod";

/**
 * Broker-neutral vocabulary for local service capability policy.
 * Concrete enforcement belongs to adapters such as the broker and
 * sandbox; the domain owns only the shape extensions can declare.
 */
export const LocalServiceAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("basic"),
    username_env: z.string().min(1),
    password_env: z.string().min(1),
  }),
  z.object({
    type: z.literal("bearer"),
    token_env: z.string().min(1),
  }),
]);
export type LocalServiceAuthConfig = z.infer<typeof LocalServiceAuthSchema>;

export const LocalServiceConfigSchema = z.object({
  target: z.string().regex(/^[^:\s]+:\d+$/, "expected host:port"),
  auth: LocalServiceAuthSchema.optional(),
});
export type LocalServiceConfig = z.infer<typeof LocalServiceConfigSchema>;

export const LocalServicesConfigSchema = z.record(
  z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "service name must be a single dotless label"),
  LocalServiceConfigSchema,
);
export type LocalServicesConfig = z.infer<typeof LocalServicesConfigSchema>;
