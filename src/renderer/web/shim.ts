/**
 * 纯 Web 模式下的 window.electron shim。
 * 必须在 main.ts 第一个副作用 import（utils/player.ts 会在模块加载时读取 player/mediaControls）。
 */
import {
  DEFAULT_LOG_SETTINGS,
  normalizeLogSettings,
  type LogSettings,
} from '../../shared/logging';
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  type NetworkSettingsState,
  type NetworkSettingsUpdateRequest,
} from '../../shared/network';
import {
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_VERSION,
  type SettingsBackupExportRequest,
  type SettingsBackupExportResult,
  type SettingsBackupInspectResult,
  type SettingsBackupImportResult,
  type SettingsBackupSummary,
} from '../../shared/settingsBackup';
import type { ApiServerStatus } from '../../shared/api-server';
import type { ResolvePlaylistRequest, ResolvePlaylistResponse } from '../../shared/external';
import type { CloudUploadFile, CloudReadUploadFileDataResult } from '../../shared/cloud';
import { WebAudioPlayer } from './audioPlayer';
import { webStorage } from './storage';
import {
  getServerBase,
  hasServerBase,
  setServerBase,
} from './serverConfig';

export { getServerBase, hasServerBase, setServerBase };

// ── 设备身份：guid / mid / serverDev / mac，与服务端算法一致且按浏览器持久化 ──

const IDENTITY_KEY = 'echomusic:player:identity';
const randomHexSegment = () =>
  ((65536 * (1 + Math.random())) | 0).toString(16).substring(1);

const md5 = (input: string): string => {
  const rotateLeft = (value: number, shift: number) =>
    (value << shift) | (value >>> (32 - shift));
  const addUnsigned = (x: number, y: number) => {
    const lsw = (x & 0xffff) + (y & 0xffff);
    return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xffff);
  };
  const toHex = (value: number) => {
    let hex = '';
    for (let i = 0; i < 4; i += 1) {
      hex += '0123456789abcdef'.charAt((value >>> (i * 8 + 4)) & 0x0f);
      hex += '0123456789abcdef'.charAt((value >>> (i * 8)) & 0x0f);
    }
    return hex;
  };

  const words: number[] = [];
  const message = unescape(encodeURIComponent(input));
  for (let i = 0; i < message.length; i += 1) {
    words[i >> 2] |= message.charCodeAt(i) << ((i % 4) * 8);
  }
  words[message.length >> 2] |= 0x80 << ((message.length % 4) * 8);
  words[(((message.length + 8) >> 6) << 4) + 14] = message.length * 8;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  const k: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    s[i] = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21][i];
  }

  for (let offset = 0; offset < words.length; offset += 16) {
    const w = words.slice(offset, offset + 16);
    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      b = addUnsigned(b, rotateLeft(addUnsigned(a, addUnsigned(f, addUnsigned(k[i], w[g]))), s[i]));
      a = temp;
    }
    a = addUnsigned(a, aa);
    b = addUnsigned(b, bb);
    c = addUnsigned(c, cc);
    d = addUnsigned(d, dd);
  }
  return toHex(a) + toHex(b) + toHex(c) + toHex(d);
};

const toCloudUploadFile = (file: File): CloudUploadFile => {
  const lastDot = file.name.lastIndexOf('.');
  const extension = lastDot >= 0 ? file.name.slice(lastDot).toLowerCase() : '';
  return {
    name: file.name,
    path: `cloud:${file.name}:${file.lastModified}:${file.size}`,
    size: file.size,
    extension,
    modifiedAt: file.lastModified,
  };
};

