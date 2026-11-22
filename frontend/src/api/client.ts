import axios from 'axios';
import { translateServerError } from '../i18n/serverErrors';

const API_BASE = import.meta.env.VITE_API_URL || '';
// Optional package-only ingress; every path still reaches the same authenticated backend.
const PACKAGE_API_BASE = import.meta.env.VITE_PACKAGE_API_URL || '';
const isPackageRequest = (url = '') => /^\/api\/apkg\/(?:uploads|jobs|limits)(?:\/|$)/.test(url);
let packageRelayUnavailableUntil = 0;

type ValidationIssue = { loc?: unknown; msg?: unknown };
export const validationText = (issues: unknown[]): string =>
  issues
    .map((issue) => {
      const { loc, msg } = (issue ?? {}) as ValidationIssue;
      const text = String(msg ?? '').replace(/^Value error, /, '');
      const field = Array.isArray(loc) ? loc.filter((p) => p !== 'body' && typeof p === 'string').pop() : undefined;
      return field && text ? `${field}: ${text}` : text;
    })
    .filter(Boolean)
    .join('\n') || 'Invalid request';

const client = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

client.interceptors.request.use((config) => {
  if (PACKAGE_API_BASE && isPackageRequest(config.url) && Date.now() >= packageRelayUnavailableUntil) {
    config.baseURL = PACKAGE_API_BASE;
  }
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    const data = error.response?.data;
    // Request validation errors (422) carry a list of {loc, msg}; pages render `detail` as text.
    if (data && Array.isArray(data.detail)) data.detail = validationText(data.detail);
    if (data && typeof data.detail === 'string') data.detail = translateServerError(data.detail);
    // Let the upload's existing offset reconciliation/retry use the original API.
    // Do not replay mutations here: a lost confirmation may already have committed.
    if (PACKAGE_API_BASE && error.config?.baseURL === PACKAGE_API_BASE &&
        isPackageRequest(error.config?.url) && !axios.isCancel(error) &&
        (!error.response || error.response.status >= 500)) {
      packageRelayUnavailableUntil = Date.now() + 60000;
    }
    if (error.response?.status === 401) {
      // Don't redirect on auth endpoints — let the login/register page handle the error
      const url = error.config?.url || '';
      const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/register');
      
      if (!isAuthEndpoint) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default client;
