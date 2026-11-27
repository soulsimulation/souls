// #2839 A: the creator check the launcher spawns per signed-in request (creator-auth.mjs), on the launcher's own Clerk
// session check (clerk-session.mjs), importing nothing from apps/server. Same contract as verify-creator.mjs, which it
// replaces: Clerk settings from the env file by path, the bearer token only on stdin, the account id (or null) as JSON
// on stdout. Nothing is logged.
import { verifiedAccount } from './clerk-session.mjs';
let id = null;
try {
  let token = '';
  for await (const chunk of process.stdin) {
    token += chunk.toString('utf8');
    if (token.length > 32768) throw Error('token too large');
  }
  if (!token || /\s/.test(token)) throw Error('invalid token');
  id = await verifiedAccount(token, {
    issuer: process.env.CLERK_ISSUER_URL ?? '', publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
    parties: (process.env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    registryPath: process.env.ACCOUNT_REGISTRY_PATH, publicUrl: process.env.PUBLIC_URL,
  });
} catch { id = null; }
process.stdout.write(JSON.stringify(id));
