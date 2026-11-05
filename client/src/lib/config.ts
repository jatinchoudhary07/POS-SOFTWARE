/**
 * Where the backend lives. Leave VITE_API_URL empty (the normal case): the browser then talks
 * to whichever computer served the page, e.g. http://192.168.1.20:3001 — so the kitchen
 * computer automatically uses the reception computer, never its own "localhost".
 * Set it only if the frontend is hosted separately, e.g. VITE_API_URL=http://192.168.1.20:3001
 * (then also add the frontend's origin to CORS_ORIGINS in server/.env).
 */
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
