// A Node module hook for scripts/*.mts: lets plain Node (type stripping, Node 24+) load the app's TypeScript modules,
// which import each other without a file extension, by trying ".ts" and "/index.ts". No other change to resolution.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !(specifier.startsWith('.') || specifier.startsWith('/'))) throw err;
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await next(specifier + suffix, context);
      } catch {}
    }
    throw err;
  }
}
