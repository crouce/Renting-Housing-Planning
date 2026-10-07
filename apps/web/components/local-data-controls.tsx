'use client';
import { useEffect, useRef, useState } from 'react';
import {
  exportLocalBackup,
  parseLocalBackup,
  mergeBackupCollection,
  BACKUP_MAX_BYTES,
  type BackupPlanner,
  type LocalBackup,
} from '@/lib/local-backup';
import type { CommunityCollection } from '@/lib/community-collection';

export type ClearLocalAction = 'queries' | 'collection' | 'all';
export function LocalDataControls({
  collection,
  planner,
  enabled,
  onClear,
  onImport,
}: {
  collection: CommunityCollection;
  planner: BackupPlanner;
  enabled: boolean;
  onClear: (action: ClearLocalAction) => Promise<void>;
  onImport: (backup: LocalBackup, restore: boolean) => void;
}) {
  const [pending, setPending] = useState<ClearLocalAction>();
  const [backup, setBackup] = useState<LocalBackup>();
  const [restore, setRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [download, setDownload] = useState<{ url: string; name: string }>();
  useEffect(
    () => () => {
      if (download) URL.revokeObjectURL(download.url);
    },
    [download],
  );
  const reading = useRef(0);
  const descriptions = {
    queries:
      '仅清理附近站点、通勤结果和小区查询缓存；保留地点、条件、收藏和暂不考虑。当前计算会停止，通勤与小区结果收起，附近站点暂留本页。',
    collection:
      '删除全部收藏和暂不考虑记录，不删除查询缓存与地点。此操作不可撤销，建议先导出备份。',
    all: '清除地点、查询缓存、收藏及暂不考虑。此操作不可撤销，建议先导出备份；当前地点与条件仍保留在页面，后续操作可能重新记忆。',
  };
  const merged = backup
    ? (() => {
        try {
          return mergeBackupCollection(collection, backup.collection);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  return (
    <div className="local-data-controls">
      <strong>本机数据管理</strong>
      <p>
        清理查询缓存可以保留收藏。备份仅含地点、偏好、收藏与排除，不含密钥或路线几何；包含位置，请妥善保管，不上传服务器。
      </p>
      <div className="local-data-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            try {
              const text = exportLocalBackup(planner, collection),
                url = URL.createObjectURL(
                  new Blob([text], { type: 'application/json' }),
                );
              const link = document.createElement('a');
              link.href = url;
              link.download = `commute-backup-${new Date().toISOString().slice(0, 10)}.json`;
              setDownload({ url, name: link.download });
              document.body.appendChild(link);
              link.click();
              link.remove();
              setMessage('已生成本地备份下载；不包含临时查询缓存。');
            } catch (error) {
              setMessage(error instanceof Error ? error.message : '导出失败');
            }
          }}
        >
          导出本地备份
        </button>
        {download && (
          <a href={download.url} download={download.name}>
            下载已生成的备份
          </a>
        )}
        <label className="backup-file-label">
          导入备份（JSON，最多 1 MB）
          <input
            aria-label="导入本地备份"
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              const serial = ++reading.current;
              setBackup(undefined);
              setPending(undefined);
              setRestore(false);
              setMessage('');
              try {
                if (file.size > BACKUP_MAX_BYTES)
                  throw new Error('备份文件超过 1 MB，未读取或导入。');
                const parsed = parseLocalBackup(await file.text());
                if (serial === reading.current) setBackup(parsed);
              } catch (error) {
                if (serial === reading.current)
                  setMessage(
                    error instanceof Error ? error.message : '读取失败',
                  );
              }
            }}
          />
        </label>
        {(['queries', 'collection', 'all'] as const).map((action) => (
          <button
            type="button"
            key={action}
            disabled={busy}
            onClick={() => {
              setPending(action);
              setBackup(undefined);
              reading.current++;
            }}
          >
            {action === 'queries'
              ? '清理查询缓存（保留收藏）'
              : action === 'collection'
                ? '清空收藏与排除'
                : '清除全部本机记录'}
          </button>
        ))}
      </div>
      {pending && (
        <div
          className="local-data-confirm"
          role="region"
          aria-label="确认清理本机数据"
        >
          <p>{descriptions[pending]}</p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onClear(pending);
                setMessage(
                  pending === 'queries'
                    ? '查询缓存已清理，收藏与排除记录保留。'
                    : '所选本机记录已清理。',
                );
                setPending(undefined);
              } catch (error) {
                setMessage(
                  error instanceof Error ? error.message : '清理失败，请重试。',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            确认清理
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setPending(undefined)}
          >
            取消
          </button>
        </div>
      )}
      {backup && (
        <div
          className="local-data-confirm"
          role="region"
          aria-label="备份导入预览"
        >
          <strong>导入前预览</strong>
          <p>
            {backup.collection.favorites.length} 个收藏、
            {backup.collection.ignored.length} 条暂不考虑、
            {backup.planner?.recentPlaces.length ?? 0} 个最近地点。
          </p>
          <p>
            同一公司与小区的已有收藏优先保留，不覆盖；新导入路线统一视为历史记录，须重新核验。
          </p>
          <label>
            <input
              type="checkbox"
              checked={restore}
              disabled={!backup.planner}
              onChange={(event) => setRestore(event.target.checked)}
            />
            同时恢复备份的工作地点与通勤条件（会替换当前设置）
          </label>
          <p>
            {enabled
              ? '将在当前浏览器保存。'
              : '本机记忆关闭，只在本页保留；不会自动开启记忆。'}
          </p>
          {!merged && (
            <p role="alert">合并后超过容量上限，请先整理；未导入任何内容。</p>
          )}
          <button
            type="button"
            disabled={busy || !merged}
            onClick={() => {
              try {
                onImport(backup, restore);
                setBackup(undefined);
                setMessage(
                  '导入完成；同名冲突保留本机记录，导入路线须重新核验。',
                );
              } catch (error) {
                setMessage(error instanceof Error ? error.message : '导入失败');
              }
            }}
          >
            确认合并导入
          </button>
          <button
            type="button"
            onClick={() => {
              setBackup(undefined);
              reading.current++;
            }}
          >
            取消导入
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
