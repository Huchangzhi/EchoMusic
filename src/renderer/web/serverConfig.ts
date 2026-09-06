/**
 * 服务端地址配置（纯 Web 版）：首次访问时让用户填写独立部署的 API 服务地址。
 */

import { ref } from 'vue';

const SERVER_CONFIG_KEY = 'echomusic:server-base';

const normalizeBase = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, '')
    .replace(/\/+$/, '');

export const getServerBase = (): string =>
  normalizeBase(window.localStorage.getItem(SERVER_CONFIG_KEY) ?? '');

export const setServerBase = (value: string): void => {
  window.localStorage.setItem(SERVER_CONFIG_KEY, normalizeBase(value));
};

export const hasServerBase = (): boolean => {
  const base = getServerBase();
  return /^https?:\/\//i.test(base) && base.length >= 10;
};

/**
 * 服务端设置弹窗开关：由 ServerSetup 组件与设置页“重新设置”按钮共用。
 */
export const serverSetupOpen = ref(false);

export const openServerSetup = (): void => {
  serverSetupOpen.value = true;
};