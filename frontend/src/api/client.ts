import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '';
// Optional package-only ingress; every path still reaches the same authenticated backend.
const PACKAGE_API_BASE = import.meta.env.VITE_PACKAGE_API_URL || '';
const isPackageRequest = (url = '') => /^\/api\/apkg\/(?:uploads|jobs|limits)(?:\/|$)/.test(url);
let packageRelayUnavailableUntil = 0;

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
