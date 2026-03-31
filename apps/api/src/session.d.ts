// Session type augmentation handled via cast in auth routes.
// @fastify/secure-session declares SessionData as empty global interface,
// but TypeScript's global interface merging doesn't reliably work with
// pnpm hoisted node_modules. We use Session.get/set with string overload.
