/**
 * localStorage 存储 shim，模拟 window.electron.storage：
 * - kv 存取（含 Pinia 持久化键 pinia:xxx）
 * - 播放队列快照 + 队列级操作
 * 体积上限受 localStorage（约 5MB SQLite 之前的桌面空间远大于此），选曲多时注意。
 * ponytail: localStorage 单快照模型，队列数/歌曲数超限时需迁移 IndexedDB。
 */
import type {
  StorageAppendQueueItemsPayload,
  StorageHistoryEntry,
  StorageHistoryGetEntriesPayload,
  StorageHistoryRecordPlayPayload,
  StorageHistoryRemoveEntriesPayload,
  StoragePlaybackQueueState,
  StoragePlaybackSnapshot,
  StorageQueueIdPayload,
  StorageRemoveQueueItemPayload,
  StorageReorderQueueItemsPayload,
  StorageReplaceQueuePayload,
  StorageSetQueueCurrentTrackPayload,
  StorageUpdateQueueMetaPayload,
} from '../../shared/storage';

const SNAPSHOT_KEY = 'echomusic:player:snapshot';
const HISTORY_KEY = 'echomusic:player:history';
const KV_PREFIX = 'echomusic:kv:';

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown): void => {
  window.localStorage.setItem(key, JSON.stringify(value));
};

const readSnapshot = (): StoragePlaybackSnapshot =>
  readJson<StoragePlaybackSnapshot>(SNAPSHOT_KEY, {
    queues: [],
    activeQueueId: '',
    lastNonFmQueueId: '',
  });

const writeSnapshot = (snapshot: StoragePlaybackSnapshot): void =>
  writeJson(SNAPSHOT_KEY, snapshot);

const patchedSnapshot = (patch: (snapshot: StoragePlaybackSnapshot) => void): void => {
  const snapshot = readSnapshot();
  patch(snapshot);
  writeSnapshot(snapshot);
};

const upsertQueue = (snapshot: StoragePlaybackSnapshot, queue: StoragePlaybackQueueState): void => {
  const index = snapshot.queues.findIndex((item) => item.id === queue.id);
  if (index === -1) snapshot.queues.unshift(queue);
  else snapshot.queues.splice(index, 1, queue);
};

