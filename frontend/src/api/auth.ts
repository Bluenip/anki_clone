import client from './client';

export const loginApi = (email: string, password: string) =>
  client.post('/api/auth/login', { email, password });

export const registerApi = (email: string, username: string, password: string) =>
  client.post('/api/auth/register', { email, username, password });

export const getMeApi = () => client.get('/api/auth/me');

export const forgotPasswordApi = (email: string) =>
  client.post('/api/auth/forgot-password', { email });
