// Without an explicit metadataBase, Next resolves the og:image/twitter:image
// meta tags against "http://localhost:3000" even in production.
// VERCEL_PROJECT_PRODUCTION_URL is the stable production alias (what people
// actually share); VERCEL_URL is only this specific immutable deployment's
// URL and is the fallback for preview deploys, which have no stable alias.
const siteHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
export const siteUrl = siteHost ? `https://${siteHost}` : 'http://localhost:3000';