const parseBackupManifest = (
  raw: string,
): { ok: true; summary: SettingsBackupSummary; settingsData: Record<string, unknown> | undefined } | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(raw) as {
      format?: string;
      version?: number;
      summary?: SettingsBackupSummary;
      settingsData?: Record<string, unknown>;
    };
    if (parsed.format !== SETTINGS_BACKUP_FORMAT || parsed.version !== SETTINGS_BACKUP_VERSION) {
      return { ok: false, error: '不是有效的 EchoMusic 备份文件' };
    }
    if (!parsed.summary) return { ok: false, error: '备份文件缺少摘要信息' };
    return { ok: true, summary: parsed.summary, settingsData: parsed.settingsData };
  } catch {
    return { ok: false, error: '备份文件解析失败' };
  }
};

const buildShim = () => {
  const player = new WebAudioPlayer();
  const uploadedFiles = new Map<string, File>();
  let identity = (() => {
    try {
      const cached = window.localStorage.getItem(IDENTITY_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as {
          guid?: string;
          mid?: string;
          serverDev?: string;
          mac?: string;
        };
        if (parsed.guid && parsed.mid) return parsed as Record<string, string>;
      }
    } catch {
      // ignore
    }
    const rawGuid = `${randomHexSegment()}${randomHexSegment()}-${randomHexSegment()}-${randomHexSegment()}-${randomHexSegment()}-${randomHexSegment()}${randomHexSegment()}${randomHexSegment()}`;
    const guid = md5(rawGuid);
    const mid = BigInt(`0x${guid}`).toString(10);
    const value = {
      guid,
      mid,
      serverDev: Array.from({ length: 10 }, () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(Math.floor(Math.random() * 36)),
      ).join(''),
      mac: '02:00:00:00:00:00',
    };
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(value));
    return value;
  })();

  // localStorage 读写（供 logging/network 等在无主进程时也具备"设置持久化"的意识，
  // 实际设置持久化走 webStorage 的 pinia 键，此处仅作增量存储）。
  const kvRead = <T>(key: string, fallback: T): T => {
    try {
      const raw = window.localStorage.getItem(`echomusic:kv:${key}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    api: {
      request: async (config: {
        method: string;
        url: string;
        params?: Record<string, any>;
        data?: any;
        headers?: Record<string, string>;
      }): Promise<{ status: number; body: any; cookie?: string[]; headers?: Record<string, string> }> => {
        if (!hasServerBase()) {
          throw new Error('尚未配置服务端地址，请先在启动弹窗中填写');
        }
        const base = getServerBase();
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(config.params ?? {})) {
          if (value !== undefined && value !== null) query.append(key, String(value));
        }
        const queryString = query.toString();
        const url = `${base}${config.url}${queryString ? `?${queryString}` : ''}`;
        const headers: Record<string, string> = {
          Accept: 'application/json',
          ...(config.headers ?? {}),
        };
        const init: RequestInit = { method: config.method, headers, credentials: 'include' };
        if (config.data !== undefined && config.data !== null) {
          if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
            init.body = config.data;
          } else {
            headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
            init.body = JSON.stringify(config.data);
          }
        }
        const response = await fetch(url, init);
        const text = await response.text();
        let body: any = text;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        return {
          status: response.status,
          body,
          cookie: [],
          headers: Object.fromEntries((response.headers as any).entries()),
        };
      },
    },
    apiServer: {
      status: async (): Promise<ApiServerStatus> => ({
        state: 'ready',
        updatedAt: Date.now(),
      }),
      start: async (): Promise<{ success: boolean }> => ({ success: true }),
      identity: async () => identity,
    },
    ipcRenderer: {
      on: (_channel: string, _listener: unknown) => undefined as unknown,
      off: (_channel: string, _listener: unknown) => undefined as unknown,
      send: (channel: string, ...args: unknown[]) => {
        if (channel === 'open-external' && typeof args[0] === 'string') {
          window.open(args[0], '_blank', 'noopener,noreferrer');
        }
      },
      invoke: async (_channel: string, ..._args: unknown[]) => undefined,
    },
    appInfo: {
      get: async () => ({
        version: '2.3.1-beta.24-web',
        isPrerelease: true,
        isPackaged: false,
      }),
      getChangelog: async () => '浏览器版本。\n\n使用说明：\n- 首次访问请在下拉框填写独立部署的 API 服务地址。',
      relaunch: async () => {
        window.location.reload();
        return true;
      },
      onOpenSettings: () => () => undefined,
    },
    external: {
      resolvePlaylist: async (
        _req: ResolvePlaylistRequest,
      ): Promise<ResolvePlaylistResponse> => ({
        ok: false,
        error: '浏览器版本暂不支持外部歌单导入',
      }),
    },
    fonts: {
      getAll: async (): Promise<string[]> => {
        const anyWindow = window as any;
        if (typeof anyWindow.queryLocalFonts === 'function') {
          try {
            const entries = await anyWindow.queryLocalFonts();
            return entries
              .map((entry: { family: string }) => entry.family)
              .filter((item: string, index: number, all: string[]) => all.indexOf(item) === index);
          } catch {
            // fall through
          }
        }
        return ['sans-serif', 'serif', 'monospace'];
      },
    },
    logging: {
      get: async (): Promise<LogSettings> => kvRead('logging:settings', DEFAULT_LOG_SETTINGS),
      update: async (settings: Partial<LogSettings>): Promise<LogSettings> => {
        const normalized = normalizeLogSettings(settings);
        window.localStorage.setItem('echomusic:kv:logging:settings', JSON.stringify(normalized));
        return normalized;
      },
    },
    network: {
      get: async (): Promise<NetworkSettingsState> => ({
        settings: kvRead('network:settings', DEFAULT_NETWORK_SETTINGS),
        hasProxyPassword: false,
      }),
      update: async (request: NetworkSettingsUpdateRequest): Promise<NetworkSettingsState> => {
        const settings = normalizeNetworkSettings({
          ...kvRead('network:settings', DEFAULT_NETWORK_SETTINGS),
          ...request.settings,
        });
        window.localStorage.setItem('echomusic:kv:network:settings', JSON.stringify(settings));
        return { settings, hasProxyPassword: false };
      },
    },
    settingsBackup: {
      export: async (request: SettingsBackupExportRequest): Promise<SettingsBackupExportResult> => {
        const summary: SettingsBackupSummary = {
          createdAt: new Date().toISOString(),
          appVersion: '2.3.1-beta.24-web',
          includes: { settings: request.settings, plugins: request.plugins },
          settingCount: request.settingsData ? Object.keys(request.settingsData).length : 0,
          pluginCount: 0,
          pluginNames: [],
        };
        const manifest = {
          format: SETTINGS_BACKUP_FORMAT,
          version: SETTINGS_BACKUP_VERSION,
          summary,
          settingsData: request.settings ? (request.settingsData ?? {}) : undefined,
        };
        const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `echomusic-backup-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return {
          ok: true,
          canceled: false,
          filePath: anchor.download,
          summary,
        };
      },
      inspect: async (): Promise<SettingsBackupInspectResult> => {
        const pickFile = () =>
          new Promise<{ canceled: boolean; raw: string }>((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return resolve({ canceled: true, raw: '' });
              resolve({ canceled: false, raw: await file.text() });
            };
            input.addEventListener('cancel', () => resolve({ canceled: true, raw: '' }));
            input.click();
          });
        const picked = await pickFile();
        if (picked.canceled) return { ok: false, canceled: true };
        const parsed = parseBackupManifest(picked.raw);
        if (!parsed.ok) return { ok: false, canceled: false, error: parsed.error };
        return { ok: true, canceled: false, token: picked.raw, summary: parsed.summary };
      },
      import: async (request: {
        token: string;
        settings: boolean;
        plugins: boolean;
      }): Promise<SettingsBackupImportResult> => {
        const parsed = parseBackupManifest(request.token);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        let settingsImported = false;
        if (request.settings && parsed.settingsData) {
          webStorage.setKv('pinia:setting', parsed.settingsData);
          settingsImported = true;
        }
        return {
          ok: true,
          settingsImported,
          pluginsImported: 0,
          summary: parsed.summary,
        };
      },
    },
    share: {
      copy: async (text: string): Promise<boolean> => {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      },
      readClipboard: async (): Promise<string> => {
        try {
          return await navigator.clipboard.readText();
        } catch {
          return '';
        }
      },
      captureRectToClipboard: async (): Promise<boolean> => false,
      onOpen: () => () => undefined,
    },
    cloud: {
      pickUploadFiles: async (mode: 'file' | 'folder', multi = true) =>
        new Promise<{ canceled: boolean; files: CloudUploadFile[]; errors?: string[] }>(
          (resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            if (mode === 'folder') {
              (input as any).webkitdirectory = true;
            } else {
              input.accept = 'audio/*,.mp3,.flac,.m4a,.aac,.ogg,.wma,.ape,.opus,.amr';
              input.multiple = multi;
            }
            input.onchange = () => {
              const files = Array.from(input.files ?? []);
              files.forEach((file) => {
                uploadedFiles.set(toCloudUploadFile(file).path, file);
              });
              resolve({ canceled: false, files: files.map(toCloudUploadFile) });
            };
            input.addEventListener('cancel', () => resolve({ canceled: true, files: [] }));
            input.click();
          },
        ),
      readUploadFileData: async (filePath: string): Promise<CloudReadUploadFileDataResult> => {
        const file = uploadedFiles.get(filePath);
        if (!file) return { ok: false, error: '文件已失效，请重新选择' };
        return { ok: true, path: filePath, size: file.size, data: await file.arrayBuffer() };
      },
      clearUploadFiles: async () => {
        uploadedFiles.clear();
        return { ok: true };
      },
    },
    recognize: {
      enableLoopback: async (): Promise<void> => {
        if (player && player.captureStreamForLoopback()) return;
        await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => undefined);
      },
      disableLoopback: async (): Promise<void> => {},
    },
    audioEffects: {
      importImpulseResponse: async () => ({ ok: false, canceled: true }),
      downloadCommunityAudioEffect: async () => ({ ok: false, canceled: false, error: '浏览器版本不支持' }),
      deleteAudioEffect: async () => false,
      reconcileAudioEffects: async (files: unknown[]) => files,
    },
    shortcuts: {
      register: async () => ({ ok: false, error: '浏览器版本不支持全局快捷键' }),
      refresh: async (): Promise<{ ok: boolean; invalidCount?: number }> => ({ ok: true, invalidCount: 0 }),
      setLocalEditableActive: async () => undefined,
      registerPluginGlobal: async () => false,
      unregisterPluginGlobal: async () => false,
      onTrigger: () => () => undefined,
      onPluginGlobalTrigger: () => () => undefined,
    },
    tray: {
      syncPlayback: () => undefined,
      onSetPlayMode: () => () => undefined,
    },
    power: {
      onResume: () => () => undefined,
    },
    log: {
      info: (...args: unknown[]) => console.info('[EchoMusic]', ...args),
      warn: (...args: unknown[]) => console.warn('[EchoMusic]', ...args),
      error: (...args: unknown[]) => console.error('[EchoMusic]', ...args),
      debug: (...args: unknown[]) => console.debug('[EchoMusic]', ...args),
      verbose: (...args: unknown[]) => console.debug('[EchoMusic]', ...args),
    },
    mediaControls: {
      updateMetadata: async (payload: {
        title: string;
        artist: string;
        album: string;
        coverUrl?: string;
        durationMs?: number;
      }) => {
        if (!('mediaSession' in navigator)) return;
        (navigator as any).mediaSession.metadata = new MediaMetadata({
          title: payload.title,
          artist: payload.artist,
          album: payload.album,
          artwork: payload.coverUrl
            ? [{ src: payload.coverUrl, sizes: '512x512', type: 'image/jpeg' }]
            : [],
        });
      },
      updateState: async (payload: { status: string }) => {
        if (!('mediaSession' in navigator)) return;
        (navigator as any).mediaSession.playbackState =
          payload.status === 'Playing' ? 'playing' : 'paused';
      },
      updateTimeline: async (payload: { currentTimeMs: number; totalTimeMs: number }) => {
        if (!('mediaSession' in navigator) || !('setPositionState' in (navigator as any).mediaSession)) return;
        try {
          (navigator as any).mediaSession.setPositionState({
            duration: (payload.totalTimeMs || 0) / 1000,
            position: (payload.currentTimeMs || 0) / 1000,
            playbackRate: 1,
          });
        } catch {
          // 忽略非法 duration
        }
      },
      updateSkipIntervals: async (_payload: { forwardMs: number; backwardMs: number }) => undefined,
      available: async () => 'mediaSession' in navigator,
      onEvent: (
        func: (event: { type: string; positionMs?: number; offsetMs?: number }) => void,
      ) => {
        const session = (navigator as any).mediaSession as
          | { setActionHandler?: (action: string, handler: () => void) => void }
          | undefined;
        if (!session?.setActionHandler) return () => undefined;
        const handlers: Record<string, (details?: any) => void> = {
          play: () => func({ type: 'Play' }),
          pause: () => func({ type: 'Pause' }),
          previoustrack: () => func({ type: 'PreviousTrack' }),
          nexttrack: () => func({ type: 'NextTrack' }),
          seekto: (details: any) =>
            func({ type: 'SeekTo', positionMs: (details?.seekTime ?? 0) * 1000 }),
          seekbackward: () => func({ type: 'SeekBackward', offsetMs: 10000 }),
          seekforward: () => func({ type: 'SeekForward', offsetMs: 10000 }),
        };
        Object.entries(handlers).forEach(([action, handler]) =>
          session.setActionHandler?.(action, handler as () => void),
        );
        return () => {
          Object.keys(handlers).forEach((action) => session.setActionHandler?.(action, null as any));
        };
      },
    },
    player,
    storage: webStorage,
    platform: 'browser',
    isWayland: false,
    windowControl: () => undefined,
  };
};