export const webStorage = {
  // ── kv ──
  async getKv<T>(key: string): Promise<T | null> {
    return readJson<T | null>(`${KV_PREFIX}${key}`, null);
  },
  async setKv(key: string, value: unknown): Promise<void> {
    writeJson(`${KV_PREFIX}${key}`, value);
  },
  async deleteKv(key: string): Promise<void> {
    window.localStorage.removeItem(`${KV_PREFIX}${key}`);
  },

  // ── 播放队列 ──
  async getPlaybackSnapshot(): Promise<StoragePlaybackSnapshot> {
    return readSnapshot();
  },
  async getPlaybackQueue(payload: StorageQueueIdPayload): Promise<StoragePlaybackQueueState | null> {
    const { queues } = readSnapshot();
    return queues.find((queue) => queue.id === payload.queueId) ?? null;
  },
  async replacePlaybackQueue(payload: StorageReplaceQueuePayload): Promise<void> {
    patchedSnapshot((snapshot) => {
      upsertQueue(snapshot, payload.queue);
      snapshot.activeQueueId = payload.activeQueueId;
      snapshot.lastNonFmQueueId = payload.lastNonFmQueueId;
    });
  },
  async appendPlaybackQueueItems(payload: StorageAppendQueueItemsPayload): Promise<void> {
    patchedSnapshot((snapshot) => {
      let queue = snapshot.queues.find((item) => item.id === payload.queue.id);
      if (!queue) {
        queue = {
          ...payload.queue,
          songs: [],
        } as StoragePlaybackQueueState;
        snapshot.queues.unshift(queue);
      }
      queue.songs = [...(queue.songs ?? []), ...payload.songs];
      queue.updatedAt = Date.now();
      snapshot.activeQueueId = payload.activeQueueId;
      snapshot.lastNonFmQueueId = payload.lastNonFmQueueId;
    });
  },
  async updatePlaybackQueueMeta(payload: StorageUpdateQueueMetaPayload): Promise<void> {
    patchedSnapshot((snapshot) => {
      const queue = snapshot.queues.find((item) => item.id === payload.queue.id);
      if (queue) {
        const { songs: _songs, ...meta } = payload.queue as StoragePlaybackQueueState;
        Object.assign(queue, meta, { updatedAt: Date.now() });
      }
      snapshot.activeQueueId = payload.activeQueueId;
      snapshot.lastNonFmQueueId = payload.lastNonFmQueueId;
    });
  },
  async clearPlaybackQueue(payload: StorageUpdateQueueMetaPayload): Promise<void> {
    patchedSnapshot((snapshot) => {
      const queue = snapshot.queues.find((item) => item.id === payload.queue.id);
      if (queue) {
        queue.songs = [];
        queue.updatedAt = Date.now();
      }
      snapshot.activeQueueId = payload.activeQueueId;
      snapshot.lastNonFmQueueId = payload.lastNonFmQueueId;
    });
  },
  async removePlaybackQueue(payload: StorageQueueIdPayload): Promise<{ ok: true }> {
    patchedSnapshot((snapshot) => {
      snapshot.queues = snapshot.queues.filter((queue) => queue.id !== payload.queueId);
      if (snapshot.activeQueueId === payload.queueId) snapshot.activeQueueId = '';
    });
    // 注意：按桌面端约定，删除不返回快照，避免回灌过期状态
    return { ok: true };
  },
  async removePlaybackQueueItem(payload: StorageRemoveQueueItemPayload): Promise<void> {
    patchedSnapshot((snapshot) => {
      const queue = snapshot.queues.find((item) => item.id === payload.queueId);
      if (!queue) return;
      const songId = String(payload.songId);
      queue.songs = queue.songs.filter((song) => String(song.id ?? song.songId) !== songId);
      queue.queuedNextTrackIds = (payload.queuedNextTrackIds ?? queue.queuedNextTrackIds).filter(
        (id) => id !== songId,
      );
      if (queue.currentTrackId === songId) queue.currentTrackId = null;
      queue.updatedAt = payload.updatedAt ?? Date.now();
    });
  },
  async reorderPlaybackQueueItems(payload: StorageReorderQueueItemsPayload): Promise<void> {
    patchedSnapshot((snapshot) => {
      const queue = snapshot.queues.find((item) => item.id === payload.queueId);
      if (!queue) return;
      queue.songs = payload.songs;
      queue.updatedAt = payload.updatedAt ?? Date.now();
    });
  },
  async setQueueCurrentTrack(payload: StorageSetQueueCurrentTrackPayload): Promise<void> {
    patchedSnapshot((snapshot) => {
      const queue = snapshot.queues.find((item) => item.id === payload.queueId);
      if (!queue) return;
      queue.currentTrackId =
        payload.trackId === null || payload.trackId === undefined ? null : String(payload.trackId);
      queue.updatedAt = Date.now();
    });
  },

  // ── 播放历史 ──
  async getHistoryEntries(payload?: StorageHistoryGetEntriesPayload): Promise<StorageHistoryEntry[]> {
    const saved = readJson<StorageHistoryEntry[]>(HISTORY_KEY, []);
    const offset = payload?.offset ?? 0;
    const limit = payload?.limit ?? saved.length;
    return saved.slice(offset, offset + limit);
  },
  async recordHistoryPlay(
    payload: StorageHistoryRecordPlayPayload,
  ): Promise<StorageHistoryEntry | null> {
    const saved = readJson<StorageHistoryEntry[]>(HISTORY_KEY, []);
    const targetId = String(payload.song.mixSongId || payload.song.fileId || payload.song.id || '0');
    const playedAt = payload.playedAt ?? Date.now();
    const existing = saved.find(
      (entry) => String(entry.song.mixSongId || entry.song.fileId || entry.song.id) === targetId,
    );
    const entry: StorageHistoryEntry = {
      song: payload.song as StorageHistoryEntry['song'],
      lastPlayedAt: playedAt,
      playCount: (existing?.playCount ?? 0) + 1,
      historyKey: `${targetId}:${playedAt}`,
    };
    const filtered = saved.filter(
      (item) => String(item.song.mixSongId || item.song.fileId || item.song.id) !== targetId,
    );
    const updated = [entry, ...filtered].slice(
      0,
      Math.max(1, payload.maxEntries ?? 500),
    );
    writeJson(HISTORY_KEY, updated);
    return entry;
  },
  async removeHistoryEntries(payload: StorageHistoryRemoveEntriesPayload): Promise<void> {
    const keySet = new Set(payload.historyKeys);
    writeJson(
      HISTORY_KEY,
      readJson<StorageHistoryEntry[]>(HISTORY_KEY, []).filter(
        (entry) => !keySet.has(entry.historyKey),
      ),
    );
  },
  async clearHistory(): Promise<void> {
    window.localStorage.removeItem(HISTORY_KEY);
  },
};