/**
 * 是否为纯 Web 模式（shim 真实接管了 window.electron）。
 * 桌面环境下 window.electron 由 preload 提供，此处为 false。
 */
export const isWebApp: boolean = typeof window !== 'undefined' && !(window as any).electron;

if (typeof window !== 'undefined') {
  if (!(window as any).electron) {
    (window as any).electron = buildShim();
  }
}

/**
 * 开发模式自检：MD5 / 身份 / URL 校验 / 快照 round-trip。
 * 任一步失败即抛错，防止拿到损坏的 shim 进入联调。
 */
export const runWebShimSelfCheck = async (): Promise<void> => {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`web shim self-check failed: ${msg}`);
  };
  assert(md5('') === 'd41d8cd98f00b204e9800998ecf8427e', 'md5 empty');
  assert(md5('abc') === '900150983cd24fb0d6963f7d28e17f72', 'md5 abc');
  assert(md5('Kugou本质上用来记录设备的guid') === md5('Kugou本质上用来记录设备的guid'), 'md5 deterministic');

  const tmpBase = getServerBase();
  setServerBase('https://api.example.com/');
  assert(getServerBase() === 'https://api.example.com', 'serverConfig normalize trailing slash');
  setServerBase(tmpBase);

  const sample = { theme: 'dark', defaultAudioQuality: 'lossless' };
  await webStorage.setKv('pinia:setting', sample);
  const restored = await webStorage.getKv<typeof sample>('pinia:setting');
  assert(restored?.theme === 'dark', 'kv round-trip');
  await webStorage.deleteKv('pinia:setting');
  assert((await webStorage.getKv('pinia:setting')) === null, 'kv delete');

  assert(typeof buildShim().api.request === 'function', 'api.request present');
  assert(
    typeof buildShim().external.resolvePlaylist === 'function',
    'external present',
  );
};